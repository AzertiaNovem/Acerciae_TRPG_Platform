import { t as tr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import type { BotTableMemory as View } from '../types';

// The GM's view of what a bot remembers of this table (docs/BOTS.md): its account, with the moment that struck it most,
// and what was whispered to its characters; a private briefing only this bot reads, at this table; and "Forget this
// table", which erases its memory of the table and lets go of what it saw here so far.
export function BotTableMemory({ channelId, botId }: { channelId: string; botId: string }) {
  const toast = useUi((s) => s.toast);
  const [view, setView] = useState<View | null>(null);
  const [briefing, setBriefing] = useState('');
  const load = useCallback(() => {
    api.botTableMemory(channelId, botId).then((v) => { setView(v); setBriefing(v?.briefing?.text ?? ''); }).catch((e) => toast(e.message, 'error'));
  }, [channelId, botId, toast]);
  useEffect(load, [load]);
  if (!view) return <p className="tiny muted">{tr('Loading…')}</p>;
  const run = async (fn: () => Promise<View>) => { try { const v = await fn(); setView(v); setBriefing(v?.briefing?.text ?? ''); } catch (e: any) { toast(e.message, 'error'); } };
  const bytes = new TextEncoder().encode(briefing).length;
  return (
    <div className="col bot-memory">
      {view.table ? (<>
        <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{view.table.text}</p>
        {view.table.highlight && <p className="tiny"><b>{tr('The moment that struck it most')}:</b> {view.table.highlight}</p>}
      </>) : <p className="tiny muted">{tr('It has not written anything about this table yet. It does when a scenario closes, when it leaves, or after a long stretch of play.')}</p>}
      {view.table_private && <p className="tiny" style={{ whiteSpace: 'pre-wrap' }}><b>{tr('Whispered to it')}:</b> {view.table_private.text}</p>}
      <label className="col"><span className="section-label">{tr('Private briefing for this bot')}</span>
        <textarea rows={3} value={briefing} onChange={(e) => setBriefing(e.target.value)} placeholder={tr('What only this bot should know at this table: its character’s secret, an aim, how to play it.')} />
        <span className="tiny muted">{tr('{n} of 8000 bytes', { n: bytes })}</span></label>
      <div className="row">
        <button className="small" disabled={!view.table && !view.table_private} onClick={() => confirm(tr('Forget this table? The bot erases what it remembers of it and lets go of what it saw here so far.')) && run(() => api.forgetBotTable(channelId, botId))}>{tr('Forget this table')}</button>
        <span className="grow" />
        <button className="small primary" disabled={bytes > 8000 || briefing === (view.briefing?.text ?? '')} onClick={() => run(() => api.setBotBriefing(channelId, botId, briefing))}>{tr('Save briefing')}</button>
      </div>
    </div>
  );
}
