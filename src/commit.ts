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

type Done = { target: string; before: string | null; backup?: string };

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
  for (const c of resolved) {
    const now = await readOrNull(c.target);
    if (now !== c.before) throw new Error(`${c.abs} changed on disk while the edit was being planned; nothing was written`);
    if (c.before !== null) {
      await access(c.target, constants.W_OK);
      c.mode = (await stat(c.target)).mode & 0o7777;
    }
  }
  const done: Done[] = [];
  try {
    for (const c of resolved) {
      if (c.after === null) {
        const backup = tmpName(c.target);
        await rename(c.target, backup);
        done.push({ target: c.target, before: c.before, backup });
        continue;
      }
      if (c.before === null) await mkdir(dirname(c.target), { recursive: true });
      await writeAtomic(c.target, c.after, c.mode);
      done.push({ target: c.target, before: c.before });
    }
  } catch (e) {
    const failed = await rollback(done);
    const tail = failed.length ? ` Rollback FAILED for: ${failed.join(", ")} — inspect them.` : " All files were restored.";
    throw new Error(`write failed: ${(e as Error).message}.${tail}`);
  }
  await Promise.all(done.filter((d) => d.backup).map((d) => unlink(d.backup!).catch(() => {})));
}

async function rollback(done: Done[]): Promise<string[]> {
  const failed: string[] = [];
  for (const d of [...done].reverse()) {
    try {
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
