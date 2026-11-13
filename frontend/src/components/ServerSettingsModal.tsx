import { t as tr } from '../i18n';
import { useEscape } from '../hooks/useEscape';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { isDesktop, webOrigin } from '../lib/platform';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import UserPicker, { userCandidate } from './UserPicker';
import TypedConfirm from './TypedConfirm';
import { avatarFromFile } from './UserSettingsModal';
import AiProviders from './AiProviders';
import type { BuiltinDiceTexts, DiceTextGroup, Feature, ServerInvite, ServerMember, ServerPolicy, ServerSettings } from '../types';

type Tab = 'general' | 'access' | 'ai' | 'features' | 'members' | 'channels' | 'dice';
import { LANGUAGE_LABELS } from '../i18n';
export { LANGUAGE_LABELS } from '../i18n';
const FEATURES: { key: Feature; label: string; help: string }[] = [
  { key: 'atmosphere', label: 'Channel atmosphere backgrounds', help: 'Allow automatic image generation from public GM narration: landscape day/night and portrait day/night. Uses this server’s image provider and budget; each person must also enable display.' },
  { key: 'consistency', label: 'Consistency Check', help: 'Players and GMs can check a draft against what their character knows.' },
  { key: 'dice', label: 'Integrated Dice', help: 'Sealdice-style commands in chat: .r .ra .sc .st .en, with the gray attribute hint while typing.' },
  { key: 'illustrations', label: 'Illustrations', help: 'Members can have a moment of play drawn by this server’s image provider and posted in the chat. Uses the image budget; GMs can still turn it off per channel. Pictures already posted stay.' },
  { key: 'inspiration', label: 'Inspiration', help: 'Drafts a possible in-character reply from the character’s knowledge (never sent automatically).' },
  { key: 'log_studio', label: 'Log Studio', help: 'The campaign log, exports, PDF publication and visual novels. GMs can still hide it per channel; when open, every member reaches it equally.' },
];

interface Form {
  name: string; language: string; features: Record<Feature, boolean>;
  ai_policy: { token_budget: string; image_budget: string; period: 'month' | 'total'; max_concurrent: string; reset_usage: boolean };
  policy: ServerPolicy;
}
const formFrom = (s: ServerSettings): Form => ({
  name: s.name, language: s.language, features: { ...s.features },
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
  const usage = settings.ai_policy;
  const setPolicy = (patch: Partial<Form['ai_policy']>) => setForm({ ...form, ai_policy: { ...form.ai_policy, ...patch } });
  const setAccess = (patch: Partial<ServerPolicy>) => setForm({ ...form, policy: { ...form.policy, ...patch } });
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
        <AiProviders serverId={settings.server_id} initial={settings.ai} />
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
          {(usage.cached_tokens_used ?? 0) > 0 && <div className="tiny muted" title={tr("The provider served this part of the prompts from its prompt cache, at a lower price. It still counts against the token budget.")}>{tr("{n} of them read from the prompt cache ({percent}%)", { n: (usage.cached_tokens_used ?? 0).toLocaleString(), percent: usage.tokens_used ? Math.round(((usage.cached_tokens_used ?? 0) / usage.tokens_used) * 100) : 0 })}</div>}
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
  // At the app's root: the page the link is made on (a channel's URL) is no part of the invitation.
  const link = (code: string) => isDesktop ? `${webOrigin()}/?invite=${code}` : `${location.origin}${import.meta.env.BASE_URL ?? '/'}?invite=${code}`;
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

// Every channel of the server (maintainers see them all, member or not); deleting one asks for "Delete Channel".
function Channels({ serverId }: { serverId: string }) {
  const toast = useUi((s) => s.toast);
  const [channels, setChannels] = useState<Awaited<ReturnType<typeof api.allChannels>>>([]);
  const [doomed, setDoomed] = useState<{ id: string; name: string } | null>(null);
  const load = useCallback(() => { api.allChannels(serverId).then(setChannels).catch((e) => toast(e.message, 'error')); }, [serverId, toast]);
  useEffect(load, [load]);
  const remove = async () => {
    if (!doomed) return;
    try {
      await api.deleteChannel(doomed.id, 'Delete Channel');
      await useNav.getState().forgetChannel(doomed.id);   // members (this user too) are also told over the socket
      setDoomed(null); load();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      {channels.length === 0 && <div className="muted small">{tr('No channels yet.')}</div>}
      {channels.map((c) => (
        <div key={c.id} className="pick-row">
          <span className="grow">#{c.name} <span className="tiny muted">{tr('{n} members · {m} messages', { n: c.member_count, m: c.message_count })}</span></span>
          <button className="small" onClick={() => setDoomed(c)}>{tr('Delete')}</button>
        </div>
      ))}
      <div className="tiny muted">{tr('Deleting a channel removes it for every member, with its chat, characters, documents, media and logs.')}</div>
      {doomed && (
        <TypedConfirm title={tr('Delete the channel “{name}”?', { name: doomed.name })} phrase="Delete Channel" action={tr('Delete channel')} onCancel={() => setDoomed(null)} onConfirm={remove}>
          {tr('Its chat, characters, documents, media, scenarios and logs are deleted for every member. This cannot be undone.')}
        </TypedConfirm>
      )}
    </div>
  );
}

// The owner alone deletes the server, after typing "Delete Server".
function DeleteServer({ serverId, name, isOwner, onDeleted }: { serverId: string; name: string; isOwner: boolean; onDeleted: () => void }) {
  const toast = useUi((s) => s.toast);
  const [asking, setAsking] = useState(false);
  const remove = async () => {
    try {
      await api.deleteServer(serverId, 'Delete Server');
      onDeleted();
      await useNav.getState().forgetServer(serverId);   // members (this user too) are also told over the socket
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--danger)', marginTop: 12 }}>
      <h4 style={{ margin: '0 0 6px' }}>{tr('Danger zone')}</h4>
      {isOwner ? <div className="row"><span className="grow small">{tr('Delete this server with all its channels, members, invites and settings.')}</span><button className="danger" onClick={() => setAsking(true)}>{tr('Delete server')}</button></div>
        : <div className="small muted">{tr('Only the server owner can delete the server.')}</div>}
      {asking && (
        <TypedConfirm title={tr('Delete the server “{name}”?', { name })} phrase="Delete Server" action={tr('Delete server')} onCancel={() => setAsking(false)} onConfirm={remove}>
          {tr('Every channel goes with it — chat, characters, documents, media and logs — for every member, and its invites stop working. This cannot be undone.')}
        </TypedConfirm>
      )}
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
              <button className="small" onClick={() => confirm(tr('Remove {name} from this server? They also leave all of its channels and chat windows.', { name: m.display_name })) && run(() => api.removeServerMember(serverId, m.id))}>{tr("Remove")}</button>
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

// One reply text's templates: a single string, or several the dice pick from at random.
const templatesOf = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? (v.length ? v : ['']) : [v ?? '']);
type EditingGroup = DiceTextGroup & { avatar_data?: string };

function TextTemplates({ k, value, placeholder, onChange }: { k: string; value: string | string[] | undefined; placeholder: string; onChange: (v: string | string[]) => void }) {
  const list = templatesOf(value);
  const set = (next: string[]) => onChange(next.length === 1 ? next[0] : next);
  return (
    <div className="field dice-templates"><span className="mono tiny">{k}{list.length > 1 && <span className="pill">{tr('{n} templates, one at random', { n: list.length })}</span>}</span>
      {list.map((text, i) => (
        <div className="row" key={i}>
          <input className="grow" value={text} placeholder={i === 0 ? placeholder : tr('Another template')} onChange={(e) => set(list.map((x, j) => (j === i ? e.target.value : x)))} />
          {list.length > 1 && <button type="button" className="ghost small" title={tr('Remove this template')} onClick={() => set(list.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {list.length < 20 && <button type="button" className="ghost small dice-add-template" onClick={() => set([...list, ''])}>{tr('+ Template')}</button>}
    </div>
  );
}

function DiceTexts({ serverId }: { serverId: string }) {
  const toast = useUi((s) => s.toast);
  const [groups, setGroups] = useState<DiceTextGroup[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinDiceTexts | null>(null);
  const [editing, setEditing] = useState<EditingGroup | null>(null);
  const [filter, setFilter] = useState('');
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
    try {
      await api.updateDiceTextGroup(serverId, editing.id, { name: editing.name, base: editing.base, texts: editing.texts, dice_name: editing.dice_name ?? '', ...(editing.avatar_data !== undefined ? { avatar_data: editing.avatar_data } : {}) });
      toast('Text group saved'); setEditing(null); load();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const remove = async (g: DiceTextGroup) => {
    if (!confirm(tr('Delete text group “{name}”? Channels using it fall back to the server language.', { name: g.name }))) return;
    try { await api.deleteDiceTextGroup(serverId, g.id); load(); } catch (e: any) { toast(e.message, 'error'); }
  };
  const pickAvatar = async (file: File | undefined) => {
    if (!file || !editing) return;
    try { setEditing({ ...editing, avatar_data: await avatarFromFile(file) }); } catch (e: any) { toast(e.message, 'error'); }
  };

  if (editing && builtin) {
    const defaults = builtin[editing.base];
    // The avatar as it will be after saving: a newly chosen picture, none, or the stored one.
    const avatar = editing.avatar_data !== undefined ? editing.avatar_data : editing.avatar_version ? api.diceAvatarUrl(editing.id, editing.avatar_version) : '';
    const keys = builtin.keys.filter((k) => !filter.trim() || k.includes(filter.trim()) || templatesOf(editing.texts[k]).some((x) => x.includes(filter.trim())) || (defaults[k] ?? '').includes(filter.trim()));
    return (
      <div className="col">
        <div className="row">
          <input className="grow" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <select value={editing.base} onChange={(e) => setEditing({ ...editing, base: e.target.value as any })} title={tr("Keys left empty use this built-in set")}>
            <option value="en">{tr("based on English")}</option><option value="zh">{tr("based on 中文")}</option>
          </select>
        </div>
        <div className="section-label">{tr('The dice')}</div>
        <div className="row dice-persona">
          <div className="avatar dice">{avatar ? <img src={avatar} alt="" /> : <span aria-hidden>🎲</span>}</div>
          <label className="field grow"><span>{tr('Nickname')}</span>
            <input maxLength={60} value={editing.dice_name ?? ''} placeholder={editing.base === 'zh' ? '骰子' : 'Dice'} onChange={(e) => setEditing({ ...editing, dice_name: e.target.value })} /></label>
          <label className="button ghost small">{tr('Choose avatar…')}<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pickAvatar(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {avatar && <button type="button" className="ghost small" onClick={() => setEditing({ ...editing, avatar_data: '' })}>{tr('Remove avatar')}</button>}
        </div>
        <div className="tiny muted">{tr('Rolls in channels using this group show this name and avatar. Each roll keeps the name it was made with.')}</div>
        <div className="section-label">{tr('Reply texts')}</div>
        <div className="tiny muted">{tr("Leave a field empty to keep the built-in text. Placeholders in braces, e.g. ")}<code>{tr("{name}")}</code>, <code>{tr("{attr}")}</code>, <code>{tr("{roll}")}</code>, <code>{tr("{target}")}</code>, <code>{tr("{level}")}</code>{tr(", are filled in by the dice.")} {tr('Give a text several templates and the dice pick one at random for each reply.')}</div>
        <input placeholder={tr('Filter texts…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="text-keys">
          {keys.map((k) => <TextTemplates key={k} k={k} value={editing.texts[k]} placeholder={defaults[k]} onChange={(v) => setEditing({ ...editing, texts: { ...editing.texts, [k]: v } })} />)}
        </div>
        <div className="row"><span className="grow" /><button className="ghost" onClick={() => setEditing(null)}>{tr("Cancel")}</button><button className="primary" onClick={save}>{tr("Save group")}</button></div>
      </div>
    );
  }
  const customCount = (g: DiceTextGroup) => Object.values(g.texts).filter((v) => templatesOf(v).some((x) => x)).length;
  return (
    <div className="col">
      <div className="tiny muted">{tr("Text groups change how dice replies are worded (Sealdice “custom texts”). Each channel’s GM picks the group their channel uses in the GM workspace → Settings.")} {tr('A group can also give the dice a nickname and an avatar.')}</div>
      {groups.length === 0 && <div className="muted small">{tr("No custom groups yet — channels use the built-in English or 中文 texts.")}</div>}
      {groups.map((g) => (
        <div key={g.id} className="pick-row">
          <div className="avatar dice small">{g.avatar_version ? <img src={api.diceAvatarUrl(g.id, g.avatar_version)} alt="" /> : <span aria-hidden>🎲</span>}</div>
          <span className="grow">{g.name}{g.dice_name && <> · <b>{g.dice_name}</b></>} <span className="tiny muted">{g.base === 'zh' ? '中文' : tr("English")}{tr(" base · ")}{customCount(g)}{tr(" custom text(s)")}</span></span>
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
  useEscape(onClose);
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const myRole = servers.find((s) => s.id === serverId)?.my_role ?? 'member';
  const [loadError, setLoadError] = useState('');
  useEffect(() => { if (serverId) api.serverSettings(serverId).then(setSettings).catch((e) => setLoadError(e.message)); }, [serverId]);
  if (!serverId) return null;
  const onSaved = (s: ServerSettings) => { setSettings(s); loadServerSettings(); useNav.getState().loadServers(); };
  const tabs: [Tab, string][] = [['general', 'General'], ['access', 'Access'], ['ai', 'AI services'], ['features', 'Features'], ['members', 'Members'], ['channels', 'Channels'], ['dice', 'Dice texts']];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide col" role="dialog" aria-modal="true" aria-label={tr("Server settings")} onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 className="grow" style={{ margin: 0 }}>{tr("Server settings")}</h3><span className="pill">{myRole === 'owner' ? tr("owner") : tr("maintainer")}</span></div>
        <div className="tabs inline">{tabs.map(([t, label]) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tr(label)}</button>)}</div>
        {loadError ? <div className="muted">{loadError}</div> : !settings ? <div className="muted">{tr("Loading…")}</div> : !settings.is_maintainer ? <div className="muted">{tr("Only server maintainers can change these settings.")}</div> : (
          <>
            {(tab === 'general' || tab === 'access' || tab === 'ai' || tab === 'features') && <Settings tab={tab} settings={settings} onSaved={onSaved} />}
            {tab === 'access' && <Invites serverId={serverId} joinPolicy={settings.policy?.join_policy ?? 'invite'} />}
            {tab === 'general' && <DeleteServer serverId={serverId} name={settings.name ?? ''} isOwner={myRole === 'owner'} onDeleted={onClose} />}
            {tab === 'members' && <Members serverId={serverId} myRole={myRole} />}
            {tab === 'channels' && <Channels serverId={serverId} />}
            {tab === 'dice' && <DiceTexts serverId={serverId} />}
          </>
        )}
        <div className="row"><span className="grow" /><button className="ghost" onClick={onClose}>{tr("Close")}</button></div>
      </div>
    </div>
  );
}
