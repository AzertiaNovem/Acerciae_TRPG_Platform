import { t as tr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import type { BotMemory } from '../types';

// Server settings → Bots → Memory (docs/BOTS.md): what a bot remembers. Maintainers add notes for it to keep in mind
// and correct or delete what it wrote: its accounts of the tables (with the moment that struck it most) and its notes on
// people. A table's account shows only to maintainers at that table, unless the bot shares between tables; whispers
// and the GM's briefings only to that table's GMs.
const KIND: Record<BotMemory['kind'], string> = { note: 'Note', person: 'About a person', table: 'A table', table_private: 'Whispered at a table', briefing: "The GM's briefing" };

export function BotMemoryEditor({ serverId, botId }: { serverId: string; botId: string }) {
  const toast = useUi((s) => s.toast);
  const [rows, setRows] = useState<BotMemory[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { text: string; highlight: string }>>({});
  const [note, setNote] = useState('');
  const load = useCallback(() => {
    api.botMemories(serverId, botId).then((v) => { setRows(Array.isArray(v?.memories) ? v.memories : []); setDrafts({}); }).catch((e) => { setRows([]); toast(e.message, 'error'); });
  }, [serverId, botId, toast]);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e: any) { toast(e.message, 'error'); } };
  if (!rows) return <p className="tiny muted bot-memory">{tr('Loading…')}</p>;
  const draft = (m: BotMemory) => drafts[m.id] ?? { text: m.text, highlight: m.highlight };
  const order: BotMemory['kind'][] = ['note', 'person', 'table', 'table_private', 'briefing'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <div className="col bot-memory">
      {sorted.length === 0 && <p className="tiny muted">{tr('It remembers nothing yet. After a scenario closes, or when it leaves a table, it writes down what it saw there.')}</p>}
      {sorted.map((m) => {
        const d = draft(m);
        const changed = d.text !== m.text || d.highlight !== m.highlight;
        const title = m.kind === 'person' ? m.name : m.channel_name;
        return (
          <div key={m.id} className="col bot-memory-row">
            <span className="tiny"><b>{tr(KIND[m.kind])}</b>{title ? ` · ${title}` : ''} <span className="muted">· {new Date(m.updated_at).toLocaleString()}{m.source === 'edited' ? ` · ${tr('edited')}` : ''}</span></span>
            <textarea rows={m.kind === 'table' ? 5 : 2} value={d.text} aria-label={tr(KIND[m.kind])} onChange={(e) => setDrafts({ ...drafts, [m.id]: { ...d, text: e.target.value } })} />
            {m.kind === 'table' && (
              <label className="col"><span className="tiny muted">{tr('The moment that struck it most')}</span>
                <input value={d.highlight} onChange={(e) => setDrafts({ ...drafts, [m.id]: { ...d, highlight: e.target.value } })} /></label>
            )}
            <div className="row"><span className="grow" />
              <button className="small" onClick={() => confirm(tr('Delete this memory?')) && run(() => api.deleteBotMemory(serverId, botId, m.id))}>{tr('Delete')}</button>
              <button className="small primary" disabled={!changed || !d.text.trim()} onClick={() => run(() => api.updateBotMemory(serverId, botId, m.id, m.kind === 'table' ? d : { text: d.text }))}>{tr('Save')}</button></div>
          </div>
        );
      })}
      <label className="col"><span className="section-label">{tr('Add a note')}</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('Something it should keep in mind everywhere: a friendship, a running joke, a promise.')} /></label>
      <div className="row"><span className="grow" />
        <button className="small primary" disabled={!note.trim()} onClick={() => run(async () => { await api.addBotNote(serverId, botId, note.trim()); setNote(''); })}>{tr('Add')}</button></div>
    </div>
  );
}
