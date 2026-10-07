// All-or-nothing commit of a plan: re-check that nothing changed on disk since planning, write
// each file through a same-directory temp file + rename, and undo everything on any failure.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type FileChange = {
  /** Path the model named; writes go through symlinks to the real file. */
  abs: string;
  /** Raw disk content at planning time, or null if absent. */
  before: string | null;
  /** Raw content to leave on disk, or null to delete. */
  after: string | null;
  /** Set by commit from the existing file, so the rewrite keeps its mode. */
  mode?: number;
};

type Done = { target: string; before: string | null; after: string | null; backup?: string };

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs commits one at a time within this process. A re-check and the renames after it are many
 * awaits apart, so two parallel edit calls could both pass the check and the later rename would
 * drop the earlier change. Held only for the milliseconds of a commit, never during planning.
 */
export function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

/** A file changed on disk after planning; the caller may re-plan against the new content. */
export class ConflictError extends Error {
  paths: string[];
  constructor(paths: string[]) {
    super(`${paths.join(", ")} changed on disk while the edit was being planned; nothing was written`);
    this.paths = paths;
  }
}

async function target(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const tmpName = (path: string) => join(dirname(path), `.${basename(path)}.multiedit-${randomBytes(4).toString("hex")}`);

async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  const tmp = tmpName(path);
  await writeFile(tmp, content, { encoding: "utf8", mode: mode ?? 0o644 });
  try {
    // writeFile's mode is filtered by the umask; set it exactly.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Applies `changes` atomically as a set. Throws (after restoring every file it touched) if any
 * file changed since planning or any write fails.
 */
export async function commit(changes: FileChange[]): Promise<void> {
  const resolved = await Promise.all(changes.map(async (c) => ({ ...c, target: await target(c.abs) })));
  const conflicts = [];
  for (const c of resolved) if ((await readOrNull(c.target)) !== c.before) conflicts.push(c.abs);
  if (conflicts.length) throw new ConflictError(conflicts);
  for (const c of resolved) {
    if (c.before !== null) {
      await access(c.target, constants.W_OK);
      c.mode = (await stat(c.target)).mode & 0o7777;
    }
  }
  const done: Done[] = [];
  try {
    for (const c of resolved) {
      // Checked again right before each file's own write, to keep the window to another writer small.
      if ((await readOrNull(c.target)) !== c.before) throw new ConflictError([c.abs]);
      if (c.after === null) {
        const backup = tmpName(c.target);
        await rename(c.target, backup);
        done.push({ target: c.target, before: c.before, after: null, backup });
        continue;
      }
      if (c.before === null) await mkdir(dirname(c.target), { recursive: true });
      await writeAtomic(c.target, c.after, c.mode);
      done.push({ target: c.target, before: c.before, after: c.after });
    }
  } catch (e) {
    const failed = await rollback(done);
    if (e instanceof ConflictError && failed.length === 0) throw e;
    const note = failed.length ? ` Not restored (changed meanwhile, or a write error): ${failed.join(", ")} — inspect them.` : " All files were restored.";
    throw new Error(`write failed: ${(e as Error).message}.${note}`);
  }
  await Promise.all(done.filter((d) => d.backup).map((d) => unlink(d.backup!).catch(() => {})));
}

async function rollback(done: Done[]): Promise<string[]> {
  const failed: string[] = [];
  for (const d of [...done].reverse()) {
    try {
      // Restore only what still holds our own content: anything else is another writer's change.
      if ((await readOrNull(d.target)) !== d.after) {
        failed.push(d.target);
        continue;
      }
      if (d.backup) await rename(d.backup, d.target);
      else if (d.before === null) await unlink(d.target).catch((e) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
      else await writeAtomic(d.target, d.before, (await stat(d.target).catch(() => undefined))?.mode);
    } catch {
      failed.push(d.target);
    }
  }
  return failed;
}

/** Files whose disk content differs from what was committed; the caller reports them. */
export async function drift(changes: FileChange[]): Promise<{ abs: string; disk: string | null }[]> {
  const out: { abs: string; disk: string | null }[] = [];
  for (const c of changes) {
    const disk = await readOrNull(await target(c.abs));
    if (disk !== c.after) out.push({ abs: c.abs, disk });
  }
  return out;
}
