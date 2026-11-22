import { t as tr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import { BotTag } from './BotTag';
import { BotTableMemory } from './BotTableMemory';
import type { ChannelBots as View } from '../types';

// The channel sidebar's Bots section (docs/BOTS.md): the server's bots at this table, and an invitation dialog. Any
// member may invite while the server's bots feature and the channel's switch are on; the GM removes.
export default function ChannelBots({ channelId }: { channelId: string }) {
  const toast = useUi((s) => s.toast);
  const [view, setView] = useState<View | null>(null);
  const [open, setOpen] = useState(false);
  const [memoryOf, setMemoryOf] = useState<string | null>(null);
  // An older server (no such route) or anything malformed shows nothing rather than breaking the sidebar.
  const load = useCallback(() => { api.channelBots(channelId).then((v) => setView(v && Array.isArray(v.present) && Array.isArray(v.invitable) ? v : null)).catch(() => setView(null)); }, [channelId]);
  useEffect(() => {
    load();
    const changed = (e: Event) => { if ((e as CustomEvent).detail === channelId) load(); };
    window.addEventListener('acerciae:bots', changed);
    return () => window.removeEventListener('acerciae:bots', changed);
  }, [channelId, load]);
  if (!view || (!view.feature && view.present.length === 0)) return null;
  const run = async (fn: () => Promise<View>) => { try { setView(await fn()); } catch (e: any) { toast(e.message, 'error'); } };
  const full = view.present.length >= view.limit;
  return (
    <>
      <div className="section"><span>{tr('Bots')}</span>
        {(view.can_invite || view.can_remove) && <button className="ghost small" title={tr('Invite a bot')} aria-label={tr('Invite a bot')} onClick={() => setOpen(true)}>+</button>}</div>
      {view.present.map((b) => (
        <div key={b.id} className="item bot" style={{ cursor: 'default' }} title={b.invited_by_name ? tr('Invited by {name}', { name: b.invited_by_name }) : undefined}>
          <span className="name small">{b.name}</span><BotTag />
          {b.characters.length > 0 && <span className="tiny muted">{b.characters.map((c) => c.name).join(', ')}</span>}
        </div>
      ))}
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal col" role="dialog" aria-modal="true" aria-label={tr('Bots at this table')} onClick={(e) => e.stopPropagation()}>
            <h3>{tr('Bots at this table')}</h3>
            {view.present.length === 0 && <p className="muted small">{tr('No bot is here yet.')}</p>}
            {view.present.map((b) => (
              <div key={b.id} className="col" style={{ gap: 4 }}>
                <div className="pick-row">
                  <span className="grow">{b.name} <BotTag />{b.invited_by_name && <span className="tiny muted"> {tr('invited by {name}', { name: b.invited_by_name })}</span>}</span>
                  {view.can_remove && <button className="small" aria-expanded={memoryOf === b.id} onClick={() => setMemoryOf(memoryOf === b.id ? null : b.id)}>{tr('Memory')}</button>}
                  {view.can_remove && <button className="small" onClick={() => confirm(tr('Remove {name} from this channel? Its characters stay.', { name: b.name })) && run(() => api.removeChannelBot(channelId, b.id))}>{tr('Remove')}</button>}
                </div>
                {view.can_remove && memoryOf === b.id && <BotTableMemory channelId={channelId} botId={b.id} />}
              </div>
            ))}
            {view.can_invite ? (<>
              <div className="section-label">{tr('Invite a bot')}</div>
              {full ? <p className="tiny muted">{tr('This table has as many bots as the server allows ({n}).', { n: view.limit })}</p>
                : view.invitable.length === 0 ? <p className="tiny muted">{tr('No other bot to invite. Server maintainers set bots up in Server settings → Bots.')}</p>
                : view.invitable.map((b) => (
                  <div key={b.id} className="pick-row"><span className="grow">{b.name} <BotTag /></span>
                    <button className="small primary" onClick={() => run(() => api.inviteBot(channelId, b.id))}>{tr('Invite')}</button></div>
                ))}
              <p className="tiny muted">{tr('A bot joins at once as a player. It speaks as itself until the GM or the bot gives it a character.')}</p>
            </>) : view.feature && <p className="tiny muted">{tr('The GM has turned bot invitations off in this channel.')}</p>}
            <div className="row"><span className="grow" /><button className="primary" onClick={() => setOpen(false)}>{tr('Done')}</button></div>
          </div>
        </div>
      )}
    </>
  );
}
