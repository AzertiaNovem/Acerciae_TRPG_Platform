import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { t as tr } from '../i18n';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import { useEscape } from '../hooks/useEscape';
import type { ChannelMember, ChatWindow } from '../types';

export default function WindowTools({ win }: { win: ChatWindow }) {
  const nav = useNav();
  const toast = useUi(s => s.toast);
  const [forking, setForking] = useState(false);
  const [busy, setBusy] = useState(false);
  const archive = async () => {
    setBusy(true);
    try { await api.updateWindow(win.channel_id, win.id, { archived: !win.archived_at }); await nav.refreshWindows(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return <>
    <button className="small" onClick={() => setForking(true)}>{tr('Fork scene')}</button>
    {win.kind !== 'main' && <button className="ghost small" disabled={busy} onClick={archive}>{tr(win.archived_at ? 'Restore window' : 'Archive window')}</button>}
    {forking && <ForkWindowModal win={win} onClose={() => setForking(false)} />}
  </>;
}

function ForkWindowModal({ win, onClose }: { win: ChatWindow; onClose: () => void }) {
  const nav = useNav();
  const me = useAuth(s => s.user?.id);
  const toast = useUi(s => s.toast);
  const [name, setName] = useState(win.name);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [picked, setPicked] = useState(() => (win.members ?? []).map(m => m.user_id));
  const [archive, setArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  useEscape(busy ? null : onClose);
  useEffect(() => {
    let active = true;
    api.channelMembers(win.channel_id).then(rows => { if (active) { setMembers(rows); setLoaded(true); } }).catch(e => toast(e.message, 'error'));
    return () => { active = false; };
  }, [win.channel_id, toast]);
  const submit = async () => {
    if (!name.trim() || busy || !loaded) return;
    setBusy(true);
    try {
      const result = await api.forkWindow(win.channel_id, win.id, { name: name.trim(), kind: 'group', request_id: requestId,
        members: picked.filter(id => id !== me).map(user_id => {
          const previous = win.members?.find(m => m.user_id === user_id);
          return { user_id, ...(previous?.character_id ? { character_id: previous.character_id } : {}) };
        }) });
      if (archive && win.kind !== 'main') {
        try { await api.updateWindow(win.channel_id, win.id, { archived: true }); }
        catch (e: any) { toast(e.message, 'error'); } // The fork already succeeded; keep its result.
      }
      await nav.refreshWindows();
      nav.selectWindow(result.id);
      toast(tr('Scene fork created'));
      onClose();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <form className="modal col" role="dialog" aria-modal="true" aria-label={tr('Fork scene')} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); submit(); }}>
      <h3>{tr('Fork scene')}</h3>
      <p className="small muted">{tr('Earlier messages stay in the original window. This scene shows only history up to the fork, filtered by each player group’s existing access.')}</p>
      <label>{tr('Name')}<input autoFocus value={name} disabled={busy} maxLength={80} onChange={e => setName(e.target.value)} /></label>
      <div className="section-label">{tr('Participants')}</div>
      <div className="col" style={{ maxHeight: 280, overflowY: 'auto' }}>
        {members.filter(m => m.id !== me).map(m => <label className="row" key={m.id}>
          <input type="checkbox" checked={picked.includes(m.id)} disabled={busy} onChange={e => setPicked(p => e.target.checked ? [...p, m.id] : p.filter(id => id !== m.id))} />
          {m.display_name} {m.characters?.map(c => c.name).join(', ')}
        </label>)}
      </div>
      <p className="tiny muted">{tr('Players in the same group still share their views. New participants do not gain access to earlier private scenes.')}</p>
      {win.kind !== 'main' && !win.archived_at && <label className="row"><input type="checkbox" checked={archive} disabled={busy} onChange={e => setArchive(e.target.checked)} />{tr('Archive the original window')}</label>}
      <div className="row"><span className="grow" /><button type="button" className="ghost" disabled={busy} onClick={onClose}>{tr('Cancel')}</button><button disabled={busy || !loaded || !name.trim()}>{tr(busy ? 'Creating scene…' : 'Fork scene')}</button></div>
    </form>
  </div>;
}
