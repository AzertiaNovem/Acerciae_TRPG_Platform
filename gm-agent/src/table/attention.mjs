// Participation is measured within the current seat, using actual public play.
// A review rides on a normal GM turn or daily slot, without a separate model call.
export function attentionCandidates(table, windowId) {
  if (table.generation.paused || table.cfg.coplayerIdleLines === 0) return [];
  const scene = table.scene(windowId);
  if (!scene || table.isTableWindow(windowId) || table.windows.find(w => w.id === windowId)?.archived_at) return [];
  const hidden = table.hiddenLines(), now = table.now();
  const minutes = table.cfg.coplayerIdleMinutes ?? 20, threshold = table.cfg.coplayerIdleLines ?? 12;
  const lines = table.history.lines(windowId).filter(m => m.visibility === 'window' && !hidden.has(m.id) &&
    ['ic', 'narration', 'roll'].includes(m.kind) && !m.stand_in &&
    (!(table.isPc(m.character_id) || table.roster.isCoplayer(m.character_id)) || table.timelines.timelineAt(m.character_id, m.seq).id === scene.id));
  return table.roster.coplayersIn(windowId).flatMap(cp => {
    if (!scene.members.includes(cp.characterId)) return [];
    const seat = cp.seats.findLast(s => s.windowId === windowId && s.toSeq === null);
    if (!seat) return [];
    const review = cp.attention?.windowId === windowId && cp.attention.fromSeq === seat.fromSeq ? cp.attention : null;
    if (review && now - review.at < minutes * 60000) return [];
    const start = Math.max(seat.fromSeq - 1, table.guard.rec(cp.characterId).changedSeq);
    const own = lines.findLast(m => m.seq > start && m.character_id === cp.characterId);
    const since = Math.max(start, own?.seq ?? 0, review?.seq ?? 0);
    const waiting = lines.filter(m => m.seq > since && m.character_id !== cp.characterId);
    const at = review && review.seq >= (own?.seq ?? 0) ? review.at : own ? Date.parse(own.created_at) : Math.max(table.startedAt, Date.parse(waiting[0]?.created_at));
    const elapsed = Number.isFinite(at) ? Math.max(0, now - at) : 0;
    // One old opening line is not a history of being sidelined. The time trigger also
    // needs a little sustained scene activity, so opening/restarting a table stays quiet.
    if (waiting.length < threshold && !(waiting.length >= Math.min(4, threshold) && elapsed >= minutes * 60000)) return [];
    return [{ id: cp.characterId, name: cp.name, windowId, fromSeq: seat.fromSeq, since, lines: waiting.length, minutes: Math.floor(elapsed / 60000) }];
  }).sort((a, b) => b.lines - a.lines || b.minutes - a.minutes || a.since - b.since);
}

export function attentionBrief(candidate, { gentle = false } = {}) {
  if (!candidate) return '';
  return `PARTICIPATION REVIEW: ${JSON.stringify(candidate)}
This AI co-player has been recorded in this window while other play moved on, without participating. Reconsider whether they belong here using their own latest actions and routine, not the seat label alone. Repair an already-established departure through whereabouts. Otherwise give this person one concrete, character-specific opportunity now: a task, interest, existing relationship or independent scene that can grow into their own story. They need not orbit the human protagonist. Do not merely mention their name, make them agree, or promise to give them a scene later. Put the opportunity first in your actions and give them the spotlight.
Do not invent their decision or move companions by association. Let the co-player choose; their own departure will open the correct scene. If they deliberately sleep, rest, watch, wait for an agreed event, or cannot act during an unresolved situation, respect that instead of manufacturing a crisis. Return an additional "attention_review": {"decision":"invite"|"rest","reason":"brief grounded reason"}. Use rest only with a specific reason from established play. Silence alone is not a reason to leave them dormant. Review only this person this turn.
${gentle ? 'UNATTENDED: offer only an ordinary personal activity or small independent daily-life scene. No secrets, danger, relationship escalation, player-owned plots or decisions requiring a human. Never summon, move or address a passive human to make this opportunity work.' : 'Respect player agency and pending rolls. Keep the existing scene moving for everyone else.'}`;
}

export function noteAttention(table, candidate, decision) {
  if (!candidate || table.generation.paused || table.sparkCancelled()) return;
  const cp = table.roster.coplayers.find(c => c.characterId === candidate.id);
  if (!cp) return;
  cp.attention = { windowId: candidate.windowId, fromSeq: candidate.fromSeq, seq: table.lastSeq, at: table.now(),
    decision: decision?.decision ?? 'invite', reason: decision?.reason ?? '' };
  table.save();
}

export const attentionChoice = candidate => candidate ? 'You have a dedicated opportunity now. Choose something meaningful for your own character from the situation, interests, relationships and routine you actually know. You may pursue your own scene instead of following the human. State an immediate departure and who you agree to accompany clearly if you choose one; do not narrate the outcome or move anyone else. Deliberate rest or passing remains valid.' : '';
