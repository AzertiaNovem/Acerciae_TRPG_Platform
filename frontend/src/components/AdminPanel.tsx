import { t as tr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { useAuth } from '../store/auth';
import { useEscape } from '../hooks/useEscape';
import type { AdminAction, AdminOverview, AdminPage, AdminServerDetail, AdminServerRow, AdminUserDetail, AdminUserRow } from '../types';

// The deployment's administration: what it holds (accounts, servers, stored media, the database, AI use), where it is
// used, and the two levers against content or storage abuse: suspending a server or an account, with a reason that is
// kept in the audit log. Nothing here deletes anything.
type Tab = 'overview' | 'servers' | 'users' | 'audit';
const PAGE = 50;

export function formatBytes(n: number | null | undefined): string {
  const b = Number(n ?? 0);
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}
const num = (n: number | null | undefined) => Number(n ?? 0).toLocaleString();
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');
const ACTIONS: Record<string, string> = {
  suspend_user: 'Suspended account', unsuspend_user: 'Reinstated account', suspend_server: 'Suspended server',
  unsuspend_server: 'Reinstated server', grant_admin: 'Granted administrator', revoke_admin: 'Revoked administrator',
};

// Suspending needs a reason; it is shown to the account on sign-in (or to the server's members) and kept in the log.
function ReasonDialog({ title, body, action, danger, reasonRequired, onConfirm, onCancel }: {
  title: string; body: string; action: string; danger?: boolean; reasonRequired: boolean;
  onConfirm: (reason: string) => Promise<void>; onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEscape(busy ? null : onCancel);
  const ok = !reasonRequired || reason.trim().length > 0;
  const confirm = async () => { if (!ok || busy) return; setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal col" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="small">{body}</div>
        <label className="field"><span>{reasonRequired ? tr('Reason (shown to those affected and kept in the audit log)') : tr('Note for the audit log (optional)')}</span>
          <textarea autoFocus rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy}>{tr('Cancel')}</button>
          <button className={danger ? 'danger' : 'primary'} onClick={confirm} disabled={!ok || busy}>{action}</button>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="kpi"><b>{label}</b><span className="v">{value}</span>{sub && <span className="sub">{sub}</span>}</div>;
}

function Overview({ onOpenServers, onOpenUsers }: { onOpenServers: () => void; onOpenUsers: () => void }) {
  const [o, setO] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.adminOverview().then(setO).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>;
  if (!o) return <div className="muted">{tr('Loading…')}</div>;
  const st = o.storage;
  const kinds: [string, number, number][] = [[tr('Images'), st.image_bytes, st.images], [tr('Audio'), st.audio_bytes, st.audio], [tr('PDFs'), st.pdf_bytes, st.pdfs], [tr('Visual novel bundles'), st.bundle_bytes, st.bundles], [tr('Other'), st.other_bytes, st.other]];
  const maxTable = Math.max(1, ...o.database.tables.map((t) => Number(t.bytes)));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="kpis">
        <Kpi label={tr('Accounts')} value={num(o.users.total)} sub={tr('{n} new in 30 days · {s} suspended', { n: num(o.users.new_30d), s: num(o.users.suspended) })} />
        <Kpi label={tr('Signed in (7 days)')} value={num(o.users.signed_in_7d)} sub={tr('{n} active sessions', { n: num(o.users.active_sessions) })} />
        <Kpi label={tr('Servers')} value={num(o.servers.total)} sub={tr('{n} new in 30 days · {s} suspended', { n: num(o.servers.new_30d), s: num(o.servers.suspended) })} />
        <Kpi label={tr('Channels')} value={num(o.servers.channels)} sub={tr('{n} messages, {m} in 7 days', { n: num(o.servers.messages), m: num(o.servers.messages_7d) })} />
        <Kpi label={tr('Stored media')} value={formatBytes(st.bytes)} sub={tr('{n} objects · {s}', { n: num(st.objects), s: st.store })} />
        <Kpi label={tr('Images')} value={formatBytes(st.image_bytes)} sub={tr('{n} images, {m} in 7 days', { n: num(st.images), m: num(st.images_7d) })} />
        <Kpi label={tr('Database')} value={formatBytes(o.database.bytes)} sub={tr('PostgreSQL, all tables and indexes')} />
        <Kpi label={tr('AI (30 days)')} value={num(o.ai.tokens_30d)} sub={tr('tokens · {n} images · {s} servers', { n: num(o.ai.images_30d), s: num(o.ai.servers_30d) })} />
      </div>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="detail" style={{ flex: '1 1 320px' }}>
          <h4 style={{ margin: 0 }}>{tr('Storage by kind')}</h4>
          <table className="simple"><tbody>
            {kinds.map(([k, b, n]) => <tr key={k}><td>{k}</td><td className="num">{num(n)}</td><td className="num">{formatBytes(b)}</td><td style={{ width: '40%' }}><div className="bar"><i style={{ width: `${st.bytes ? (100 * Number(b)) / Number(st.bytes) : 0}%` }} /></div></td></tr>)}
            <tr><td className="muted">{tr('Avatars')}</td><td className="num">{num(st.avatars)}</td><td className="num muted">—</td><td /></tr>
          </tbody></table>
          <div className="row"><button className="small" onClick={onOpenServers}>{tr('Servers by storage')}</button><button className="small" onClick={onOpenUsers}>{tr('Users by storage')}</button></div>
        </div>
        <div className="detail" style={{ flex: '1 1 320px' }}>
          <h4 style={{ margin: 0 }}>{tr('Largest tables')}</h4>
          <table className="simple"><tbody>
            {o.database.tables.map((t) => <tr key={t.name}><td><code>{t.name}</code></td><td className="num">{num(t.rows)}</td><td className="num">{formatBytes(t.bytes)}</td><td style={{ width: '35%' }}><div className="bar"><i style={{ width: `${(100 * Number(t.bytes)) / maxTable}%` }} /></div></td></tr>)}
          </tbody></table>
        </div>
      </div>
      <div className="detail">
        <h4 style={{ margin: 0 }}>{tr('Administrators')}</h4>
        <div className="small">{tr('{n} granted from this panel', { n: num(o.users.admins) })}{o.users.listed_admins.length > 0 && <> · {tr('named in PLATFORM_ADMINS')}: {o.users.listed_admins.map((u) => <code key={u} style={{ marginRight: 6 }}>@{u}</code>)}</>}</div>
        {o.recent_actions.length > 0 && <><h4 style={{ margin: '6px 0 0' }}>{tr('Recent actions')}</h4><Actions rows={o.recent_actions} /></>}
      </div>
    </div>
  );
}

function Actions({ rows }: { rows: AdminAction[] }) {
  return (
    <table className="simple"><tbody>
      {rows.map((a) => <tr key={a.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{when(a.created_at)}</td><td>@{a.admin_name}</td><td>{tr(ACTIONS[a.action] ?? a.action)}</td><td>{a.target_name ? <>{a.target_type === 'user' ? '@' : '#'}{a.target_name}</> : null}</td><td className="muted">{a.reason}</td></tr>)}
    </tbody></table>
  );
}

function Pager({ page, onPage }: { page: AdminPage<unknown> | null; onPage: (offset: number) => void }) {
  if (!page || page.total <= page.limit) return null;
  const from = page.offset + 1, to = Math.min(page.total, page.offset + page.limit);
  return (
    <div className="row small">
      <span className="muted">{tr('{from}–{to} of {total}', { from, to, total: num(page.total) })}</span><span className="grow" />
      <button className="small" disabled={page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>‹</button>
      <button className="small" disabled={to >= page.total} onClick={() => onPage(page.offset + page.limit)}>›</button>
    </div>
  );
}

function Servers({ initialSort, openUser }: { initialSort: string; openUser: (id: string) => void }) {
  const toast = useUi((s) => s.toast);
  const [q, setQ] = useState(''); const [sort, setSort] = useState(initialSort); const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminPage<AdminServerRow> | null>(null);
  const [detail, setDetail] = useState<AdminServerDetail | null>(null);
  const [dialog, setDialog] = useState<AdminServerRow | null>(null);
  const load = useCallback(() => api.adminServers({ q, sort, limit: PAGE, offset }).then(setPage).catch((e) => toast(e.message, 'error')), [q, sort, offset, toast]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const open = (id: string) => api.adminServer(id).then(setDetail).catch((e) => toast(e.message, 'error'));
  const toggle = async (s: AdminServerRow, reason: string) => {
    try {
      await api.adminSuspendServer(s.id, { suspended: !s.suspended, reason });
      toast(s.suspended ? tr('Server reinstated') : tr('Server suspended'));
      setDialog(null); await load(); if (detail?.id === s.id) await open(s.id);
      useNav.getState().loadServers().catch(() => undefined);
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const sorts: [string, string][] = [['storage', 'Storage'], ['images', 'Images'], ['members', 'Members'], ['messages', 'Messages'], ['created', 'Newest'], ['name', 'Name'], ['suspended', 'Suspended first']];
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="toolbar">
        <input placeholder={tr('Search by server or owner…')} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        <select value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}>{sorts.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}</select>
        <span className="grow" /><Pager page={page} onPage={setOffset} />
      </div>
      <table className="simple">
        <thead><tr><th>{tr('Server')}</th><th>{tr('Owner')}</th><th className="num">{tr('Members')}</th><th className="num">{tr('Channels')}</th><th className="num">{tr('Messages')}</th><th className="num">{tr('Images')}</th><th className="num">{tr('Storage')}</th><th className="num">{tr('AI images (30d)')}</th><th>{tr('Last activity')}</th><th /></tr></thead>
        <tbody>
          {page?.rows.map((s) => (
            <tr key={s.id} className={`clickable ${detail?.id === s.id ? 'selected' : ''}`} onClick={() => open(s.id)}>
              <td>{s.name} {s.suspended && <span className="pill danger">{tr('suspended')}</span>}</td>
              <td>{s.owner_username ? <button className="ghost small" onClick={(e) => { e.stopPropagation(); openUser(s.owner_id!); }}>@{s.owner_username}</button> : '—'}</td>
              <td className="num">{num(s.member_count)}</td><td className="num">{num(s.channel_count)}</td><td className="num">{num(s.message_count)}</td>
              <td className="num">{num(s.images)}</td><td className="num"><b>{formatBytes(s.bytes)}</b></td><td className="num">{num(s.ai_images_30d)}</td>
              <td className="muted">{when(s.last_message_at)}</td>
              <td><button className={`small ${s.suspended ? '' : 'danger'}`} onClick={(e) => { e.stopPropagation(); setDialog(s); }}>{s.suspended ? tr('Reinstate') : tr('Suspend')}</button></td>
            </tr>
          ))}
          {page && page.rows.length === 0 && <tr><td colSpan={10} className="muted">{tr('No servers match.')}</td></tr>}
        </tbody>
      </table>
      {detail && (
        <div className="detail">
          <div className="row"><h3 style={{ margin: 0 }}>{detail.name}</h3>{detail.suspended && <span className="pill danger">{tr('suspended')}</span>}<span className="grow" /><button className="ghost small" onClick={() => setDetail(null)}>{tr('Close')}</button></div>
          {detail.suspended && <div className="small" style={{ color: 'var(--danger)' }}>{tr('Suspended {when} by @{who}: {reason}', { when: when(detail.suspended_at), who: detail.suspended_by_name ?? '?', reason: detail.suspended_reason })}</div>}
          <div className="kpis">
            <Kpi label={tr('Owner')} value={detail.owner_username ? `@${detail.owner_username}` : '—'} sub={detail.owner_name ?? undefined} />
            <Kpi label={tr('Created')} value={new Date(detail.created_at).toLocaleDateString()} />
            <Kpi label={tr('Storage')} value={formatBytes(detail.bytes)} sub={tr('{n} objects · {m} images ({b})', { n: num(detail.objects), m: num(detail.images), b: formatBytes(detail.image_bytes) })} />
            <Kpi label={tr('AI (30 days)')} value={num(detail.ai_tokens_30d)} sub={tr('tokens · {n} images', { n: num(detail.ai_images_30d) })} />
          </div>
          <h4 style={{ margin: '4px 0 0' }}>{tr('Channels')}</h4>
          <table className="simple">
            <thead><tr><th>{tr('Channel')}</th><th>{tr('Rules')}</th><th className="num">{tr('Members')}</th><th className="num">{tr('Messages')}</th><th className="num">{tr('Images')}</th><th className="num">{tr('Storage')}</th><th>{tr('Last activity')}</th></tr></thead>
            <tbody>{detail.channels.map((c) => <tr key={c.id}><td>{c.name} {c.story_status === 'ended' && <span className="pill">{tr('ended')}</span>}</td><td className="muted">{c.rule_system}</td><td className="num">{num(c.member_count)}</td><td className="num">{num(c.message_count)}</td><td className="num">{num(c.images)}</td><td className="num">{formatBytes(c.bytes)}</td><td className="muted">{when(c.last_message_at)}</td></tr>)}</tbody>
          </table>
          <h4 style={{ margin: '4px 0 0' }}>{tr('Members')}</h4>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {detail.members.map((m) => <button key={m.id} className="ghost small" onClick={() => openUser(m.id)}>@{m.username} <span className="pill">{tr(m.role)}</span>{m.suspended && <span className="pill danger">{tr('suspended')}</span>}</button>)}
          </div>
          {detail.actions.length > 0 && <><h4 style={{ margin: '4px 0 0' }}>{tr('Actions on this server')}</h4><Actions rows={detail.actions} /></>}
        </div>
      )}
      {dialog && (
        <ReasonDialog
          title={dialog.suspended ? tr('Reinstate server {name}?', { name: dialog.name }) : tr('Suspend server {name}?', { name: dialog.name })}
          body={dialog.suspended
            ? tr('Its members can open it again, and its published logs come back.')
            : tr('Its members keep their accounts, but nothing inside the server can be opened: channels, characters, logs and published links. Open sockets are closed. Nothing is deleted.')}
          action={dialog.suspended ? tr('Reinstate') : tr('Suspend')} danger={!dialog.suspended} reasonRequired={!dialog.suspended}
          onConfirm={(reason) => toggle(dialog, reason)} onCancel={() => setDialog(null)} />
      )}
    </div>
  );
}

function Users({ initialSort, openServer, focusId }: { initialSort: string; openServer: (id: string) => void; focusId: string | null }) {
  const toast = useUi((s) => s.toast);
  const me = useAuth((s) => s.user);
  const [q, setQ] = useState(''); const [sort, setSort] = useState(initialSort); const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminPage<AdminUserRow> | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [dialog, setDialog] = useState<{ user: AdminUserRow; kind: 'suspend' | 'admin' } | null>(null);
  const load = useCallback(() => api.adminUsers({ q, sort, limit: PAGE, offset }).then(setPage).catch((e) => toast(e.message, 'error')), [q, sort, offset, toast]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const open = useCallback((id: string) => api.adminUser(id).then(setDetail).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { if (focusId) open(focusId); }, [focusId, open]);
  const act = async (u: AdminUserRow, kind: 'suspend' | 'admin', reason: string) => {
    try {
      if (kind === 'suspend') { await api.adminSuspendUser(u.id, { suspended: !u.suspended, reason }); toast(u.suspended ? tr('Account reinstated') : tr('Account suspended')); }
      else { await api.adminSetAdmin(u.id, { admin: !u.is_admin, reason }); toast(u.is_admin ? tr('Administrator role revoked') : tr('Administrator role granted')); }
      setDialog(null); await load(); if (detail?.id === u.id) await open(u.id);
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const sorts: [string, string][] = [['created', 'Newest'], ['storage', 'Storage'], ['images', 'Images'], ['last_seen', 'Last seen'], ['servers', 'Servers'], ['name', 'Name'], ['suspended', 'Suspended first']];
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="toolbar">
        <input placeholder={tr('Search by username or name…')} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        <select value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}>{sorts.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}</select>
        <span className="grow" /><Pager page={page} onPage={setOffset} />
      </div>
      <table className="simple">
        <thead><tr><th>{tr('User')}</th><th>{tr('Joined')}</th><th>{tr('Last seen')}</th><th className="num">{tr('Servers')}</th><th className="num">{tr('Messages')}</th><th className="num">{tr('Images')}</th><th className="num">{tr('Storage')}</th><th /></tr></thead>
        <tbody>
          {page?.rows.map((u) => (
            <tr key={u.id} className={`clickable ${detail?.id === u.id ? 'selected' : ''}`} onClick={() => open(u.id)}>
              <td>@{u.username} <span className="muted">{u.display_name}</span> {u.is_admin && <span className="pill gm">{tr('admin')}</span>} {u.suspended && <span className="pill danger">{tr('suspended')}</span>}</td>
              <td className="muted">{new Date(u.created_at).toLocaleDateString()}</td><td className="muted">{when(u.last_seen_at)}</td>
              <td className="num">{num(u.server_count)}{u.owned_count > 0 && <span className="muted"> ({tr('{n} owned', { n: num(u.owned_count) })})</span>}</td>
              <td className="num">{num(u.message_count)}</td><td className="num">{num(u.images)}</td><td className="num"><b>{formatBytes(u.bytes)}</b></td>
              <td><span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                {u.id !== me?.id && !u.listed_admin && <button className={`small ${u.suspended ? '' : 'danger'}`} onClick={(e) => { e.stopPropagation(); setDialog({ user: u, kind: 'suspend' }); }}>{u.suspended ? tr('Reinstate') : tr('Suspend')}</button>}
                {u.id !== me?.id && !u.listed_admin && <button className="ghost small" onClick={(e) => { e.stopPropagation(); setDialog({ user: u, kind: 'admin' }); }}>{u.is_admin ? tr('Revoke admin') : tr('Make admin')}</button>}
              </span></td>
            </tr>
          ))}
          {page && page.rows.length === 0 && <tr><td colSpan={8} className="muted">{tr('No users match.')}</td></tr>}
        </tbody>
      </table>
      {detail && (
        <div className="detail">
          <div className="row"><h3 style={{ margin: 0 }}>@{detail.username}</h3><span className="muted">{detail.display_name}</span>{detail.is_admin && <span className="pill gm">{detail.listed_admin ? 'PLATFORM_ADMINS' : tr('admin')}</span>}{detail.suspended && <span className="pill danger">{tr('suspended')}</span>}<span className="grow" /><button className="ghost small" onClick={() => setDetail(null)}>{tr('Close')}</button></div>
          {detail.suspended && <div className="small" style={{ color: 'var(--danger)' }}>{tr('Suspended {when} by @{who}: {reason}', { when: when(detail.suspended_at), who: detail.suspended_by_name ?? '?', reason: detail.suspended_reason })}</div>}
          <div className="kpis">
            <Kpi label={tr('Joined')} value={new Date(detail.created_at).toLocaleDateString()} sub={tr('last seen {when}', { when: when(detail.last_seen_at) })} />
            <Kpi label={tr('Sessions')} value={num(detail.sessions)} />
            <Kpi label={tr('Storage')} value={formatBytes(detail.bytes)} sub={tr('{n} objects · {m} images ({b})', { n: num(detail.objects), m: num(detail.images), b: formatBytes(detail.image_bytes) })} />
            <Kpi label={tr('Messages')} value={num(detail.message_count)} sub={tr('{n} characters', { n: num(detail.character_count) })} />
          </div>
          <h4 style={{ margin: '4px 0 0' }}>{tr('Servers')}</h4>
          <table className="simple">
            <thead><tr><th>{tr('Server')}</th><th>{tr('Role')}</th><th className="num">{tr('Channels')}</th><th>{tr('Joined')}</th><th /></tr></thead>
            <tbody>{detail.servers.map((s) => <tr key={s.id}><td>{s.name} {s.suspended && <span className="pill danger">{tr('suspended')}</span>}</td><td>{tr(s.role)}</td><td className="num">{num(s.channel_count)}</td><td className="muted">{new Date(s.joined_at).toLocaleDateString()}</td><td><button className="ghost small" onClick={() => openServer(s.id)}>{tr('Open')}</button></td></tr>)}</tbody>
          </table>
          {detail.actions.length > 0 && <><h4 style={{ margin: '4px 0 0' }}>{tr('Actions on this account')}</h4><Actions rows={detail.actions} /></>}
        </div>
      )}
      {dialog?.kind === 'suspend' && (
        <ReasonDialog
          title={dialog.user.suspended ? tr('Reinstate @{name}?', { name: dialog.user.username }) : tr('Suspend @{name}?', { name: dialog.user.username })}
          body={dialog.user.suspended ? tr('The account can sign in again.') : tr('Every session of the account ends now and it cannot sign in; the reason is shown when it tries. Its characters, messages and media stay where they are.')}
          action={dialog.user.suspended ? tr('Reinstate') : tr('Suspend')} danger={!dialog.user.suspended} reasonRequired={!dialog.user.suspended}
          onConfirm={(reason) => act(dialog.user, 'suspend', reason)} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'admin' && (
        <ReasonDialog
          title={dialog.user.is_admin ? tr('Revoke the administrator role of @{name}?', { name: dialog.user.username }) : tr('Make @{name} a platform administrator?', { name: dialog.user.username })}
          body={dialog.user.is_admin ? tr('They lose this panel and the power to suspend.') : tr('They can inspect every server and account, suspend them, and grant this role to others.')}
          action={dialog.user.is_admin ? tr('Revoke admin') : tr('Make admin')} reasonRequired={false}
          onConfirm={(reason) => act(dialog.user, 'admin', reason)} onCancel={() => setDialog(null)} />
      )}
    </div>
  );
}

function Audit() {
  const toast = useUi((s) => s.toast);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminPage<AdminAction> | null>(null);
  useEffect(() => { api.adminActions({ limit: PAGE, offset }).then(setPage).catch((e) => toast(e.message, 'error')); }, [offset, toast]);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="toolbar"><span className="small muted">{tr('Every suspension, reinstatement and administrator change, with who did it and why.')}</span><span className="grow" /><Pager page={page} onPage={setOffset} /></div>
      {page && (page.rows.length ? <Actions rows={page.rows} /> : <div className="muted">{tr('No actions yet.')}</div>)}
    </div>
  );
}

export default function AdminPanel() {
  const setAdminOpen = useNav((s) => s.setAdminOpen);
  const [tab, setTab] = useState<Tab>('overview');
  const [serverSort, setServerSort] = useState('storage');
  const [userSort, setUserSort] = useState('created');
  const [focusUser, setFocusUser] = useState<string | null>(null);
  const [focusServer, setFocusServer] = useState<string | null>(null);
  const openUser = (id: string) => { setFocusUser(id); setTab('users'); };
  const openServer = (id: string) => { setFocusServer(id); setTab('servers'); };
  const tabs: [Tab, string][] = [['overview', 'Overview'], ['servers', 'Servers'], ['users', 'Users'], ['audit', 'Audit log']];
  return (
    <div className="admin-panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>🛡 {tr('Platform administration')}</h2>
        <div className="tabs inline">{tabs.map(([t, l]) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(l)}</button>)}</div>
        <span className="grow" />
        <button className="ghost small" onClick={() => setAdminOpen(false)}>← {tr('back to chat')}</button>
      </div>
      {tab === 'overview' && <Overview onOpenServers={() => { setServerSort('storage'); setTab('servers'); }} onOpenUsers={() => { setUserSort('storage'); setTab('users'); }} />}
      {tab === 'servers' && <Servers key={serverSort + (focusServer ?? '')} initialSort={serverSort} openUser={openUser} />}
      {tab === 'users' && <Users key={userSort} initialSort={userSort} openServer={openServer} focusId={focusUser} />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
