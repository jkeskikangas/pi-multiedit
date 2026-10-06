// Codex `apply_patch` (V4A) envelope: GPT models emit it natively. Parsed into file operations
// plus per-file hunk lists that the engine applies with the same fuzzy ladder as `old`.
export type Hunk = { header?: string; old: string[]; new: string[]; eof: boolean };
export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

export function parseV4A(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() !== "*** Begin Patch") throw new Error('patch must start with "*** Begin Patch"');
  i++;
  const ops: PatchOp[] = [];
  const header = (prefix: string) => (lines[i].startsWith(prefix) ? lines[i].slice(prefix.length).trim() : undefined);
  for (;;) {
    if (i >= lines.length) throw new Error('patch is missing "*** End Patch"');
    const line = lines[i];
    if (line.trim() === "*** End Patch") break;
    let path: string | undefined;
    if ((path = header("*** Add File: ")) !== undefined) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("+")) throw new Error(`Add File ${path}: line ${i + 1} must start with "+"`);
        body.push(lines[i].slice(1));
        i++;
      }
      ops.push({ kind: "add", path, content: body.length ? body.join("\n") + "\n" : "" });
    } else if ((path = header("*** Delete File: ")) !== undefined) {
      i++;
      ops.push({ kind: "delete", path });
    } else if ((path = header("*** Update File: ")) !== undefined) {
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && (moveTo = header("*** Move to: ")) !== undefined) i++;
      const hunks: Hunk[] = [];
      let hunk: Hunk | undefined;
      while (i < lines.length && !(lines[i].startsWith("*** ") && lines[i].trim() !== "*** End of File")) {
        const l = lines[i];
        if (l.startsWith("@@")) {
          hunk = { header: l.slice(2).trim() || undefined, old: [], new: [], eof: false };
          hunks.push(hunk);
        } else if (l.trim() === "*** End of File") {
          if (hunk) hunk.eof = true;
        } else {
          if (!hunk) {
            hunk = { old: [], new: [], eof: false };
            hunks.push(hunk);
          }
          const tag = l[0];
          const body = l.slice(1);
          if (tag === " " || l === "") {
            hunk.old.push(body);
            hunk.new.push(body);
          } else if (tag === "-") hunk.old.push(body);
          else if (tag === "+") hunk.new.push(body);
          else throw new Error(`Update File ${path}: line ${i + 1} must start with " ", "-", "+" or "@@"`);
        }
        i++;
      }
      ops.push({ kind: "update", path, moveTo, hunks: hunks.filter((h) => h.old.length || h.new.length) });
    } else {
      throw new Error(`unexpected patch line ${i + 1}: ${line.slice(0, 80)}`);
    }
  }
  return ops;
}
