import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';

// GM workspace: what the GM tells every bot at this table (docs/BOTS.md): the public situation, what the characters
// know of the world, how to play here. Bots read it every turn; players never see it.
export default function BotBriefEditor({ channelId }: { channelId: string }) {
  const toast = useUi((s) => s.toast);
  const saved = useNav((s) => (s.channel?.id === channelId ? s.channel.bot_brief ?? '' : ''));
  const refreshChannel = useNav((s) => s.refreshChannel);
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const bytes = new TextEncoder().encode(text).length;
  const save = async () => {
    setBusy(true);
    try { await api.setBotBrief(channelId, text); await refreshChannel(); toast(tr('Notes for bots saved')); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <label className="col small" style={{ gap: 4 }}>{tr('Notes for bots')}
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={tr('What every bot at this table should know: the situation, what the characters know of the world, how to play here. Players never see it.')} />
      </label>
      <div className="row"><span className={`tiny ${bytes > 12000 ? 'warn-text' : 'muted'}`}>{tr('{n} of 12000 bytes', { n: bytes })}</span><span className="grow" />
        <button className="small" disabled={busy || text === saved || bytes > 12000} onClick={save}>{tr('Save')}</button></div>
    </div>
  );
}
