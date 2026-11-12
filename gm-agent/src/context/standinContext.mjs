// A player character sees only its own phone and scenes it witnessed. No GM context is accepted.
export function witnessedBy(table, pcId, { after = 0, upTo = Infinity } = {}) {
  const userId = table.userOf(pcId), hidden = table.hiddenLines(), ownPhone = table.casual.phones[pcId];
  const result = new Map();
  for (const w of table.windows) {
    const member = w.members?.find(m => m.user_id === userId);
    if (!member) continue;
    const phone = w.id === ownPhone;
    if (!phone && table.isTableWindow(w.id)) continue;
    for (const m of table.history.lines(w.id, { after, upTo })) {
      if (hidden.has(m.id) || m.recalled_at || !['ic', 'ooc', 'narration', 'roll'].includes(m.kind)) continue;
      if (!(m.visibility === 'window' || (m.visibility === 'whisper' && (m.whisper_to ?? []).includes(pcId)))) continue;
      if (!phone) {
        const t = table.timelines.timelineAt(pcId, m.seq);
        const location = table.timelines.ofLine(m);
        if (location.id !== t.id) continue;
        // Unbound private windows are not scenes the character witnessed merely because the owner can read them.
        if (w.id !== table.windowOf(t) && table.timelines.ofWindow(w.id)?.id !== t.id && w.id !== table.mainWindow()?.id) continue;
        if (w.id === table.mainWindow()?.id && t.id !== table.timelines.main().id) continue;
      }
      result.set(m.id, m);
    }
  }
  return [...result.values()].sort((a,b) => a.seq - b.seq);
}
