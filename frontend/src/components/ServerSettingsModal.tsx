import { t as tr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import UserPicker, { userCandidate } from './UserPicker';
import type { BuiltinDiceTexts, DiceTextGroup, Feature, ServerInvite, ServerMember, ServerPolicy, ServerSettings } from '../types';

type Tab = 'general' | 'access' | 'ai' | 'features' | 'members' | 'dice';
import { LANGUAGE_LABELS } from '../i18n';
export { LANGUAGE_LABELS } from '../i18n';
const FEATURES: { key: Feature; label: string; help: string }[] = [
  { key: 'consistency', label: 'Consistency Check', help: 'Players and GMs can check a draft against what their character knows.' },
  { key: 'dice', label: 'Integrated Dice', help: 'Sealdice-style commands in chat: .r .ra .sc .st .en, with the gray attribute hint while typing.' },
  { key: 'inspiration', label: 'Inspiration', help: 'Drafts a possible in-character reply from the character’s knowledge (never sent automatically).' },
  { key: 'coc7_points', label: 'COC7 point-buy', help: 'Role cards spend career points (from a career in the built-in list) and hobby points (INT×2) within their limits, and show the characteristic total.' },
  { key: 'log_studio', label: 'Log Studio', help: 'The campaign log, exports, PDF publication and visual novels. Keepers can still hide it per channel; when open, every member reaches it equally.' },
];

interface Form {
  name: string; language: string; features: Record<Feature, boolean>;
  llm: { provider: string; api_base: string; model: string; reasoning_effort: string; embedding_model: string; api_key: string; clear_api_key: boolean };
  image: { provider: string; api_base: string; model: string; size: string; quality: string; api_key: string; clear_api_key: boolean };
  tts: { provider: string; api_base: string; model: string; voice: string; api_key: string; clear_api_key: boolean };
  ai_policy: { token_budget: string; image_budget: string; period: 'month' | 'total'; max_concurrent: string; reset_usage: boolean };
  policy: ServerPolicy;
}
const formFrom = (s: ServerSettings): Form => ({
  name: s.name, language: s.language, features: { ...s.features },
  llm: { provider: s.llm?.provider ?? 'mock', api_base: s.llm?.api_base ?? '', model: s.llm?.model ?? '', reasoning_effort: s.llm?.reasoning_effort ?? '', embedding_model: s.llm?.embedding_model ?? '', api_key: '', clear_api_key: false },
  image: { provider: s.image?.provider ?? 'mock', api_base: s.image?.api_base ?? '', model: s.image?.model ?? '', size: s.image?.size ?? 'auto', quality: s.image?.quality ?? 'auto', api_key: '', clear_api_key: false },
  tts: { provider: s.tts?.provider ?? 'mock', api_base: s.tts?.api_base ?? '', model: s.tts?.model ?? '', voice: s.tts?.voice ?? '', api_key: '', clear_api_key: false },
  policy: { join_policy: 'invite', channel_creation: 'members', guest_invites: false, main_chat_spectators: false, ...s.policy },
  ai_policy: { token_budget: String(s.ai_policy?.token_budget ?? 0), image_budget: String(s.ai_policy?.image_budget ?? 0), period: s.ai_policy?.period ?? 'month', max_concurrent: String(s.ai_policy?.max_concurrent ?? 4), reset_usage: false },
});
const count = (n: string) => { const v = Number(n.trim() || '0'); return Number.isFinite(v) ? Math.floor(v) : NaN; };
const budgetText = (used: number, budget: number) => budget > 0 ? `${used.toLocaleString()} / ${budget.toLocaleString()}` : `${used.toLocaleString()} (${tr('no limit')})`;

function Settings({ tab, settings, onSaved }: { tab: 'general' | 'access' | 'ai' | 'features'; settings: ServerSettings; onSaved: (s: ServerSettings) => void }) {
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState<Form>(() => formFrom(settings));
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(formFrom(settings)), [settings]);
  const save = async () => {
    setSaving(true);
    const pol = form.ai_policy;
    const body = { ...form, ai_policy: { token_budget: count(pol.token_budget), image_budget: count(pol.image_budget), max_concurrent: count(pol.max_concurrent), period: pol.period, reset_usage: pol.reset_usage } };
    try { const s = await api.updateServerSettings(settings.server_id, body); onSaved(s); toast('Server settings saved'); }
    catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const llm = settings.llm, tts = settings.tts, image = settings.image, usage = settings.ai_policy;
  const anthropic = form.llm.provider === 'anthropic';
  const setPolicy = (patch: Partial<Form['ai_policy']>) => setForm({ ...form, ai_policy: { ...form.ai_policy, ...patch } });
  const setAccess = (patch: Partial<ServerPolicy>) => setForm({ ...form, policy: { ...form.policy, ...patch } });
  const keyField = (part: 'llm' | 'tts' | 'image', info?: { api_key_set: boolean; api_key_hint: string }, fallback?: string) => (
    <div className="col" style={{ gap: 4 }}>
      <label className="field"><span>{tr("API key")}</span>
        <input type="password" autoComplete="new-password" value={form[part].api_key} onChange={(e) => setForm({ ...form, [part]: { ...form[part], api_key: e.target.value, clear_api_key: false } })}
          placeholder={info?.api_key_set ? `stored (${info.api_key_hint}) — type to replace` : fallback ?? tr("not set")} />
      </label>
      {info?.api_key_set && <label className="row tiny"><input type="checkbox" checked={form[part].clear_api_key} onChange={(e) => setForm({ ...form, [part]: { ...form[part], clear_api_key: e.target.checked, api_key: '' } })} />{tr("Remove the stored key")}</label>}
    </div>
  );
  return (
    <div className="col">
      {tab === 'general' && (<>
        <label className="field"><span>{tr("Server name")}</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>{tr("Language")}</span>
          <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
            {(settings.languages ?? Object.keys(LANGUAGE_LABELS)).map((l) => <option key={l} value={l}>{LANGUAGE_LABELS[l] ?? l}</option>)}
          </select>
        </label>
        <div className="tiny muted">{tr("The language the AI chronicler, consistency check and inspiration write in, and the default dice reply texts (Chinese settings use the 中文 dice texts unless a channel picks another group).")}</div>
      </>)}
      {tab === 'access' && (<>
        <label className="field"><span>{tr("How people join")}</span>
          <select value={form.policy.join_policy} onChange={(e) => setAccess({ join_policy: e.target.value as ServerPolicy['join_policy'] })}>
            <option value="invite">{tr("With an invite link from a maintainer")}</option>
            <option value="open">{tr("Open: listed in the server directory, anyone may join")}</option>
            <option value="closed">{tr("Closed: only maintainers add members")}</option>
          </select>
        </label>
        <div className="tiny muted">{tr("Maintainers can always add people directly under Members.")}</div>
        <label className="field"><span>{tr("Who may create channels")}</span>
          <select value={form.policy.channel_creation} onChange={(e) => setAccess({ channel_creation: e.target.value as ServerPolicy['channel_creation'] })}>
            <option value="members">{tr("Every member")}</option>
            <option value="maintainers">{tr("Maintainers only")}</option>
          </select>
        </label>
        <label className="feature">
          <input type="checkbox" checked={form.policy.guest_invites} onChange={(e) => setAccess({ guest_invites: e.target.checked })} />
          <span className="col" style={{ gap: 2 }}><span>{tr("Channel GMs may invite guests")}</span><span className="tiny muted">{tr("A GM can invite people from outside the server. Guests see only the channels they were invited to and leave the server with their last channel.")}</span></span>
        </label>
        <label className="feature">
          <input type="checkbox" checked={form.policy.main_chat_spectators} onChange={(e) => setAccess({ main_chat_spectators: e.target.checked })} />
          <span className="col" style={{ gap: 2 }}><span>{tr("Members may read other channels' Main Chat")}</span><span className="tiny muted">{tr("Members not invited to a channel can read its Main Chat, read-only: only lines everyone at that table sees. Guests never can.")}</span></span>
        </label>
      </>)}
      {tab === 'ai' && (<>
        <div className="tiny muted">{tr("AI on this server runs only on the providers configured here, with this server's own keys. Without them it runs in mock mode.")}</div>
        <div className="section-label">{tr("Language model")}</div>
        <label className="field"><span>{tr("API protocol")}</span>
          <select value={form.llm.provider} onChange={(e) => setForm({ ...form, llm: { ...form.llm, provider: e.target.value } })}>
            <option value="mock">{tr("Mock (no model)")}</option>
            <option value="openai_compatible">{tr("OpenAI compatible")}</option>
            <option value="anthropic">{tr("Anthropic compatible")}</option>
          </select>
        </label>
        {form.llm.provider !== 'mock' && <>
          <label className="field"><span>{tr("API base URL")}</span><input value={form.llm.api_base} onChange={(e) => setForm({ ...form, llm: { ...form.llm, api_base: e.target.value } })} placeholder={anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"} /></label>
          {keyField('llm', llm, tr("required"))}
          <div className="tiny muted">{tr("Include /v1 in the base URL.")}</div>
          <label className="field"><span>{tr("Model")}</span><input value={form.llm.model} onChange={(e) => setForm({ ...form, llm: { ...form.llm, model: e.target.value } })} placeholder={tr("model name")} /></label>
          {!anthropic && <><label className="field"><span>{tr("Thinking effort")}</span>
            <select value={form.llm.reasoning_effort} onChange={(e) => setForm({ ...form, llm: { ...form.llm, reasoning_effort: e.target.value } })}>
              <option value="">{tr("Off (non-reasoning model)")}</option><option value="minimal">{tr("Minimal")}</option><option value="low">{tr("Low")}</option><option value="medium">{tr("Medium")}</option><option value="high">{tr("High")}</option>
            </select>
          </label>
          <div className="tiny muted">{tr("Sent as ")}<code>{tr("reasoning_effort")}</code>{tr("; only set it for reasoning models.")}</div>
          <label className="field"><span>{tr("Embedding model")}</span><input value={form.llm.embedding_model} onChange={(e) => setForm({ ...form, llm: { ...form.llm, embedding_model: e.target.value } })} placeholder={tr("optional")} /></label>
          <div className="tiny muted">{tr("Used for semantic recall over the chat log. Leave empty to recall by keywords only.")}</div></>}
          {anthropic && <div className="tiny muted">{tr("Anthropic uses the Messages API with tool support. OpenAI thinking effort is not sent.")}</div>}
        </>}
        <div className="section-label">{tr("Image generation")}</div>
        <label className="field"><span>{tr("Provider")}</span>
          <select value={form.image.provider} onChange={(e) => setForm({ ...form, image: { ...form.image, provider: e.target.value } })}>
            <option value="disabled">{tr("Disabled")}</option>
            <option value="mock">{tr("Mock test patterns")}</option>
            <option value="gpt_image">{tr("GPT Image compatible")}</option>
          </select>
        </label>
        <div className="tiny muted">{tr("Image generation has its own endpoint, model and key. It never uses the language model or speech key.")}</div>
        {form.image.provider === 'gpt_image' && <>
          <label className="field"><span>{tr("API base URL")}</span><input value={form.image.api_base} onChange={(e) => setForm({ ...form, image: { ...form.image, api_base: e.target.value } })} placeholder="https://api.openai.com/v1" /></label>
          {keyField('image', image, tr("required"))}
          <label className="field"><span>{tr("Model")}</span><input value={form.image.model} onChange={(e) => setForm({ ...form, image: { ...form.image, model: e.target.value } })} placeholder={tr("Enter the image model ID from your provider")} /></label>
          <div className="row">
            <label className="field grow"><span>{tr("Image size")}</span><select value={form.image.size} onChange={(e) => setForm({ ...form, image: { ...form.image, size: e.target.value } })}>{['auto', '1024x1024', '1536x1024', '1024x1536'].map((v) => <option key={v} value={v}>{v === 'auto' ? tr('Provider default') : v}</option>)}</select></label>
            <label className="field grow"><span>{tr("Image quality")}</span><select value={form.image.quality} onChange={(e) => setForm({ ...form, image: { ...form.image, quality: e.target.value } })}>{['auto', 'low', 'medium', 'high'].map((v) => <option key={v} value={v}>{v === 'auto' ? tr('Provider default') : tr(v === 'low' ? 'Low' : v === 'medium' ? 'Medium' : 'High')}</option>)}</select></label>
          </div>
          <div className="tiny muted">{tr("Character portraits only need this provider. Log Studio art also needs the campaign's cloud permission.")}</div>
        </>}
        <div className="section-label">{tr("Text-to-speech")}</div>
        <label className="field"><span>{tr("Provider")}</span>
          <select value={form.tts.provider} onChange={(e) => setForm({ ...form, tts: { ...form.tts, provider: e.target.value } })}>
            <option value="disabled">{tr("Disabled")}</option>
            <option value="mock">{tr("Mock speech")}</option>
            <option value="qwen">{tr("Qwen speech")}</option>
          </select>
        </label>
        {form.tts.provider === 'qwen' && <>
          <label className="field"><span>{tr("API base URL")}</span><input value={form.tts.api_base} onChange={(e) => setForm({ ...form, tts: { ...form.tts, api_base: e.target.value } })} placeholder={tr("https://…")} /></label>
          {keyField('tts', tts, tr("required"))}
          <div className="row">
            <label className="field grow"><span>{tr("Model")}</span><input value={form.tts.model} onChange={(e) => setForm({ ...form, tts: { ...form.tts, model: e.target.value } })} /></label>
            <label className="field grow"><span>{tr("Voice")}</span><input value={form.tts.voice} onChange={(e) => setForm({ ...form, tts: { ...form.tts, voice: e.target.value } })} /></label>
          </div>
        </>}
        <div className="tiny muted">{tr("Keys are encrypted on the server and never sent back to the browser.")}</div>
        {!settings.private_endpoints_allowed && <div className="tiny muted">{tr("Endpoints must use https and a public address.")}</div>}
        <div className="section-label">{tr("AI policy")}</div>
        <div className="row">
          <label className="field grow"><span>{tr("Token budget")}</span><input type="number" min={0} value={form.ai_policy.token_budget} onChange={(e) => setPolicy({ token_budget: e.target.value })} /></label>
          <label className="field grow"><span>{tr("Image budget")}</span><input type="number" min={0} value={form.ai_policy.image_budget} onChange={(e) => setPolicy({ image_budget: e.target.value })} /></label>
        </div>
        <div className="row">
          <label className="field grow"><span>{tr("Budget period")}</span>
            <select value={form.ai_policy.period} onChange={(e) => setPolicy({ period: e.target.value as 'month' | 'total' })}>
              <option value="month">{tr("Each calendar month")}</option>
              <option value="total">{tr("Until reset")}</option>
            </select>
          </label>
          <label className="field grow"><span>{tr("Simultaneous AI tasks")}</span><input type="number" min={1} max={64} value={form.ai_policy.max_concurrent} onChange={(e) => setPolicy({ max_concurrent: e.target.value })} /></label>
        </div>
        <div className="tiny muted">{tr("Budgets cover the whole server; 0 means no limit. Mock providers are not counted. When a budget is used up, AI requests stop until the next period or a reset.")}</div>
        {usage && <div className="small">
          <div>{tr("Tokens used")}: {budgetText(usage.tokens_used, usage.token_budget)}</div>
          <div>{tr("Images used")}: {budgetText(usage.images_used, usage.image_budget)}</div>
          <div>{tr("Running now")}: {usage.running} / {usage.max_concurrent}</div>
          {usage.period_start && <div className="tiny muted">{tr("Counted since")} {new Date(usage.period_start).toLocaleString()}</div>}
        </div>}
        <label className="row tiny"><input type="checkbox" checked={form.ai_policy.reset_usage} onChange={(e) => setPolicy({ reset_usage: e.target.checked })} />{tr("Reset usage counters when saving")}</label>
      </>)}
      {tab === 'features' && FEATURES.map((f) => (
        <label key={f.key} className="feature">
          <input type="checkbox" checked={form.features[f.key]} onChange={(e) => setForm({ ...form, features: { ...form.features, [f.key]: e.target.checked } })} />
          <span className="col" style={{ gap: 2 }}><span>{tr(f.label)}</span><span className="tiny muted">{tr(f.help)}</span></span>
        </label>
      ))}
      <div className="row"><span className="grow" /><button className="primary" disabled={saving} onClick={save}>{saving ? tr("Saving…") : tr("Save")}</button></div>
    </div>
  );
}

function Invites({ serverId, joinPolicy }: { serverId: string; joinPolicy: ServerPolicy['join_policy'] }) {
  const toast = useUi((s) => s.toast);
  const [invites, setInvites] = useState<ServerInvite[]>([]);
  const [uses, setUses] = useState('0');
  const [hours, setHours] = useState('168');
  const load = useCallback(() => { api.serverInvites(serverId).then(setInvites).catch(() => undefined); }, [serverId]);
  useEffect(load, [load]);
  const link = (code: string) => `${location.origin}${location.pathname}?invite=${code}`;
  const copy = async (code: string) => { try { await navigator.clipboard.writeText(link(code)); toast('Invite link copied'); } catch { toast(link(code)); } };
  const create = async () => {
    try { const inv = await api.createServerInvite(serverId, { max_uses: Number(uses) || 0, expires_in_hours: Number(hours) || 0 }); load(); copy(inv.code); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  if (joinPolicy === 'closed') return <div className="tiny muted">{tr("The server is closed, so invite links do not work.")}</div>;
  return (
    <div className="col">
      <div className="section-label">{tr("Invite links")}</div>
      <div className="row">
        <label className="field grow"><span>{tr("Uses")}</span><select value={uses} onChange={(e) => setUses(e.target.value)}>{['0', '1', '5', '10', '25', '100'].map((v) => <option key={v} value={v}>{v === '0' ? tr('No limit') : v}</option>)}</select></label>
        <label className="field grow"><span>{tr("Expires after")}</span><select value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="1">{tr("1 hour")}</option><option value="24">{tr("1 day")}</option><option value="168">{tr("7 days")}</option><option value="720">{tr("30 days")}</option><option value="0">{tr("Never")}</option>
        </select></label>
        <button className="primary small" onClick={create}>{tr("Create link")}</button>
      </div>
      {invites.length === 0 && <div className="tiny muted">{tr("No invite links yet.")}</div>}
      {invites.map((i) => (
        <div key={i.id} className="pick-row">
          <code className="grow">{i.code}</code>
          <span className="tiny muted">{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ''} · {i.expires_at ? new Date(i.expires_at).toLocaleString() : tr("Never")}</span>
          {i.active ? <>
            <button className="small" onClick={() => copy(i.code)}>{tr("Copy link")}</button>
            <button className="small" onClick={async () => { try { setInvites(await api.revokeServerInvite(serverId, i.id)); } catch (e: any) { toast(e.message, 'error'); } }}>{tr("Revoke")}</button>
          </> : <span className="pill">{i.revoked_at ? tr("revoked") : tr("expired")}</span>}
        </div>
      ))}
    </div>
  );
}

function Members({ serverId, myRole }: { serverId: string; myRole: string }) {
  const me = useAuth((s) => s.user);
  const toast = useUi((s) => s.toast);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const load = useCallback(() => { api.serverMembers(serverId).then(setMembers).catch(() => undefined); }, [serverId]);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e: any) { toast(e.message, 'error'); } };
  const search = useCallback(async (q: string) => (await api.searchUsers(q)).map((u) => userCandidate(u)), []);
  const isOwner = myRole === 'owner';
  return (
    <div className="col">
      <div className="col" style={{ gap: 4 }}>
        {members.map((m) => (
          <div key={m.id} className="pick-row">
            <span className="grow">{m.display_name} <span className="tiny muted">@{m.username}</span></span>
            {m.role === 'owner' ? <span className="pill gm">{tr("owner")}</span> : m.role === 'guest' ? (<>
              <span className="pill" title={tr("Sees only the channels they were invited to")}>{tr("guest")}</span>
              <button className="small" onClick={() => run(() => api.addServerMember(serverId, m.id, 'member'))}>{tr("Make member")}</button>
            </>) : isOwner ? (
              <select value={m.role} onChange={(e) => run(() => api.setServerMemberRole(serverId, m.id, e.target.value as any))} title={tr("Maintainers can change server settings and manage members")}>
                <option value="member">{tr("member")}</option><option value="admin">{tr("maintainer")}</option>
              </select>
            ) : <span className="pill">{m.role === 'admin' ? tr("maintainer") : tr("member")}</span>}
            {m.role !== 'owner' && m.id !== me?.id && (isOwner || m.role === 'member' || m.role === 'guest') && (
              <button className="small" onClick={() => confirm(`Remove ${m.display_name} from this server? They also leave all of its channels and chat windows.`) && run(() => api.removeServerMember(serverId, m.id))}>{tr("Remove")}</button>
            )}
          </div>
        ))}
      </div>
      <div className="section-label">{tr("Invite someone")}</div>
      <UserPicker mode="action" actionLabel={tr("Invite")} search={search} exclude={members.map((m) => m.id)} emptyText={tr("No matching user.")} placeholder={tr("Search registered users…")}
        onAction={(c) => run(async () => { await api.addServerMember(serverId, c.id); toast(`${c.label} joined the server`); })} />
    </div>
  );
}

function DiceTexts({ serverId }: { serverId: string }) {
  const toast = useUi((s) => s.toast);
  const [groups, setGroups] = useState<DiceTextGroup[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinDiceTexts | null>(null);
  const [editing, setEditing] = useState<DiceTextGroup | null>(null);
  const [newName, setNewName] = useState('');
  const [newBase, setNewBase] = useState<'en' | 'zh'>('en');
  const load = useCallback(() => { api.diceTextGroups(serverId).then(setGroups).catch(() => undefined); }, [serverId]);
  useEffect(() => { load(); api.builtinDiceTexts().then(setBuiltin).catch(() => undefined); }, [load]);

  const create = async () => {
    if (!newName.trim()) return;
    try { const g = await api.createDiceTextGroup(serverId, { name: newName.trim(), base: newBase, texts: {} }); setNewName(''); load(); setEditing(g); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  const save = async () => {
    if (!editing) return;
    try { await api.updateDiceTextGroup(serverId, editing.id, { name: editing.name, base: editing.base, texts: editing.texts }); toast('Text group saved'); setEditing(null); load(); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  const remove = async (g: DiceTextGroup) => {
    if (!confirm(`Delete text group “${g.name}”? Channels using it fall back to the server language.`)) return;
    try { await api.deleteDiceTextGroup(serverId, g.id); load(); } catch (e: any) { toast(e.message, 'error'); }
  };

  if (editing && builtin) {
    const defaults = builtin[editing.base];
    return (
      <div className="col">
        <div className="row">
          <input className="grow" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <select value={editing.base} onChange={(e) => setEditing({ ...editing, base: e.target.value as any })} title={tr("Keys left empty use this built-in set")}>
            <option value="en">{tr("based on English")}</option><option value="zh">{tr("based on 中文")}</option>
          </select>
        </div>
        <div className="tiny muted">{tr("Leave a field empty to keep the built-in text. Placeholders in braces, e.g. ")}<code>{tr("{name}")}</code>, <code>{tr("{attr}")}</code>, <code>{tr("{roll}")}</code>, <code>{tr("{target}")}</code>, <code>{tr("{level}")}</code>{tr(", are filled in by the dice.")}</div>
        <div className="text-keys">
          {builtin.keys.map((k) => (
            <label key={k} className="field"><span className="mono tiny">{k}</span>
              <input value={editing.texts[k] ?? ''} placeholder={defaults[k]} onChange={(e) => setEditing({ ...editing, texts: { ...editing.texts, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        <div className="row"><span className="grow" /><button className="ghost" onClick={() => setEditing(null)}>{tr("Cancel")}</button><button className="primary" onClick={save}>{tr("Save group")}</button></div>
      </div>
    );
  }
  return (
    <div className="col">
      <div className="tiny muted">{tr("Text groups change how dice replies are worded (Sealdice “custom texts”). Each channel’s GM picks the group their channel uses in the GM workspace → Settings.")}</div>
      {groups.length === 0 && <div className="muted small">{tr("No custom groups yet — channels use the built-in English or 中文 texts.")}</div>}
      {groups.map((g) => (
        <div key={g.id} className="pick-row">
          <span className="grow">{g.name} <span className="tiny muted">{g.base === 'zh' ? '中文' : tr("English")}{tr(" base · ")}{Object.keys(g.texts).length}{tr(" custom text(s)")}</span></span>
          <button className="small" onClick={() => setEditing({ ...g, texts: { ...g.texts } })}>{tr("Edit")}</button>
          <button className="small" onClick={() => remove(g)}>{tr("Delete")}</button>
        </div>
      ))}
      <div className="row">
        <input className="grow" placeholder={tr("New group name (e.g. Noir narrator)")} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <select value={newBase} onChange={(e) => setNewBase(e.target.value as any)}><option value="en">{tr("English base")}</option><option value="zh">{tr("中文 base")}</option></select>
        <button className="primary small" onClick={create}>{tr("Create")}</button>
      </div>
    </div>
  );
}

export default function ServerSettingsModal({ onClose }: { onClose: () => void }) {
  const { serverId, servers, loadServerSettings } = useNav();
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const myRole = servers.find((s) => s.id === serverId)?.my_role ?? 'member';
  useEffect(() => { if (serverId) api.serverSettings(serverId).then(setSettings).catch(() => undefined); }, [serverId]);
  if (!serverId) return null;
  const onSaved = (s: ServerSettings) => { setSettings(s); loadServerSettings(); useNav.getState().loadServers(); };
  const tabs: [Tab, string][] = [['general', 'General'], ['access', 'Access'], ['ai', 'AI services'], ['features', 'Features'], ['members', 'Members'], ['dice', 'Dice texts']];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide col" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 className="grow" style={{ margin: 0 }}>{tr("Server settings")}</h3><span className="pill">{myRole === 'owner' ? tr("owner") : tr("maintainer")}</span></div>
        <div className="tabs inline">{tabs.map(([t, label]) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(label)}</button>)}</div>
        {!settings ? <div className="muted">{tr("Loading…")}</div> : !settings.is_maintainer ? <div className="muted">{tr("Only server maintainers can change these settings.")}</div> : (
          <>
            {(tab === 'general' || tab === 'access' || tab === 'ai' || tab === 'features') && <Settings tab={tab} settings={settings} onSaved={onSaved} />}
            {tab === 'access' && <Invites serverId={serverId} joinPolicy={settings.policy?.join_policy ?? 'invite'} />}
            {tab === 'members' && <Members serverId={serverId} myRole={myRole} />}
            {tab === 'dice' && <DiceTexts serverId={serverId} />}
          </>
        )}
        <div className="row"><span className="grow" /><button className="ghost" onClick={onClose}>{tr("Close")}</button></div>
      </div>
    </div>
  );
}
