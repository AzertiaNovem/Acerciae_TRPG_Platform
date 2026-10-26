import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import UserPicker, { userCandidate } from './UserPicker';
import type { BuiltinDiceTexts, DiceTextGroup, Feature, ServerMember, ServerSettings } from '../types';

type Tab = 'general' | 'ai' | 'features' | 'members' | 'dice';
export const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский', pt: 'Português', it: 'Italiano',
};
const FEATURES: { key: Feature; label: string; help: string }[] = [
  { key: 'consistency', label: 'Consistency Check', help: 'Players and GMs can check a draft against what their character knows.' },
  { key: 'dice', label: 'Integrated Dice', help: 'Sealdice-style commands in chat: .r .ra .sc .st .en, with the gray attribute hint while typing.' },
  { key: 'inspiration', label: 'Inspiration', help: 'Drafts a possible in-character reply from the character’s knowledge (never sent automatically).' },
];

interface Form {
  name: string; language: string; features: Record<Feature, boolean>;
  llm: { api_base: string; model: string; reasoning_effort: string; api_key: string; clear_api_key: boolean };
  tts: { api_base: string; model: string; voice: string; api_key: string; clear_api_key: boolean };
}
const formFrom = (s: ServerSettings): Form => ({
  name: s.name, language: s.language, features: { ...s.features },
  llm: { api_base: s.llm?.api_base ?? '', model: s.llm?.model ?? '', reasoning_effort: s.llm?.reasoning_effort ?? '', api_key: '', clear_api_key: false },
  tts: { api_base: s.tts?.api_base ?? '', model: s.tts?.model ?? '', voice: s.tts?.voice ?? '', api_key: '', clear_api_key: false },
});

function Settings({ tab, settings, onSaved }: { tab: 'general' | 'ai' | 'features'; settings: ServerSettings; onSaved: (s: ServerSettings) => void }) {
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState<Form>(() => formFrom(settings));
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(formFrom(settings)), [settings]);
  const save = async () => {
    setSaving(true);
    try { const s = await api.updateServerSettings(settings.server_id, form); onSaved(s); toast('Server settings saved'); }
    catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const llm = settings.llm, tts = settings.tts;
  const keyField = (part: 'llm' | 'tts', info?: { api_key_set: boolean; api_key_hint: string }, fallback?: string) => (
    <div className="col" style={{ gap: 4 }}>
      <label className="field"><span>API key</span>
        <input type="password" autoComplete="new-password" value={form[part].api_key} onChange={(e) => setForm({ ...form, [part]: { ...form[part], api_key: e.target.value, clear_api_key: false } })}
          placeholder={info?.api_key_set ? `stored (${info.api_key_hint}) — type to replace` : fallback ?? 'not set'} />
      </label>
      {info?.api_key_set && <label className="row tiny"><input type="checkbox" checked={form[part].clear_api_key} onChange={(e) => setForm({ ...form, [part]: { ...form[part], clear_api_key: e.target.checked, api_key: '' } })} />Remove the stored key</label>}
    </div>
  );
  return (
    <div className="col">
      {tab === 'general' && (<>
        <label className="field"><span>Server name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Language</span>
          <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
            {(settings.languages ?? Object.keys(LANGUAGE_LABELS)).map((l) => <option key={l} value={l}>{LANGUAGE_LABELS[l] ?? l}</option>)}
          </select>
        </label>
        <div className="tiny muted">The language the AI chronicler, consistency check and inspiration write in, and the default dice reply texts (Chinese settings use the 中文 dice texts unless a channel picks another group).</div>
      </>)}
      {tab === 'ai' && (<>
        <div className="section-label">Language model</div>
        <label className="field"><span>API base URL</span><input value={form.llm.api_base} onChange={(e) => setForm({ ...form, llm: { ...form.llm, api_base: e.target.value } })} placeholder={llm?.default_api_base ?? 'https://api.openai.com/v1'} /></label>
        {keyField('llm', llm, llm?.default_key_configured ? 'not set — uses the platform key' : 'not set — the platform has no key either (mock mode)')}
        <div className="tiny muted">A custom base URL is only used together with this server’s own key. Any OpenAI-compatible chat-completions endpoint works.</div>
        <label className="field"><span>Model</span><input value={form.llm.model} onChange={(e) => setForm({ ...form, llm: { ...form.llm, model: e.target.value } })} placeholder={llm?.default_model ?? 'model name'} /></label>
        <label className="field"><span>Thinking effort</span>
          <select value={form.llm.reasoning_effort} onChange={(e) => setForm({ ...form, llm: { ...form.llm, reasoning_effort: e.target.value } })}>
            <option value="">Off (non-reasoning model)</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </label>
        <div className="tiny muted">Sent as <code>reasoning_effort</code>; only set it for reasoning models.</div>
        <div className="section-label">Text-to-speech</div>
        <label className="field"><span>API base URL</span><input value={form.tts.api_base} onChange={(e) => setForm({ ...form, tts: { ...form.tts, api_base: e.target.value } })} placeholder="https://…" /></label>
        {keyField('tts', tts)}
        <div className="row">
          <label className="field grow"><span>Model</span><input value={form.tts.model} onChange={(e) => setForm({ ...form, tts: { ...form.tts, model: e.target.value } })} /></label>
          <label className="field grow"><span>Voice</span><input value={form.tts.voice} onChange={(e) => setForm({ ...form, tts: { ...form.tts, voice: e.target.value } })} /></label>
        </div>
        <div className="tiny muted">Keys are encrypted on the server and never sent back to the browser.</div>
      </>)}
      {tab === 'features' && FEATURES.map((f) => (
        <label key={f.key} className="feature">
          <input type="checkbox" checked={form.features[f.key]} onChange={(e) => setForm({ ...form, features: { ...form.features, [f.key]: e.target.checked } })} />
          <span className="col" style={{ gap: 2 }}><span>{f.label}</span><span className="tiny muted">{f.help}</span></span>
        </label>
      ))}
      <div className="row"><span className="grow" /><button className="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></div>
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
            {m.role === 'owner' ? <span className="pill gm">owner</span> : isOwner ? (
              <select value={m.role} onChange={(e) => run(() => api.setServerMemberRole(serverId, m.id, e.target.value as any))} title="Maintainers can change server settings and manage members">
                <option value="member">member</option><option value="admin">maintainer</option>
              </select>
            ) : <span className="pill">{m.role === 'admin' ? 'maintainer' : 'member'}</span>}
            {m.role !== 'owner' && m.id !== me?.id && (isOwner || m.role === 'member') && (
              <button className="small" onClick={() => confirm(`Remove ${m.display_name} from this server? They also leave all of its channels and chat windows.`) && run(() => api.removeServerMember(serverId, m.id))}>Remove</button>
            )}
          </div>
        ))}
      </div>
      <div className="section-label">Invite someone</div>
      <UserPicker mode="action" actionLabel="Invite" search={search} exclude={members.map((m) => m.id)} emptyText="No matching user." placeholder="Search registered users…"
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
          <select value={editing.base} onChange={(e) => setEditing({ ...editing, base: e.target.value as any })} title="Keys left empty use this built-in set">
            <option value="en">based on English</option><option value="zh">based on 中文</option>
          </select>
        </div>
        <div className="tiny muted">Leave a field empty to keep the built-in text. Placeholders in braces, e.g. <code>{'{name}'}</code>, <code>{'{attr}'}</code>, <code>{'{roll}'}</code>, <code>{'{target}'}</code>, <code>{'{level}'}</code>, are filled in by the dice.</div>
        <div className="text-keys">
          {builtin.keys.map((k) => (
            <label key={k} className="field"><span className="mono tiny">{k}</span>
              <input value={editing.texts[k] ?? ''} placeholder={defaults[k]} onChange={(e) => setEditing({ ...editing, texts: { ...editing.texts, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        <div className="row"><span className="grow" /><button className="ghost" onClick={() => setEditing(null)}>Cancel</button><button className="primary" onClick={save}>Save group</button></div>
      </div>
    );
  }
  return (
    <div className="col">
      <div className="tiny muted">Text groups change how dice replies are worded (Sealdice “custom texts”). Each channel’s GM picks the group their channel uses in the GM workspace → Settings.</div>
      {groups.length === 0 && <div className="muted small">No custom groups yet — channels use the built-in English or 中文 texts.</div>}
      {groups.map((g) => (
        <div key={g.id} className="pick-row">
          <span className="grow">{g.name} <span className="tiny muted">{g.base === 'zh' ? '中文' : 'English'} base · {Object.keys(g.texts).length} custom text(s)</span></span>
          <button className="small" onClick={() => setEditing({ ...g, texts: { ...g.texts } })}>Edit</button>
          <button className="small" onClick={() => remove(g)}>Delete</button>
        </div>
      ))}
      <div className="row">
        <input className="grow" placeholder="New group name (e.g. Noir narrator)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <select value={newBase} onChange={(e) => setNewBase(e.target.value as any)}><option value="en">English base</option><option value="zh">中文 base</option></select>
        <button className="primary small" onClick={create}>Create</button>
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
  const tabs: [Tab, string][] = [['general', 'General'], ['ai', 'AI & voice'], ['features', 'Features'], ['members', 'Members'], ['dice', 'Dice texts']];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide col" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 className="grow" style={{ margin: 0 }}>Server settings</h3><span className="pill">{myRole === 'owner' ? 'owner' : 'maintainer'}</span></div>
        <div className="tabs inline">{tabs.map(([t, label]) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>)}</div>
        {!settings ? <div className="muted">Loading…</div> : !settings.is_maintainer ? <div className="muted">Only server maintainers can change these settings.</div> : (
          <>
            {(tab === 'general' || tab === 'ai' || tab === 'features') && <Settings tab={tab} settings={settings} onSaved={onSaved} />}
            {tab === 'members' && <Members serverId={serverId} myRole={myRole} />}
            {tab === 'dice' && <DiceTexts serverId={serverId} />}
          </>
        )}
        <div className="row"><span className="grow" /><button className="ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
