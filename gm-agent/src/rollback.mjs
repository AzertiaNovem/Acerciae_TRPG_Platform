// Recall and rollback. On the platform an author may recall a line for two minutes after sending it (kinds ic, ooc and
// narration; never a roll). When a player recalls a line that is still recent (fewer than RECALL_ROLLBACK_LINES lines
// came after it in its window), the table undoes what it did about it: every turn that answered it or ran after it in
// that window is rolled back. The client recalls the lines those turns posted (narration, NPC and co-player lines,
// whispers, notes, openings in other windows) and restores what they changed in its own state: where co-players are
// (timelines and seats, with the move guard), the calendar, relationships, hidden truths and phone texts still on their
// way. Changes the platform already holds (a scenario change, a world change, a new NPC, a roll's result) stay, and
// the GM is told so in a GM-only note. Players' other lines after the recalled one stay and are answered again.
// An older recall (RECALL_ROLLBACK_LINES or more lines since) only takes the line out of every context.
//
// The checkpoints are kept in memory: a restart forgets them (the recall window is two minutes).

export const RECALL_ROLLBACK_LINES = 10;
export const CHECKPOINT_MS = 5 * 60000;
export const CHECKPOINTS_KEPT = 40;

// The checkpoints a recall of `line` undoes: turns that answered it, turns that started after it in its window, and
// every turn those started (a follow-up, the opening of a scene a move created).
export function checkpointsToUndo(checkpoints, line) {
  const undo = new Set(checkpoints.filter((cp) => cp.batch.some((l) => l.seq === line.seq) || (cp.windowId === line.chat_window_id && cp.startSeq >= line.seq)));
  for (let grew = true; grew;) {
    grew = false;
    for (const cp of checkpoints) if (!undo.has(cp) && cp.parent && undo.has(cp.parent)) { undo.add(cp); grew = true; }
  }
  return checkpoints.filter((cp) => undo.has(cp));
}

// JSON with sorted keys: the same state compares equal however its objects were rebuilt.
export function stable(value) {
  return JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

// Phone texts (casual mode) a turn added to the queue: in `after` but not in `before` (compared as JSON).
export function addedPending(before, after) {
  const had = new Set(before.map((p) => stable(p)));
  return after.filter((p) => !had.has(stable(p)));
}

// Characters whose timeline differs between two timeline snapshots ({list}: timelines with members).
export function movedBetween(before, after) {
  const where = (t) => new Map((t?.list ?? []).filter((x) => x.status === "active").flatMap((x) => (x.members ?? []).map((id) => [id, x.id])));
  const a = where(before), b = where(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id));
}

// The GM-only note after a rollback: what was taken back, and what stays because the platform already holds it.
export function rollbackNote({ who, recalled, restored, kept }) {
  const parts = [`${who} recalled a line. I took back ${recalled === 1 ? "my line" : `${recalled} of my lines`} after it${restored.length ? ` and undid ${restored.join(", ")}` : ""}.`];
  if (kept.length) parts.push(`These stay, because the platform already holds them: ${kept.join("; ")}. Play on from them.`);
  parts.push("Answer what the players say next as if the recalled line had never been sent.");
  return parts.join(" ");
}
