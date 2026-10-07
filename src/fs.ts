// Filesystem access shared by read and edit: text decoding with its refusals, symlink
// resolution, and the git-visible file listing that globs run over.
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export async function readText(abs: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EISDIR") throw new Error(`${abs} is a directory`);
    throw e;
  }
  if (isBinary(buf)) throw new Error(`${abs} is binary; this tool edits text`);
  const text = buf.toString("utf8");
  // Decoding invalid UTF-8 replaces bytes with U+FFFD, and writing it back would corrupt the file.
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error(`${abs} is not valid UTF-8; this tool would corrupt it`);
  return text;
}

/** Symlinks resolved; for a path that does not exist yet, its directory is resolved instead. */
export async function canonical(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    try {
      return join(await realpath(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

export async function isSymlink(abs: string): Promise<boolean> {
  return (await lstat(abs).catch(() => undefined))?.isSymbolicLink() ?? false;
}

export async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, maxBuffer: 256 << 20 });
    return stdout.split("\0").filter(Boolean);
  } catch {
    const { glob } = await import("node:fs/promises");
    const out: string[] = [];
    for await (const p of glob("**/*", { cwd, exclude: (p: string) => /(^|\/)(node_modules|\.git|_build|deps|dist)$/.test(p) })) {
      out.push(p as string);
    }
    return out;
  }
}
