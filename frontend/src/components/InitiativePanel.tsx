import { useEffect, useState } from 'react';
import { t as tr } from '../i18n';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import type { InitiativeOrder } from '../types';

// The window's Initiative order (D&D channels): who acts in which order and whose turn it is. Players join it with .ri;
// the Dungeon Master moves the turn, removes an entry or clears the order (here or with .init next / del / clr).
export default function InitiativePanel({ channelId, windowId, isGm }: { channelId: string; windowId: string; isGm: boolean }) {
  const toast = useUi((s) => s.toast);
  const me = useAuth((s) => s.user?.id);
  const [order, setOrder] = useState<InitiativeOrder | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api.initiative(channelId, windowId).then((o) => { if (live) setOrder(o); }).catch(() => undefined);
    load();
    const on = (e: Event) => { if ((e as CustomEvent).detail === windowId) load(); };
    window.addEventListener('acerciae:initiative', on);
    return () => { live = false; window.removeEventListener('acerciae:initiative', on); };
  }, [channelId, windowId]);
  if (!order || order.entries.length === 0) return null;
  const act = async (action: 'next' | 'clear' | 'remove', entry_id?: string) => {
    if (action === 'clear' && !confirm(tr('Clear the Initiative order?'))) return;
    setBusy(true);
    try { setOrder(await api.initiativeAction(channelId, windowId, { action, entry_id })); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="initiative-bar" role="region" aria-label={tr('Initiative')}>
      <span className="initiative-round">{order.round > 0 ? tr('Round {n}', { n: order.round }) : tr('Initiative')}</span>
      <ol className="initiative-list">
        {order.entries.map((e) => (
          <li key={e.id} className={e.id === order.turn ? 'current' : ''} aria-current={e.id === order.turn ? 'step' : undefined}>
            <span className="initiative-total">{e.total}</span>
            <span className="initiative-name">{e.name}</span>
            {(isGm || e.created_by === me) && <button className="ghost small" aria-label={tr('Remove {who}', { who: e.name })} disabled={busy} onClick={() => act('remove', e.id)}>✕</button>}
          </li>
        ))}
      </ol>
      {isGm && <span className="row" style={{ gap: 4 }}>
        <button className="small primary" disabled={busy} onClick={() => act('next')}>{order.turn ? tr('Next turn') : tr('Start')}</button>
        <button className="ghost small" disabled={busy} onClick={() => act('clear')}>{tr('Clear')}</button>
      </span>}
    </div>
  );
}
