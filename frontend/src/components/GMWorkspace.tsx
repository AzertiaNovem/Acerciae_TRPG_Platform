import { t as tr, currentLocale } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import ModuleImportPanel from './ModuleImportPanel';
import SceneManager from './SceneManager';
import type { Proposal, ModuleHint, AiJob, ChannelMember, DiceTextGroup } from '../types';
import { useAuth } from '../store/auth';
import { LANGUAGE_LABELS } from './ServerSettingsModal';

type Tab = 'overview' | 'module' | 'scenes' | 'knowledge' | 'settings';

function Overview() {
  const { channelId } = useNav();
  const { toast, showEvidence } = useUi();
  const [ws, setWs] = useState<any | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const load = async () => { if (!channelId) return; const [w, s] = await Promise.all([api.gmWorkspace(channelId), api.aiStatus(channelId)]); setWs(w); setStatus(s); };
  useEffect(() => { load().catch(() => undefined); const t = setInterval(() => load().catch(() => undefined), 10000); return () => clearInterval(t); }, [channelId]);
  if (!ws) return <div className="muted">{tr("Loading…")}</div>;
  const decideProposal = async (p: Proposal, accept: boolean) => { if (!channelId) return; try { await api.decideProposal(channelId, p.id, accept); toast(accept ? 'Proposal accepted' : 'Proposal rejected'); load(); } catch (e: any) { toast(e.message, 'error'); } };
  const decideHint = async (h: ModuleHint, d: 'accepted' | 'dismissed') => { if (!channelId) return; await api.decideHint(channelId, h.id, d); load(); };
  const describeOp = (op: any) => op.op === 'share_knowledge' ? `Share knowledge of a fact with ${(op.character_ids ?? []).length} character(s): ${op.reason ?? ''}` : `${op.op}${op.status ? ` → ${op.status}` : ''}${op.summary ? `: ${op.summary}` : ''}${op.previous ? ` (was: “${op.previous}” [${op.previous_status ?? ''}])` : ''}`;
  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h3>{tr("AI observer")}</h3>
          <div className="small">{tr("Mode: ")}<span className={`pill ${status?.llm?.mode === 'mock' ? '' : 'ok'}`}>{status?.llm?.mode} · {status?.llm?.model}</span></div>
          <div className="small muted" style={{ marginTop: 4 }}>{tr("Scans every ")}{status?.interval_ms / 1000}{tr("s; consolidates every ")}{status?.consolidate_interval_ms / 1000}{tr("s. Ticks: ")}{status?.ticks}{tr(", groups processed: ")}{status?.groups_processed}{tr(", LLM calls: ")}{status?.llm_calls}.</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="small" onClick={() => channelId && api.observeNow(channelId).then((r) => { toast(`Observer ran: ${r.jobs.length} group(s)`); load(); })}>{tr("Run observer now")}</button>
            <button className="small" onClick={() => channelId && api.consolidateNow(channelId).then(() => { toast('Consolidation ran'); load(); })}>{tr("Consolidate now")}</button>
          </div>
          <table className="simple" style={{ marginTop: 8 }}><thead><tr><th>{tr("job")}</th><th>{tr("status")}</th><th>{tr("events")}</th><th>{tr("LLM")}</th><th>{tr("when")}</th></tr></thead><tbody>
            {(ws.recent_jobs as AiJob[]).slice(0, 8).map((j) => <tr key={j.id}><td>{j.kind} <span className="tiny muted">{j.group_key.slice(0, 8)}</span></td><td><span className={`pill ${j.status === 'failed' ? 'danger' : j.status === 'succeeded' ? 'ok' : ''}`}>{tr(j.status)}</span>{j.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{j.error}</div>}</td><td>{j.event_count}</td><td>{j.llm_calls}</td><td className="tiny muted">{new Date(j.started_at).toLocaleTimeString(currentLocale())}</td></tr>)}
          </tbody></table>
        </div>
        <div className="card">
          <h3>{tr("Pending AI proposals ")}<span className="pill">{ws.pending_proposals.length}</span></h3>
          <div className="tiny muted">{tr("Contradictions with confirmed records, edits to GM-authored entries and knowledge-sharing suggestions wait here instead of being applied silently.")}</div>
          {ws.pending_proposals.length === 0 && <div className="muted small" style={{ marginTop: 6 }}>{tr("Nothing pending.")}</div>}
          {(ws.pending_proposals as Proposal[]).map((p) => (
            <div key={p.id} className="node">
              <div className="row"><span className="pill">{p.doc_type ?? tr("knowledge")}</span><span className="tiny muted">{p.rejection_reason}</span><span className="grow" />{p.source_event_ids?.length > 0 && <button className="ghost small" onClick={() => showEvidence(p.source_event_ids)}>{tr("events")}</button>}</div>
              {p.ops.map((op, i) => <div key={i} className="small" style={{ marginTop: 4 }}>{describeOp(op)}</div>)}
              <div className="row" style={{ marginTop: 6 }}><button className="primary small" onClick={() => decideProposal(p, true)}>{tr("Accept")}</button><button className="small" onClick={() => decideProposal(p, false)}>{tr("Reject")}</button></div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>{tr("Potential associations ")}<span className="pill">{ws.pending_hints.length}</span></h3>
          <div className="tiny muted">{tr("Raised when play touches or leaves module content. These are prompts, never facts.")}</div>
          {(ws.pending_hints as ModuleHint[]).map((h) => (
            <div key={h.id} className="node">
              <div className="small">{h.reason}</div>
              <div className="row" style={{ marginTop: 4 }}><span className="tiny muted">{h.node_type} · {h.node_name}</span><span className="grow" />{h.source_event_ids?.length > 0 && <button className="ghost small" onClick={() => showEvidence(h.source_event_ids)}>{tr("events")}</button>}<button className="ghost small" onClick={() => decideHint(h, 'accepted')}>{tr("mark revealed")}</button><button className="ghost small" onClick={() => decideHint(h, 'dismissed')}>{tr("dismiss")}</button></div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>{tr("Module progress")}</h3>
          {ws.node_progress.length === 0 && <div className="muted small">{tr("No module imported yet.")}</div>}
          <table className="simple"><tbody>{ws.node_progress.map((r: any, i: number) => <tr key={i}><td>{r.node_type}</td><td><span className="pill">{r.progress}</span></td><td>{r.n}</td></tr>)}</tbody></table>
          <h3 style={{ marginTop: 12 }}>{tr("Scenes vs module")}</h3>
          <table className="simple"><tbody>{ws.scenes.map((s: any) => <tr key={s.id}><td>{s.title}<div className="tiny muted">{s.location}</div></td><td>{s.off_module ? <span className="pill danger">{tr("off module")}</span> : <span className="pill ok">{s.module_node_name ?? tr("on module")}</span>}</td><td className="tiny muted">{s.event_count}{tr(" events")}</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="card">
        <h3>{tr("GM-only knowledge ")}<span className="pill gm">{ws.gm_secrets.length}</span></h3>
        <div className="tiny muted">{tr("Facts no player character knows. Share them from the Knowledge tab when the fiction reveals them.")}</div>
        {ws.gm_secrets.slice(0, 20).map((f: any) => <div key={f.id} className="small" style={{ marginTop: 4 }}><span className="pill">{f.kind}</span> <span className={`status-${tr(f.status)}`}>{tr(f.status)}</span> · {f.summary}</div>)}
      </div>
    </div>
  );
}

function Knowledge() {
  const { channelId, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const [facts, setFacts] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [scope, setScope] = useState<{ scope: string; character_ids: string[] }>({ scope: 'gm', character_ids: [] });
  const load = () => { if (channelId) api.facts(channelId, undefined, query || undefined).then(setFacts); };
  useEffect(load, [channelId]);
  const pcs = characters.filter((c) => c.kind === 'pc');
  const startEdit = async (f: any) => { if (!channelId) return; setEditing(f.id); setScope(await api.factVisibility(channelId, f.id)); };
  const save = async () => { if (!channelId || !editing) return; try { await api.setFactVisibility(channelId, editing, scope); toast('Knowledge scope updated'); setEditing(null); load(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="card">
      <h3>{tr("Fact–knower mapping")}</h3>
      <div className="row"><input placeholder={tr("search facts")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} /><button className="small" onClick={load}>{tr("Search")}</button></div>
      <table className="simple" style={{ marginTop: 8 }}><thead><tr><th>{tr("kind")}</th><th>{tr("fact")}</th><th>{tr("status")}</th><th>{tr("who knows")}</th><th /></tr></thead><tbody>
        {facts.map((f) => {
          const vis = (f.visibility ?? []) as { scope: string; character_id: string | null }[];
          const label = vis.some((v) => v.scope === 'public') ? 'everyone' : vis.filter((v) => v.scope === 'character').map((v) => characters.find((c) => c.id === v.character_id)?.name ?? '?').join(', ') || 'GM only';
          return (
            <tr key={f.id}><td>{f.kind}</td><td className="small">{f.summary}</td><td><span className={`status-${tr(f.status)}`}>{tr(f.status)}</span></td>
              <td className="small">{editing === f.id ? (
                <div className="col">
                  <select value={scope.scope} onChange={(e) => setScope({ ...scope, scope: e.target.value })}><option value="gm">{tr("GM only")}</option><option value="public">{tr("Everyone")}</option><option value="character">{tr("Specific characters")}</option></select>
                  {scope.scope === 'character' && pcs.map((c) => <label key={c.id} className="row tiny"><input type="checkbox" checked={scope.character_ids.includes(c.id)} onChange={(e) => setScope({ ...scope, character_ids: e.target.checked ? [...scope.character_ids, c.id] : scope.character_ids.filter((x) => x !== c.id) })} />{c.name}</label>)}
                  <div className="row"><button className="primary small" onClick={save}>{tr("Save")}</button><button className="ghost small" onClick={() => setEditing(null)}>{tr("Cancel")}</button></div>
                </div>) : label}</td>
              <td>{editing !== f.id && <button className="ghost small" onClick={() => startEdit(f)}>{tr("edit")}</button>}</td></tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

function ChannelSettings() {
  const { channelId, channel, serverId, serverSettings, refreshChannel, refreshWindows } = useNav();
  const me = useAuth((s) => s.user);
  const toast = useUi((s) => s.toast);
  const [groups, setGroups] = useState<DiceTextGroup[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [form, setForm] = useState({ name: '', description: '', knowledge_mode: 'isolated', ai_enabled: true, dice_text_group: '' });
  useEffect(() => { if (channel) setForm({ name: channel.name, description: channel.description, knowledge_mode: channel.knowledge_mode, ai_enabled: channel.ai_enabled, dice_text_group: channel.dice_text_group ?? '' }); }, [channel]);
  useEffect(() => {
    if (serverId) api.diceTextGroups(serverId).then(setGroups).catch(() => undefined);
    if (channelId) api.channelMembers(channelId).then(setMembers).catch(() => undefined);
  }, [serverId, channelId]);
  if (!channelId || !channel) return null;
  const save = async () => { try { await api.updateChannel(channelId, form as any); await refreshChannel(); toast('Channel settings saved'); } catch (e: any) { toast(e.message, 'error'); } };
  const remove = async (m: ChannelMember) => {
    if (!confirm(`Remove ${m.display_name} from this channel? They leave every chat window here; their characters stay.`)) return;
    try { setMembers(await api.removeChannelMember(channelId, m.id)); await refreshWindows(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const lang = serverSettings?.language ?? 'en';
  const diceOn = serverSettings?.features?.dice !== false;
  return (
    <div className="grid-2">
      <div className="card col">
        <h3>{tr("Channel")}</h3>
        <label className="field"><span>{tr("Name")}</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>{tr("Description")}</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="field"><span>{tr("Knowledge mode")}</span>
          <select value={form.knowledge_mode} onChange={(e) => setForm({ ...form, knowledge_mode: e.target.value })}><option value="isolated">{tr("Character knowledge isolation (Mode B)")}</option><option value="public">{tr("Public knowledge (Mode A)")}</option></select>
        </label>
        <label className="row small"><input type="checkbox" checked={form.ai_enabled} onChange={(e) => setForm({ ...form, ai_enabled: e.target.checked })} />{tr("Background chronicler enabled")}</label>
        <label className="field"><span>{tr("Dice reply texts")}</span>
          <select value={form.dice_text_group} onChange={(e) => setForm({ ...form, dice_text_group: e.target.value })} disabled={!diceOn}>
            <option value="">{tr("Follow server language (")}{LANGUAGE_LABELS[lang] ?? lang})</option>
            <option value="builtin:en">{tr("Built-in · English")}</option>
            <option value="builtin:zh">{tr("Built-in · 中文")}</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div className="tiny muted">{diceOn ? tr("Server maintainers add custom text groups in Server settings → Dice texts.") : tr("Integrated dice are turned off for this server.")}</div>
        <div className="row"><span className="grow" /><button className="primary" onClick={save}>{tr("Save")}</button></div>
      </div>
      <div className="card">
        <h3>{tr("Channel members ")}<span className="pill">{members.length}</span></h3>
        <div className="tiny muted" style={{ marginBottom: 6 }}>{tr("Invite people with “Invite player” in the sidebar; manage who is in each chat window with the ⚇ button next to it.")}</div>
        {members.map((m) => (
          <div key={m.id} className="pick-row">
            <span className="grow">{m.display_name} <span className="tiny muted">@{m.username}{m.characters?.length ? ` · ${m.characters.map((c) => c.name).join(', ')}` : ''}</span></span>
            <span className={`pill ${m.role === 'gm' ? 'gm' : ''}`}>{tr(m.role)}</span>
            {m.id !== me?.id && <button className="small" onClick={() => remove(m)}>{tr("Remove")}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function GMWorkspace() {
  const [tab, setTab] = useState<Tab>('overview');
  const setOpen = useNav((s) => s.setGmWorkspaceOpen);
  return (
    <div className="workspace">
      <div className="tabs">
        {(['overview', 'module', 'scenes', 'knowledge', 'settings'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(t[0].toUpperCase() + t.slice(1))}</button>)}
        <span className="grow" /><button className="ghost" onClick={() => setOpen(false)}>{tr("← back to chat")}</button>
      </div>
      <div className="content">
        {tab === 'overview' && <Overview />}
        {tab === 'module' && <ModuleImportPanel />}
        {tab === 'scenes' && <SceneManager />}
        {tab === 'knowledge' && <Knowledge />}
        {tab === 'settings' && <ChannelSettings />}
      </div>
    </div>
  );
}
