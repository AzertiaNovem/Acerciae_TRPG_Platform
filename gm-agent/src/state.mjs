// The local state file: which platform NPC characters this client plays as co-players and which as real NPCs, and
// where the co-players sit. One file per channel under STATE_DIR.
import fs from "node:fs";
import path from "node:path";

export function statePath(stateDir, channelId) { return path.join(stateDir, `${channelId}.json`); }

export function loadState(stateDir, channelId) {
  try { return JSON.parse(fs.readFileSync(statePath(stateDir, channelId), "utf8")); } catch { return null; }
}

export function saveState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = statePath(stateDir, state.channelId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}
