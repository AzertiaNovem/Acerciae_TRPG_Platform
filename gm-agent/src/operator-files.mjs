// Files the host's operator edits in the Web UI and a channel's table reads: the worldbook and the co-players'
// intentions, one JSON file each per channel in the state directory (`<channel>.worldbook.json`,
// `<channel>.intentions.json`). They are plain files on purpose: whoever runs the agent can read them locally.
//
// Two threads write them (the host's Web UI and the channel's worker), so a write takes a short lock file and is
// refused when the file has moved past the revision the writer started from. Writes are atomic (temporary file, then
// rename) and private to the owner, since the worldbook holds the GM's secrets.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const operatorPath = (stateDir, channelId, kind) => path.join(stateDir, `${channelId}.${kind}.json`);

export class RevisionConflict extends Error {
  constructor(message) { super(message); this.code = "CONFLICT"; }
}

// The file's object, or null when there is none. A file that is not JSON is an error naming the file.
export function readOperatorFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`); }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn) {
  const lock = `${file}.lock`;
  const until = Date.now() + 3000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, "wx")); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A lock left by a process that died mid-write is removed after ten seconds.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error(`${path.basename(file)} is being written by someone else; try again`);
      pause(20);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

// Writes `update(current)` (current is null when there is no file yet). With `expect` (a revision number; 0 for "no
// file yet"), the write is refused with RevisionConflict when the file is at another revision. Returns what was
// written, with its new `revision` and `updatedAt`.
export function writeOperatorFile(file, update, { expect } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const current = readOperatorFile(file);
    const revision = Number(current?.revision) || 0;
    if (expect !== undefined && expect !== revision) throw new RevisionConflict(`${path.basename(file)} was changed elsewhere (revision ${revision}, this edit started from ${expect}); reload and try again`);
    const next = { ...update(current), revision: revision + 1, updatedAt: new Date().toISOString() };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return next;
  });
}

// A reader for a table that asks often: the file is read again only when it changed (another inode, time or size).
// `normalize(raw)` turns the file's object (null without a file) into the value used. A broken file keeps the last good
// value and is logged once.
export function watchOperatorFile(file, normalize, log = () => {}) {
  let signature = null, value = normalize(null), noted = null;
  return () => {
    let st = null;
    try { st = fs.statSync(file); } catch { /* no file */ }
    const sig = st ? `${st.ino}:${st.mtimeMs}:${st.size}` : "none";
    if (sig === signature) return value;
    try { value = normalize(st ? readOperatorFile(file) : null); signature = sig; noted = null; } catch (e) {
      if (noted !== sig) { noted = sig; log(`${path.basename(file)}: ${e.message}; the last good copy stays in use`); }
    }
    return value;
  };
}
