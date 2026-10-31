// The local state file: which platform NPC characters this client plays as co-players and which as real NPCs, where
// the co-players sit, the timelines and their guard, the current scenario's start and any split in progress. One file
// per channel under STATE_DIR.
//
// One writer: while `run` keeps a channel it holds `<channel>.lock`, and CLI commands (split, rejoin, advance) are
// appended to `<channel>.inbox.jsonl` for it to apply. Saves are compare-and-swap on a `version` counter, so a stale
// writer is refused instead of silently overwriting newer state.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function statePath(stateDir, channelId) { return path.join(stateDir, `${channelId}.json`); }
export function lockPath(stateDir, channelId) { return path.join(stateDir, `${channelId}.lock`); }
export function inboxPath(stateDir, channelId) { return path.join(stateDir, `${channelId}.inbox.jsonl`); }

export function loadState(stateDir, channelId) {
  try { return JSON.parse(fs.readFileSync(statePath(stateDir, channelId), "utf8")); } catch { return null; }
}

export class StateConflict extends Error {}

// Writes `state` if the file is still at `expectVersion` (undefined: don't check). Returns the new version.
export function saveState(stateDir, state, { expectVersion } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = statePath(stateDir, state.channelId);
  const onDisk = loadState(stateDir, state.channelId);
  const current = Number(onDisk?.version) || 0;
  if (expectVersion !== undefined && onDisk && current !== expectVersion) throw new StateConflict(`the state file was changed by another process (version ${current}, expected ${expectVersion})`);
  const version = current + 1;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, version }, null, 2));
  fs.renameSync(tmp, file);
  return version;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// The pid of a live process holding the channel, or null.
export function lockHolder(stateDir, channelId) {
  try {
    const pid = Number(fs.readFileSync(lockPath(stateDir, channelId), "utf8").trim());
    return pid && pid !== process.pid && alive(pid) ? pid : null;
  } catch { return null; }
}

// Takes the channel's lock atomically (the file is created exclusively; a lock left by a dead process is removed);
// returns a release function, or null when another live process holds it.
export function acquireLock(stateDir, channelId) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = lockPath(stateDir, channelId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (lockHolder(stateDir, channelId)) return null;
      // A stale lock (or one being written this instant: an empty file younger than a second is left alone).
      let stale = true;
      try { const st = fs.statSync(file); stale = st.size > 0 || Date.now() - st.mtimeMs > 1000; } catch { /* gone meanwhile */ }
      if (!stale) return null;
      try { fs.unlinkSync(file); } catch { /* someone else removed it */ }
    }
  }
  return null;
}

export function appendInbox(stateDir, channelId, command) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(inboxPath(stateDir, channelId), `${JSON.stringify({ ...command, at: new Date().toISOString() })}\n`);
}

// Takes every queued command (moving the inbox aside first, so commands appended meanwhile wait for the next drain).
export function drainInbox(stateDir, channelId) {
  const file = inboxPath(stateDir, channelId);
  const taken = `${file}.${process.pid}.taking`;
  try { fs.renameSync(file, taken); } catch { return []; }
  const lines = fs.readFileSync(taken, "utf8").split("\n").filter(Boolean);
  fs.unlinkSync(taken);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
