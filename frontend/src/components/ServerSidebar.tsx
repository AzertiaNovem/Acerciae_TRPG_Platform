import { t as tr } from '../i18n';
import { activate } from '../lib/a11y';
import { useEscape } from '../hooks/useEscape';
import { useEffect, useState } from 'react';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { api } from '../api/client';
import type { DirectoryServer, InvitePreview } from '../types';
import { isDesktop } from '../lib/platform';
import { useOpenStudio } from '../openstudio/ui/state';

// An invite link is `…?invite=CODE`; people may also paste the bare code.
const codeOf = (text: string) => { const t = text.trim(); try { return new URL(t).searchParams.get('invite') ?? t; } catch { return t.split('invite=').pop() ?? t; } };

function JoinServer({ initialCode, onJoined }: { initialCode: string; onJoined: (id: string) => void }) {
  const toast = useUi((s) => s.toast);
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [directory, setDirectory] = useState<DirectoryServer[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const c = codeOf(code); setPreview(null); setPreviewError('');
    if (c.length < 6) return;
    let active = true;
    const timer = setTimeout(() => api.previewInvite(c).then((p) => active && setPreview(p)).catch(() => active && setPreviewError(tr('No such invite.'))), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [code]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => api.serverDirectory(query).then((d) => active && setDirectory(d)).catch(() => undefined), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  const run = async (fn: () => Promise<{ id: string }>) => { try { const s = await fn(); onJoined(s.id); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="col">
      <div className="section-label">{tr("Invite link or code")}</div>
      <input placeholder={tr("Paste an invite link or code")} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      {previewError && <div className="tiny muted">{previewError}</div>}
      {preview && (
        <div className="pick-row">
          <span className="grow">{preview.name} <span className="tiny muted" title={tr("members")}>· 👥 {preview.member_count}</span></span>
          {preview.already_member ? <button className="small" onClick={() => onJoined(preview.server_id)}>{tr("Open")}</button>
            : preview.valid ? <button className="primary small" onClick={() => run(() => api.acceptInvite(codeOf(code)))}>{tr("Join")}</button>
            : <span className="pill">{tr("This invite no longer works")}</span>}
        </div>
      )}
      <div className="section-label">{tr("Open servers")}</div>
      <input placeholder={tr("Search open servers…")} value={query} onChange={(e) => setQuery(e.target.value)} />
      {directory.length === 0 && <div className="tiny muted">{tr("No open servers found.")}</div>}
      {directory.map((s) => (
        <div key={s.id} className="pick-row">
          <span className="grow">{s.name} <span className="tiny muted" title={tr("members")}>· 👥 {s.member_count}</span></span>
          <button className="small" onClick={() => run(() => api.joinServer(s.id))}>{tr("Join")}</button>
        </div>
      ))}
    </div>
  );
}

export default function ServerSidebar({ onPick }: { onPick: () => void }) {
  const { servers, serverId, selectServer, loadServers } = useNav();
  const [dialog, setDialog] = useState<null | 'create' | 'join'>(null);
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  // Opening the app from an invite link starts the join dialog with that code.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('invite');
    if (!code) return;
    setInviteCode(code); setDialog('join');
    const url = new URL(location.href); url.searchParams.delete('invite'); history.replaceState(null, '', url.toString());
  }, []);
  const toast = useUi((s) => s.toast);
  const create = async () => {
    if (!name.trim()) return;
    try { const s = await api.createServer(name.trim()); setName(''); setDialog(null); await loadServers(); await selectServer(s.id); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  useEscape(dialog ? () => setDialog(null) : null);
  const joined = async (id: string) => { setDialog(null); setInviteCode(''); await loadServers(); await selectServer(id); onPick(); };
  return (
    <div className="server-sidebar">
      {servers.map((s) => (
        <div key={s.id} className={`server-icon ${s.id === serverId ? 'active' : ''}`} title={s.my_role === 'guest' ? `${s.name} (${tr("guest")})` : s.name} aria-label={s.name} {...activate(() => { selectServer(s.id); onPick(); })}>{s.name.slice(0, 2).toUpperCase()}</div>
      ))}
      <div className="server-icon add" title={tr("Create or join a server")} aria-label={tr("Create or join a server")} {...activate(() => setDialog('create'))}>+</div>
      {isDesktop && <div className="server-icon studio" title={tr('Open Log Studio')} aria-label={tr('Open Log Studio')} {...activate(() => useOpenStudio.getState().setOpen(true))}>✎</div>}
      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal col" role="dialog" aria-modal="true" aria-label={tr("Create or join a server")} onClick={(e) => e.stopPropagation()}>
            <div className="tabs inline">
              <button className={dialog === 'create' ? 'active' : ''} onClick={() => setDialog('create')}>{tr("New server")}</button>
              <button className={dialog === 'join' ? 'active' : ''} onClick={() => setDialog('join')}>{tr("Join a server")}</button>
            </div>
            {dialog === 'create' ? (<>
              <input placeholder={tr("Server name")} value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && create()} />
              <div className="row"><button className="primary" onClick={create}>{tr("Create")}</button><button className="ghost" onClick={() => setDialog(null)}>{tr("Cancel")}</button></div>
            </>) : (<>
              <JoinServer initialCode={inviteCode} onJoined={joined} />
              <div className="row"><span className="grow" /><button className="ghost" onClick={() => setDialog(null)}>{tr("Close")}</button></div>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}
