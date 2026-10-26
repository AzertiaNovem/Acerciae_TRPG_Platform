import { useCallback, useEffect, useState } from 'react';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import UserPicker, { userCandidate } from './UserPicker';
import WindowMembersModal from './WindowMembersModal';
import CharacterSheetModal from './CharacterSheetModal';
import ServerSettingsModal from './ServerSettingsModal';
import type { ChannelMember, ServerMember } from '../types';

export default function ChannelSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNav();
  const { user, logout } = useAuth();
  const toast = useUi((s) => s.toast);
  const [dialog, setDialog] = useState<null | 'channel' | 'window' | 'member' | 'character'>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [serverMembers, setServerMembers] = useState<ServerMember[]>([]);
  const [manageWindow, setManageWindow] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const f = (k: string) => form[k] ?? '';
  const set = (k: string, v: string) => setForm({ ...form, [k]: v });
  const isGm = nav.channel?.my_role === 'gm';
  const myServerRole = nav.servers.find((s) => s.id === nav.serverId)?.my_role;
  const isMaintainer = myServerRole === 'owner' || myServerRole === 'admin';
  const characters = nav.channel ? nav.characters : [];

  // Member lists for the pickers are fetched when a dialog that needs them opens.
  useEffect(() => {
    if (!nav.channelId || (dialog !== 'window' && dialog !== 'member')) return;
    api.channelMembers(nav.channelId).then(setChannelMembers).catch(() => undefined);
    if (dialog === 'member' && nav.serverId) api.serverMembers(nav.serverId).then(setServerMembers).catch(() => undefined);
  }, [dialog, nav.channelId, nav.serverId]);
  const searchAll = useCallback(async (q: string) => (await api.searchUsers(q)).map((u) => userCandidate(u, 'not on this server')), []);

  const close = () => { setDialog(null); setForm({}); setPicked([]); };
  const submit = async () => {
    try {
      if (dialog === 'channel' && nav.serverId) { const c = await api.createChannel(nav.serverId, { name: f('name'), description: f('description'), knowledge_mode: f('mode') || 'isolated' }); await nav.selectServer(nav.serverId); await nav.selectChannel(c.id); }
      if (dialog === 'window' && nav.channelId) {
        if (!f('name').trim()) { toast('Give the window a name', 'error'); return; }
        await api.createWindow(nav.channelId, { name: f('name'), kind: (f('kind') as any) || 'group', members: picked.map((user_id) => ({ user_id })), scene_id: f('scene') || undefined });
        await nav.refreshWindows();
      }
      if (dialog === 'character' && nav.channelId) { await api.createCharacter(nav.channelId, { name: f('name'), kind: (f('kind') as any) || 'pc', speaking_style: f('style'), description: f('description') }); await nav.refreshCharacters(); await nav.refreshWindows(); }
      close();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const invite = async (userId: string, label: string) => {
    if (!nav.channelId) return;
    try {
      await api.addChannelMember(nav.channelId, userId, (f('role') as any) || 'player');
      toast(`Added ${label}`);
      setChannelMembers(await api.channelMembers(nav.channelId));
      await nav.refreshWindows();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const serverName = nav.servers.find((s) => s.id === nav.serverId)?.name;

  return (
    <div className={`channel-sidebar ${open ? 'open' : ''}`}>
      <div className="section"><span>{serverName ?? 'Channels'}</span>
        <span className="row" style={{ gap: 2 }}>
          {nav.serverId && isMaintainer && <button className="ghost small" title="Server settings (maintainers)" onClick={() => setServerSettingsOpen(true)}>⚙</button>}
          {nav.serverId && <button className="ghost small" title="New campaign channel" onClick={() => setDialog('channel')}>+</button>}
        </span>
      </div>
      <div className="sidebar-scroll">
        {nav.channels.map((c) => (
          <div key={c.id} className={`item ${c.id === nav.channelId ? 'active' : ''}`} onClick={() => { nav.selectChannel(c.id); onClose(); }}>
            <span className="muted">#</span><span className="name">{c.name}</span>{c.my_role === 'gm' && <span className="pill gm">GM</span>}
          </div>
        ))}
        {nav.channelId && (
          <>
            <div className="section"><span>Chat windows</span>{isGm && <button className="ghost small" title="New chat window" onClick={() => setDialog('window')}>+</button>}</div>
            {nav.windows.map((w) => (
              <div key={w.id} className={`item ${w.id === nav.windowId && !nav.gmWorkspaceOpen && !nav.studioOpen ? 'active' : ''}`} onClick={() => { nav.selectWindow(w.id); onClose(); }} title={(w.members ?? []).map((m) => m.character_name ?? m.display_name).join(', ')}>
                <span className="muted">{w.kind === 'main' ? '◎' : w.kind === 'private' ? '◌' : '○'}</span><span className="name">{w.name}</span>
                {isGm ? <button className="ghost small member-count" title="Invite or remove members" onClick={(e) => { e.stopPropagation(); setManageWindow(w.id); }}>{(w.members ?? []).length} ⚇</button>
                  : <span className="tiny muted">{(w.members ?? []).length}</span>}
              </div>
            ))}
            <div className="section"><span>Scene</span></div>
            <div className="item" style={{ cursor: 'default' }}>
              <span className="name small">{nav.windows.find((w) => w.id === nav.windowId)?.scene_title ?? nav.channel?.current_scene_title ?? '—'}</span>
            </div>
            <div className="section"><span>Characters</span><button className="ghost small" title="New character" onClick={() => setDialog('character')}>+</button></div>
            {characters.map((c) => (
              <div key={c.id} className="item" onClick={() => setSheetFor(c.id)} title="Open character sheet">
                <span className="name small">{c.name}</span><span className="tiny muted">{c.kind === 'npc' ? 'NPC' : c.player_name ?? ''}</span>
              </div>
            ))}
            <div className="section"><span>Production</span></div>
            <div className={`item ${nav.studioOpen ? 'active' : ''}`} onClick={() => { nav.setStudioOpen(true); onClose(); }}><span>✎</span><span className="name">Log Studio</span></div>
            {isGm && (
              <>
                <div className="section"><span>Game master</span></div>
                <div className={`item ${nav.gmWorkspaceOpen ? 'active' : ''}`} onClick={() => { nav.setGmWorkspaceOpen(true); onClose(); }}><span>⚙</span><span className="name">GM workspace</span></div>
                <div className="item" onClick={() => setDialog('member')}><span>＋</span><span className="name">Invite player</span></div>
              </>
            )}
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{user?.display_name.slice(0, 2).toUpperCase()}</div>
        <div className="grow small"><div>{user?.display_name}</div><div className="tiny muted">@{user?.username}</div></div>
        <button className="ghost small" onClick={logout}>Sign out</button>
      </div>
      {dialog && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal col" onClick={(e) => e.stopPropagation()}>
            {dialog === 'channel' && (<><h3>New campaign channel</h3><input placeholder="Name" value={f('name')} onChange={(e) => set('name', e.target.value)} autoFocus /><input placeholder="Description" value={f('description')} onChange={(e) => set('description', e.target.value)} />
              <select value={f('mode') || 'isolated'} onChange={(e) => set('mode', e.target.value)}><option value="isolated">Character knowledge isolation (Mode B)</option><option value="public">Public knowledge (Mode A)</option></select></>)}
            {dialog === 'window' && (<><h3>New chat window</h3><input placeholder="Name (e.g. Solo investigation)" value={f('name')} onChange={(e) => set('name', e.target.value)} autoFocus />
              <select value={f('kind') || 'group'} onChange={(e) => set('kind', e.target.value)}><option value="group">Group</option><option value="private">Private</option></select>
              <div className="section-label">Members</div>
              <UserPicker mode="select" selected={picked} onToggle={(c) => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                candidates={channelMembers.filter((m) => m.id !== user?.id).map((m) => userCandidate(m, m.characters?.map((c) => c.name).join(', ') || m.role))}
                emptyText="No other channel members match." placeholder="Search channel members…" />
              <select value={f('scene')} onChange={(e) => set('scene', e.target.value)}><option value="">Scene: (channel's current)</option>{nav.scenes.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></>)}
            {dialog === 'member' && (<><h3>Invite to channel</h3>
              <select value={f('role') || 'player'} onChange={(e) => set('role', e.target.value)}><option value="player">as Player</option><option value="gm">as GM</option></select>
              <UserPicker mode="action" actionLabel="Invite" autoFocus
                candidates={serverMembers.map((m) => userCandidate(m))} search={isMaintainer ? searchAll : undefined}
                exclude={channelMembers.map((m) => m.id)} placeholder={isMaintainer ? 'Search server members or any user…' : 'Search server members…'}
                emptyText={isMaintainer ? 'No matching user.' : 'No matching server member — a server maintainer can invite new people to the server.'}
                onAction={(c) => invite(c.id, c.label)} /></>)}
            {dialog === 'character' && (<><h3>New character</h3><input placeholder="Name" value={f('name')} onChange={(e) => set('name', e.target.value)} autoFocus />
              {isGm && <select value={f('kind') || 'pc'} onChange={(e) => set('kind', e.target.value)}><option value="pc">Player character</option><option value="npc">NPC (GM)</option></select>}
              <input placeholder="Speaking style (e.g. terse, formal)" value={f('style')} onChange={(e) => set('style', e.target.value)} /><input placeholder="Description / occupation" value={f('description')} onChange={(e) => set('description', e.target.value)} /></>)}
            <div className="row">
              {dialog === 'member' ? <button className="primary" onClick={close}>Done</button> : <><button className="primary" onClick={submit}>{dialog === 'window' ? `Create${picked.length ? ` with ${picked.length}` : ''}` : 'Save'}</button><button className="ghost" onClick={close}>Cancel</button></>}
            </div>
          </div>
        </div>
      )}
      {manageWindow && <WindowMembersModal windowId={manageWindow} onClose={() => setManageWindow(null)} />}
      {sheetFor && <CharacterSheetModal characterId={sheetFor} onClose={() => setSheetFor(null)} />}
      {serverSettingsOpen && <ServerSettingsModal onClose={() => setServerSettingsOpen(false)} />}
    </div>
  );
}
