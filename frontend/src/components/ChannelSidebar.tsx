import { t as tr } from '../i18n';
import { activate } from '../lib/a11y';
import { useEscape } from '../hooks/useEscape';
import { useCallback, useEffect, useState } from 'react';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import UserPicker, { userCandidate } from './UserPicker';
import WindowMembersModal from './WindowMembersModal';
import UserSettingsModal from './UserSettingsModal';
import ServerSettingsModal from './ServerSettingsModal';
import type { ChannelMember, ServerMember } from '../types';
import { studioAccess } from './studio/access';

export default function ChannelSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNav();
  const { user, logout } = useAuth();
  const toast = useUi((s) => s.toast);
  const [openScenario, setOpenScenario] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'channel' | 'window' | 'member' | 'character'>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [serverMembers, setServerMembers] = useState<ServerMember[]>([]);
  const [manageWindow, setManageWindow] = useState<string | null>(null);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const f = (k: string) => form[k] ?? '';
  const set = (k: string, v: string) => setForm({ ...form, [k]: v });
  const isGm = nav.channel?.my_role === 'gm';
  const studioOpen = studioAccess(nav.channel, nav.serverSettings) === 'open';
  const myServerRole = nav.servers.find((s) => s.id === nav.serverId)?.my_role;
  const isMaintainer = myServerRole === 'owner' || myServerRole === 'admin';
  const isGuest = myServerRole === 'guest';
  const policy = nav.serverSettings?.policy;
  const canCreateChannel = !isGuest && (isMaintainer || policy?.channel_creation !== 'maintainers');
  // A GM may bring in people from outside the server: as members when they maintain it, as guests when it allows guests.
  const canInviteOutsiders = isMaintainer || !!policy?.guest_invites;
  const characters = nav.channel ? nav.characters : [];

  // Member lists for the pickers are fetched when a dialog that needs them opens.
  useEffect(() => {
    if (!nav.channelId || (dialog !== 'window' && dialog !== 'member')) return;
    api.channelMembers(nav.channelId).then(setChannelMembers).catch(() => undefined);
    if (dialog === 'member' && nav.serverId && !isGuest) api.serverMembers(nav.serverId).then(setServerMembers).catch(() => undefined);
  }, [dialog, nav.channelId, nav.serverId, isGuest]);
  const searchAll = useCallback(async (q: string) => (await api.searchUsers(q)).map((u) => userCandidate(u, isMaintainer ? tr('not on this server') : tr('joins as a guest'))), [isMaintainer]);

  const close = () => { setDialog(null); setForm({}); setPicked([]); };
  useEscape(dialog ? close : null);
  const submit = async () => {
    try {
      if (dialog === 'channel' && nav.serverId) { const c = await api.createChannel(nav.serverId, { name: f('name'), description: f('description'), knowledge_mode: f('mode') || 'isolated' }); await nav.selectServer(nav.serverId); await nav.selectChannel(c.id); }
      if (dialog === 'window' && nav.channelId) {
        if (!f('name').trim()) { toast('Give the window a name', 'error'); return; }
        await api.createWindow(nav.channelId, { name: f('name'), kind: (f('kind') as any) || 'group', members: picked.map((user_id) => ({ user_id })) });
        await nav.refreshWindows();
      }
      if (dialog === 'character' && nav.channelId) { await api.createCharacter(nav.channelId, { name: f('name'), kind: (f('kind') as any) || 'pc', speaking_style: f('style'), description: f('description') }); await nav.refreshCharacters(); await nav.refreshWindows(); }
      close();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const invite = async (userId: string, label: string) => {
    if (!nav.channelId) return;
    try {
      const added = await api.addChannelMember(nav.channelId, userId, (f('role') as any) || 'player');
      toast(added.server_role === 'guest' ? `${label} joined as a guest` : `Added ${label}`);
      setChannelMembers(await api.channelMembers(nav.channelId));
      await nav.refreshWindows();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const serverName = nav.servers.find((s) => s.id === nav.serverId)?.name;

  return (
    <div className={`channel-sidebar ${open ? 'open' : ''}`}>
      <div className="section"><span>{serverName ?? tr("Channels")}</span>
        <span className="row" style={{ gap: 2 }}>
          {nav.serverId && isMaintainer && <button className="ghost small" title={tr("Server settings (maintainers)")} onClick={() => setServerSettingsOpen(true)}>⚙</button>}
          {nav.serverId && canCreateChannel && <button className="ghost small" title={tr("New campaign channel")} onClick={() => setDialog('channel')}>+</button>}
        </span>
      </div>
      <div className="sidebar-scroll">
        {nav.channels.map((c) => (
          <div key={c.id} className={`item ${c.id === nav.channelId && !nav.spectateChannelId ? 'active' : ''}`} {...activate(() => { nav.selectChannel(c.id); onClose(); })}>
            <span className="muted">#</span><span className="name">{c.name}</span>{c.my_role === 'gm' && <span className="pill gm">{tr("GM")}</span>}
          </div>
        ))}
        {isGuest && <div className="tiny muted" style={{ padding: '2px 12px' }}>{tr("You are a guest on this server: you see only the channels you were invited to.")}</div>}
        {nav.spectatable.length > 0 && (<>
          <div className="section"><span>{tr("Other channels (read-only)")}</span></div>
          {nav.spectatable.map((c) => (
            <div key={c.id} className={`item ${c.id === nav.spectateChannelId ? 'active' : ''}`} title={c.description || tr("Read its Main Chat")} {...activate(() => { nav.openSpectate(c.id); onClose(); })}>
              <span className="muted">👁</span><span className="name">{c.name}</span>
            </div>
          ))}
        </>)}
        {nav.channelId && (
          <>
            <div className="section"><span>{tr("Chat windows")}</span>{isGm && <button className="ghost small" title={tr("New chat window")} onClick={() => setDialog('window')}>+</button>}</div>
            {nav.windows.map((w) => (
              <div key={w.id} className={`item ${w.id === nav.windowId && !nav.gmWorkspaceOpen && !nav.studioOpen ? 'active' : ''}`} {...activate(() => { nav.selectWindow(w.id); onClose(); })} title={(w.members ?? []).map((m) => m.character_name ?? m.display_name).join(', ')}>
                <span className="muted">{w.kind === 'main' ? '◎' : w.kind === 'private' ? '◌' : '○'}</span><span className="name">{w.name}</span>
                {isGm ? <button className="ghost small member-count" title={tr("Invite or remove members")} onClick={(e) => { e.stopPropagation(); setManageWindow(w.id); }}>{(w.members ?? []).length} ⚇</button>
                  : <span className="tiny muted">{(w.members ?? []).length}</span>}
              </div>
            ))}
            <div className="section"><span>{tr("Scenarios")}</span>{isGm && <button className="ghost small" title={tr("Open the next scenario for the whole campaign")} onClick={async () => { try { await api.advanceScenario(nav.channelId!, {}); nav.refreshWindows(); nav.refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } }}>▶</button>}</div>
            {nav.scenes.length === 0 && <div className="item" style={{ cursor: 'default' }}><span className="name small muted">—</span></div>}
            {nav.scenes.slice(-8).map((s) => {
              const current = s.id === nav.channel?.current_scene_id;
              const open = openScenario === s.id;
              return (
                <div key={s.id}>
                  <div className={`item scenario ${current ? 'active' : ''}`} title={isGm && s.summary ? s.summary : undefined} onClick={() => setOpenScenario(open ? null : s.id)}>
                    <span className="muted tiny">{s.sequence}</span><span className="name small">{isGm ? s.title : `${tr("Scenario")} ${s.sequence}`}</span>
                    {s.auto_detected && <span className="tiny muted" title={tr("opened by the AI")}>✦</span>}{s.status === 'closed' && <span className="tiny muted">·</span>}
                  </div>
                  {open && isGm && (s.summary || s.location || s.narrative_time) && <div className="scenario-summary tiny muted">{[s.location, s.narrative_time].filter(Boolean).join(' · ')}{s.summary ? (s.location || s.narrative_time ? ' — ' : '') + s.summary : ''}</div>}
                </div>
              );
            })}
            <div className="section"><span>{tr("Characters")}</span><button className="ghost small" title={tr("New character")} onClick={() => setDialog('character')}>+</button></div>
            {characters.map((c) => (
              <div key={c.id} className={`item ${nav.characterSpaceId === c.id ? 'active' : ''}`} {...activate(() => { nav.openCharacter(c.id); onClose(); })} title={tr("Open character space")}>
                {c.avatar_asset_id && nav.channelId ? <img className="mini-avatar" src={api.mediaUrl(nav.channelId, c.avatar_asset_id)} alt="" /> : <span className="mini-avatar text">{c.name.slice(0, 1)}</span>}
                <span className="name small">{c.name}</span><span className="tiny muted">{c.kind === 'npc' ? tr("NPC") : c.player_name ?? ''}</span>
              </div>
            ))}
            {studioOpen && (
              <>
                <div className="section"><span>{tr("Production")}</span></div>
                <div className={`item ${nav.studioOpen ? 'active' : ''}`} {...activate(() => { nav.setStudioOpen(true); onClose(); })}><span>✎</span><span className="name">{tr("Log Studio")}</span></div>
              </>
            )}
            {isGm && (
              <>
                <div className="section"><span>{tr("Game master")}</span></div>
                <div className={`item ${nav.gmWorkspaceOpen ? 'active' : ''}`} {...activate(() => { nav.setGmWorkspaceOpen(true); onClose(); })}><span>⚙</span><span className="name">{tr("GM workspace")}</span></div>
                <div className="item" {...activate(() => setDialog('member'))}><span>＋</span><span className="name">{tr("Invite player")}</span></div>
              </>
            )}
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{user?.avatar_data ? <img src={user.avatar_data} alt="" /> : user?.display_name.slice(0, 2).toUpperCase()}</div>
        <div className="grow small"><div>{user?.display_name}</div><div className="tiny muted">@{user?.username}</div></div>
        <button className="ghost small" title={tr("User settings")} aria-label={tr("User settings")} onClick={() => setUserSettingsOpen(true)}>⚙</button>
        <button className="ghost small" onClick={logout}>{tr("Sign out")}</button>
      </div>
      {dialog && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal col" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            {dialog === 'channel' && (<><h3>{tr("New campaign channel")}</h3><input placeholder={tr("Name")} value={f('name')} onChange={(e) => set('name', e.target.value)} autoFocus /><input placeholder={tr("Description")} value={f('description')} onChange={(e) => set('description', e.target.value)} />
              <select value={f('mode') || 'isolated'} onChange={(e) => set('mode', e.target.value)}><option value="isolated">{tr("New players: separate groups")}</option><option value="public">{tr("New players: shared group")}</option></select></>)}
            {dialog === 'window' && (<><h3>{tr("New chat window")}</h3><input placeholder={tr("Name (e.g. Solo investigation)")} value={f('name')} onChange={(e) => set('name', e.target.value)} autoFocus />
              <select value={f('kind') || 'group'} onChange={(e) => set('kind', e.target.value)}><option value="group">{tr("Group")}</option><option value="private">{tr("Private")}</option></select>
              <div className="section-label">{tr("Members")}</div>
              <UserPicker mode="select" selected={picked} onToggle={(c) => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                candidates={channelMembers.filter((m) => m.id !== user?.id).map((m) => userCandidate(m, m.characters?.map((c) => c.name).join(', ') || m.role))}
                emptyText={tr("No other channel members match.")} placeholder={tr("Search channel members…")} />
              <div className="tiny muted">{tr("New windows join the campaign's current scenario.")}</div></>)}
            {dialog === 'member' && (<><h3>{tr("Invite to channel")}</h3>
              <select value={f('role') || 'player'} onChange={(e) => set('role', e.target.value)}><option value="player">{tr("as Player")}</option><option value="gm">{tr("as GM")}</option></select>
              <UserPicker mode="action" actionLabel={tr("Invite")} autoFocus
                candidates={serverMembers.map((m) => userCandidate(m))} search={canInviteOutsiders ? searchAll : undefined}
                exclude={channelMembers.map((m) => m.id)} placeholder={canInviteOutsiders ? tr("Search server members or any user…") : tr("Search server members…")}
                emptyText={canInviteOutsiders ? tr("No matching user.") : tr("No matching server member — a server maintainer can invite new people to the server.")}
                onAction={(c) => invite(c.id, c.label)} /></>)}
            {dialog === 'character' && (<><h3>{tr("New character")}</h3><input placeholder={tr("Name")} value={f('name')} onChange={(e) => set('name', e.target.value)} autoFocus />
              {isGm && <select value={f('kind') || 'pc'} onChange={(e) => set('kind', e.target.value)}><option value="pc">{tr("Player character")}</option><option value="npc">{tr("NPC (GM)")}</option></select>}
              <input placeholder={tr("Speaking style (e.g. terse, formal)")} value={f('style')} onChange={(e) => set('style', e.target.value)} /><input placeholder={tr("Description / occupation")} value={f('description')} onChange={(e) => set('description', e.target.value)} /></>)}
            <div className="row">
              {dialog === 'member' ? <button className="primary" onClick={close}>{tr("Done")}</button> : <><button className="primary" onClick={submit}>{dialog === 'window' ? `Create${picked.length ? ` with ${picked.length}` : ''}` : tr("Save")}</button><button className="ghost" onClick={close}>{tr("Cancel")}</button></>}
            </div>
          </div>
        </div>
      )}
      {manageWindow && <WindowMembersModal windowId={manageWindow} onClose={() => setManageWindow(null)} />}
      {userSettingsOpen && <UserSettingsModal onClose={() => setUserSettingsOpen(false)} />}
      {serverSettingsOpen && <ServerSettingsModal onClose={() => setServerSettingsOpen(false)} />}
    </div>
  );
}
