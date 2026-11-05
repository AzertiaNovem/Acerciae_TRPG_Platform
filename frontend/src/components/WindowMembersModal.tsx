import { t as tr } from '../i18n';
import { useEscape } from '../hooks/useEscape';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import UserPicker, { userCandidate } from './UserPicker';
import type { ChannelMember } from '../types';

// GM: invite channel members into an existing chat window or remove them from it.
export default function WindowMembersModal({ windowId, onClose }: { windowId: string; onClose: () => void }) {
  const { channelId, windows, refreshWindows } = useNav();
  useEscape(onClose);
  const me = useAuth((s) => s.user);
  const toast = useUi((s) => s.toast);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const win = windows.find((w) => w.id === windowId);
  const members = win?.members ?? [];
  useEffect(() => { if (channelId) api.channelMembers(channelId).then(setChannelMembers).catch(() => undefined); }, [channelId]);
  if (!win || !channelId) return null;

  const add = async (userId: string) => { try { await api.addWindowMember(channelId, windowId, userId); await refreshWindows(); } catch (e: any) { toast(e.message, 'error'); } };
  const remove = async (userId: string) => { try { await api.removeWindowMember(channelId, windowId, userId); await refreshWindows(); } catch (e: any) { toast(e.message, 'error'); } };
  const pause = async (userId: string, value: boolean) => {
    setBusy(userId);
    try { await api.setWindowVisibility(channelId, windowId, userId, value); await refreshWindows(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal col" role="dialog" aria-modal="true" aria-label={tr("Members")} onClick={(e) => e.stopPropagation()}>
        <h3>{tr("Members of “")}{win.name}”</h3>
        {win.kind !== 'main' && <p className="small muted">{tr('Pause hides new messages and stops posting here. Resuming does not reveal messages from the pause. Other members of the same player group still share their views.')}</p>}
        <div className="col" style={{ gap: 4 }}>
          {members.length === 0 && <div className="muted small">{tr("Nobody yet.")}</div>}
          {members.map((m) => (
            <div key={m.user_id} className="pick-row">
              <span className="grow">{m.display_name}{m.character_name && <span className="tiny muted">{tr(" as ")}{m.character_name}</span>}</span>
              {m.visibility_paused && <span className="pill">{tr('Visibility paused')}</span>}
              {win.kind !== 'main' && channelMembers.some(c => c.id === m.user_id && c.role === 'player') && <button className="small" disabled={busy !== null} onClick={() => pause(m.user_id, !m.visibility_paused)}>{tr(m.visibility_paused ? 'Resume visibility' : 'Pause visibility')}</button>}
              {m.user_id !== me?.id && <button className="small" onClick={() => remove(m.user_id)}>{tr("Remove")}</button>}
            </div>
          ))}
        </div>
        <div className="section-label">{tr("Invite from this channel")}</div>
        <UserPicker mode="action" actionLabel={tr("Add")} autoFocus
          candidates={channelMembers.map((m) => userCandidate(m, m.characters?.map((c) => c.name).join(', ') || m.role))}
          exclude={members.map((m) => m.user_id)} emptyText={tr("Everyone in the channel is already here.")}
          onAction={(c) => add(c.id)} />
        <div className="row"><span className="grow" /><button className="ghost" onClick={onClose}>{tr("Done")}</button></div>
      </div>
    </div>
  );
}
