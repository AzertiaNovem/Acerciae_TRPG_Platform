import { t as tr, currentLocale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import ModuleImportPanel from './ModuleImportPanel';
import SceneManager from './SceneManager';
import ScriptKnowledgePanel from './ScriptKnowledgePanel';
import KnowledgeWorkspace, { PlayerGroups } from './KnowledgeWorkspace';
import type { Proposal, ModuleHint, AiJob, ChannelMember, DiceTextGroup } from '../types';
import { useAuth } from '../store/auth';
import { LANGUAGE_LABELS } from './ServerSettingsModal';

type Tab = 'overview' | 'module' | 'script' | 'scenes' | 'knowledge' | 'settings';

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
          <div className="tiny muted">{tr("Contradictions and edits to KP records wait here for review.")}</div>
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
        <div className="tiny muted">{tr("KP memory is never copied into a player group. Reveal information through chat.")}</div>
        {ws.gm_secrets.slice(0, 20).map((f: any) => <div key={f.id} className="small" style={{ marginTop: 4 }}><span className="pill">{f.kind}</span> <span className={`status-${f.status}`}>{tr(f.status)}</span> · {f.summary}</div>)}
      </div>
    </div>
  );
}

function ChannelSettings() {
  const { channelId, channel, serverId, serverSettings, refreshChannel, refreshWindows } = useNav();
  const me = useAuth((s) => s.user);
  const toast = useUi((s) => s.toast);
  const [groups, setGroups] = useState<DiceTextGroup[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const blank = { name: '', description: '', knowledge_mode: 'isolated', ai_enabled: true, dice_text_group: '', era: '', studio_visible: true, studio_player_access: true };
  const [form, setFormState] = useState(blank);
  const [dirty, setDirty] = useState(false);
  const setForm = (f: typeof blank) => { setFormState(f); setDirty(true); };
  const [revealKeeper, setRevealKeeper] = useState(false);
  // Refill from the channel when it changes — but never over edits the Keeper has not saved yet.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!channel || (dirty && loadedFor.current === channel.id)) return;
    loadedFor.current = channel.id; setDirty(false);
    setFormState({ name: channel.name, description: channel.description, knowledge_mode: channel.knowledge_mode, ai_enabled: channel.ai_enabled, dice_text_group: channel.dice_text_group ?? '', era: channel.era ?? '', studio_visible: channel.studio_visible !== false, studio_player_access: channel.studio_player_access !== false });
  }, [channel, dirty]);
  useEffect(() => {
    if (serverId) api.diceTextGroups(serverId).then(setGroups).catch(() => undefined);
    if (channelId) api.channelMembers(channelId).then(setMembers).catch(() => undefined);
  }, [serverId, channelId]);
  if (!channelId || !channel) return null;
  const save = async () => { try { await api.updateChannel(channelId, form as any); setDirty(false); await refreshChannel(); toast('Channel settings saved'); } catch (e: any) { toast(e.message, 'error'); } };
  const ended = channel.story_status === 'ended';
  const endStory = async () => {
    if (!confirm(tr('End the story? Every member of this channel will be able to read the whole story in the Log Studio.'))) return;
    try { await api.endStory(channelId, revealKeeper); await refreshChannel(); toast('The story has ended'); } catch (e: any) { toast(e.message, 'error'); }
  };
  const reopenStory = async () => { try { await api.reopenStory(channelId); await refreshChannel(); toast('The story is open again'); } catch (e: any) { toast(e.message, 'error'); } };
  const remove = async (m: ChannelMember) => {
    if (!confirm(tr('Remove {name} from this channel? They leave every chat window here; their characters stay.', { name: m.display_name }))) return;
    try { setMembers(await api.removeChannelMember(channelId, m.id)); await refreshWindows(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const lang = serverSettings?.language ?? 'en';
  const diceOn = serverSettings?.features?.dice !== false;
  const studioAllowed = serverSettings?.features?.log_studio;
  return (
    <div className="grid-2">
      <div className="card col">
        <h3>{tr("Channel")}</h3>
        <label className="field"><span>{tr("Name")}</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>{tr("Description")}</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="field"><span>{tr("Knowledge mode")}</span>
          <select value={form.knowledge_mode} onChange={(e) => setForm({ ...form, knowledge_mode: e.target.value })}><option value="isolated">{tr("New players: separate groups")}</option><option value="public">{tr("New players: shared group")}</option></select>
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
        <label className="field"><span>{tr("Era")}</span><input value={form.era} maxLength={80} placeholder={tr("e.g. 1920s New England")} onChange={(e) => setForm({ ...form, era: e.target.value })} /></label>
        <div className="tiny muted">{tr("The image AI uses the era for portraits and backgrounds.")}</div>
        <label className="row small"><input type="checkbox" checked={form.studio_visible} onChange={(e) => setForm({ ...form, studio_visible: e.target.checked })} disabled={studioAllowed === false} />{tr("Log Studio available in this channel")}</label>
        <div className="tiny muted">{studioAllowed === false ? tr("The server maintainer has turned the Log Studio off for this server.") : tr("When it is on, every member can read the campaign log in their own scope, export it, and make PDFs or visual novels from it.")}</div>
        <label className="row small"><input type="checkbox" checked={form.studio_player_access} onChange={(e) => setForm({ ...form, studio_player_access: e.target.checked })} disabled={studioAllowed === false || !form.studio_visible} />{tr("Players may open the Log Studio before the story ends")}</label>
        <div className="row"><span className="grow" /><button className="primary" onClick={save}>{tr("Save")}</button></div>
      </div>
      <div className="card col">
        <h3>{tr("Story")} <span className={`pill ${ended ? 'ok' : ''}`}>{ended ? tr("ended") : tr("ongoing")}</span></h3>
        {ended ? (<>
          <div className="small">{channel.story_reveal_all ? tr("Every member can read the whole story in the Log Studio, Keeper-only lines included.") : tr("Every member can read the whole story in the Log Studio. Keeper-only lines stay with you.")}</div>
          <div className="row"><span className="grow" /><button onClick={reopenStory}>{tr("Reopen the story")}</button></div>
        </>) : (<>
          <div className="tiny muted">{tr("When the story ends, the Log Studio opens to every member and the campaign log shows them the whole story: every chat window, whispers and hidden rolls, and the scenario titles.")}</div>
          <label className="row small"><input type="checkbox" checked={revealKeeper} onChange={(e) => setRevealKeeper(e.target.checked)} />{tr("Also reveal Keeper-only lines")}</label>
          <div className="row"><span className="grow" /><button className="primary" onClick={endStory}>{tr("End the story")}</button></div>
        </>)}
      </div>
      <PlayerGroups />
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
        {(['overview', 'module', 'script', 'scenes', 'knowledge', 'settings'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(t === 'scenes' ? 'Scenarios' : t === 'script' ? 'Script' : t[0].toUpperCase() + t.slice(1))}</button>)}
        <span className="grow" /><button className="ghost" onClick={() => setOpen(false)}>{tr("← back to chat")}</button>
      </div>
      <div className="content">
        {tab === 'overview' && <Overview />}
        {tab === 'module' && <ModuleImportPanel />}
        {tab === 'script' && <ScriptKnowledgePanel />}
        {tab === 'scenes' && <SceneManager />}
        {tab === 'knowledge' && <KnowledgeWorkspace />}
        {tab === 'settings' && <ChannelSettings />}
      </div>
    </div>
  );
}
