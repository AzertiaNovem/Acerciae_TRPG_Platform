import { t as tr } from '../i18n';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useUi } from '../store/ui';
import type { AiCatalog, AiKind, AiProvider, AiSettings, AiUse, AiUseInfo } from '../types';

// Server settings → AI services: the providers this server has (an endpoint of a known kind with its keys) and the
// provider and model each use runs on. A use only lists providers whose kind can do it.

const MODE_LABELS: Record<string, string> = { mock: 'Mock (no model)', disabled: 'Off', inherit: 'Same as above' };
const INHERIT_LABELS: Record<string, string> = { image_edit: 'Same as image generation' };

interface Draft { id?: string; kind: string; name: string; api_base: string; api_key: string; clear_api_key: boolean; options: Record<string, string>; secrets: Record<string, string | null> }
const draftFor = (p: AiProvider | null, kind: AiKind): Draft => p
  ? { id: p.id, kind: p.kind, name: p.name, api_base: p.api_base, api_key: '', clear_api_key: false, options: { ...p.options }, secrets: {} }
  : { kind: kind.id, name: tr(kind.label), api_base: '', api_key: '', clear_api_key: false, options: {}, secrets: {} };

function ProviderForm({ draft, kind, stored, onChange, onSave, onCancel, saving }: {
  draft: Draft; kind: AiKind; stored: AiProvider | null; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void; saving: boolean;
}) {
  return (
    <div className="col ai-provider-form">
      <div className="row">
        <label className="field grow"><span>{tr('Name')}</span><input maxLength={60} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
      </div>
      <div className="tiny muted">{tr(kind.protocol)}</div>
      <label className="field"><span>{tr('Endpoint')}</span>
        <input value={draft.api_base} onChange={(e) => onChange({ ...draft, api_base: e.target.value })} placeholder={kind.default_api_base || tr('Provider default')} />
      </label>
      {kind.api_base_hint && <div className="tiny muted">{tr(kind.api_base_hint)}</div>}
      {kind.fields.map((f) => {
        if (f.type !== 'secret') return (
          <label key={f.key} className="field"><span>{tr(f.label)}{f.required ? ' *' : ''}</span>
            <input value={draft.options[f.key] ?? ''} placeholder={f.placeholder ?? ''} onChange={(e) => onChange({ ...draft, options: { ...draft.options, [f.key]: e.target.value } })} />
          </label>
        );
        const main = f.key === 'api_key';
        const set = main ? stored?.api_key_set : stored?.secrets?.[f.key]?.set;
        const hint = main ? stored?.api_key_hint : stored?.secrets?.[f.key]?.hint;
        const value = main ? draft.api_key : (draft.secrets[f.key] ?? '');
        const cleared = main ? draft.clear_api_key : draft.secrets[f.key] === null;
        return (
          <div key={f.key} className="col" style={{ gap: 4 }}>
            <label className="field"><span>{tr(f.label)}{f.required ? ' *' : ''}</span>
              <input type="password" autoComplete="new-password" value={value ?? ''}
                placeholder={set ? tr('stored ({hint}) — type to replace', { hint: hint ?? '' }) : f.required ? tr('required') : tr('optional')}
                onChange={(e) => onChange(main ? { ...draft, api_key: e.target.value, clear_api_key: false } : { ...draft, secrets: { ...draft.secrets, [f.key]: e.target.value } })} />
            </label>
            {set && !f.required && <label className="row tiny"><input type="checkbox" checked={cleared}
              onChange={(e) => onChange(main ? { ...draft, clear_api_key: e.target.checked, api_key: '' } : { ...draft, secrets: { ...draft.secrets, [f.key]: e.target.checked ? null : '' } })} />{tr('Remove the stored key')}</label>}
          </div>
        );
      })}
      {kind.notes && <div className="tiny muted">{tr(kind.notes)}</div>}
      <div className="row"><span className="grow" /><button className="ghost" onClick={onCancel} disabled={saving}>{tr('Cancel')}</button><button className="primary" onClick={onSave} disabled={saving || !draft.name.trim()}>{tr('Save provider')}</button></div>
    </div>
  );
}

function UseRow({ use, value, providers, catalog, onChange }: { use: AiUseInfo; value: AiUse; providers: AiProvider[]; catalog: AiCatalog; onChange: (v: AiUse) => void }) {
  const fitting = providers.filter((p) => catalog.kinds.find((k) => k.id === p.kind)?.capabilities.includes(use.capability));
  const provider = providers.find((p) => p.id === value.provider);
  const kind = provider ? catalog.kinds.find((k) => k.id === provider.kind) : undefined;
  const suggestions = kind?.models?.[use.capability] ?? [];
  const listId = `ai-models-${use.id}`;
  const setOption = (key: string, v: string) => onChange({ ...value, options: { ...value.options, [key]: v } });
  return (
    <div className="ai-use">
      <div className="ai-use-label">{tr(use.label)}{use.tasks && <div className="tiny muted">{tr('Optional: a different model for this kind of work')}</div>}</div>
      <div className="col" style={{ gap: 6 }}>
        <select value={value.provider} onChange={(e) => onChange({ provider: e.target.value, model: e.target.value === value.provider ? value.model : '', options: value.options })}>
          {use.modes.filter((m) => m !== 'provider').map((m) => <option key={m} value={m}>{tr(m === 'inherit' ? (INHERIT_LABELS[use.id] ?? MODE_LABELS.inherit) : m === 'mock' && use.capability !== 'text' ? (use.capability === 'tts' ? 'Mock speech' : 'Mock test patterns') : MODE_LABELS[m])}</option>)}
          {fitting.map((p) => <option key={p.id} value={p.id}>{p.name} · {tr(catalog.kinds.find((k) => k.id === p.kind)?.label ?? p.kind)}</option>)}
        </select>
        {provider && <>
          <input list={listId} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder={tr('Model')} />
          <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
          {use.capability === 'text' && ['openai', 'responses', 'openrouter'].includes(provider.kind) &&
            <select value={value.options.reasoning_effort ?? ''} onChange={(e) => setOption('reasoning_effort', e.target.value)} title={tr('Thinking effort')}>
              <option value="">{tr('Thinking effort: off')}</option><option value="minimal">{tr('Minimal')}</option><option value="low">{tr('Low')}</option><option value="medium">{tr('Medium')}</option><option value="high">{tr('High')}</option>
            </select>}
          {(use.capability === 'image_generation' || use.capability === 'image_edit') && <div className="row">
            <select value={value.options.size ?? 'auto'} onChange={(e) => setOption('size', e.target.value)} title={tr('Image size')}>{['auto', '1024x1024', '1536x1024', '1024x1536'].map((v) => <option key={v} value={v}>{v === 'auto' ? tr('Provider default') : v}</option>)}</select>
            {provider.kind === 'openai' && <select value={value.options.quality ?? 'auto'} onChange={(e) => setOption('quality', e.target.value)} title={tr('Image quality')}>{['auto', 'low', 'medium', 'high'].map((v) => <option key={v} value={v}>{v === 'auto' ? tr('Provider default') : tr(v === 'low' ? 'Low' : v === 'medium' ? 'Medium' : 'High')}</option>)}</select>}
          </div>}
          {use.capability === 'tts' && <input value={value.options.voice ?? ''} onChange={(e) => setOption('voice', e.target.value)} placeholder={tr('Default voice')} />}
        </>}
      </div>
    </div>
  );
}

export default function AiProviders({ serverId, initial }: { serverId: string; initial?: AiSettings }) {
  const toast = useUi((s) => s.toast);
  const [catalog, setCatalog] = useState<AiCatalog | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(initial ?? null);
  const [uses, setUses] = useState<Record<string, AiUse>>(initial?.uses ?? {});
  const [editing, setEditing] = useState<{ draft: Draft; stored: AiProvider | null } | null>(null);
  const [newKind, setNewKind] = useState('openai');
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.aiCatalog().then(setCatalog).catch((e) => toast(e.message, 'error')); }, [toast]);
  const reload = async () => { const v = await api.aiSettings(serverId); setAi(v); setUses(v.uses); };
  useEffect(() => { if (!initial) reload().catch((e) => toast(e.message, 'error')); }, [serverId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const kindOf = useMemo(() => (id: string) => catalog?.kinds.find((k) => k.id === id), [catalog]);
  if (!catalog || !ai) return <div className="muted small">{tr('Loading…')}</div>;

  const saveProvider = async () => {
    if (!editing) return;
    const d = editing.draft;
    const secrets: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(d.secrets)) if (v === null || v) secrets[k] = v;
    const body = { name: d.name.trim(), kind: d.kind, api_base: d.api_base.trim(), options: d.options, secrets, ...(d.api_key ? { api_key: d.api_key } : {}), ...(d.clear_api_key ? { clear_api_key: true } : {}) };
    setSaving(true);
    try {
      if (d.id) await api.updateAiProvider(serverId, d.id, body); else await api.createAiProvider(serverId, body);
      await reload(); setEditing(null); toast(tr('Provider saved'));
    } catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const removeProvider = async (p: AiProvider) => {
    const note = p.used_by.length ? tr('The uses on it go back to their defaults.') : '';
    if (!confirm(tr('Delete provider “{name}”?', { name: p.name }) + (note ? ' ' + note : ''))) return;
    try { const v = await api.deleteAiProvider(serverId, p.id); setAi(v); setUses(v.uses); } catch (e: any) { toast(e.message, 'error'); }
  };
  const saveUses = async () => {
    setSaving(true);
    try { const v = await api.updateAiUses(serverId, uses); setAi(v); setUses(v.uses); toast(tr('Model uses saved')); }
    catch (e: any) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  const useLabel = (id: string) => tr(catalog.uses.find((u) => u.id === id)?.label ?? id);
  const changed = JSON.stringify(uses) !== JSON.stringify(ai.uses);

  return (
    <div className="col ai-providers">
      <div className="section-label">{tr('Providers')}</div>
      <div className="tiny muted">{tr('Add the AI services this server uses: each is an endpoint of a known kind with this server\'s own keys. You can change the endpoint of any of them.')}</div>
      {ai.providers.length === 0 && <div className="muted small">{tr('No providers yet: AI runs in mock mode.')}</div>}
      {ai.providers.map((p) => editing?.draft.id === p.id ? (
        <ProviderForm key={p.id} draft={editing.draft} kind={kindOf(p.kind)!} stored={p} saving={saving} onChange={(draft) => setEditing({ ...editing, draft })} onSave={saveProvider} onCancel={() => setEditing(null)} />
      ) : (
        <div key={p.id} className="pick-row ai-provider">
          <div className="grow">
            <div><b>{p.name}</b> <span className="tiny muted">{tr(kindOf(p.kind)?.label ?? p.kind)}</span></div>
            <div className="tiny muted mono">{p.api_base || (kindOf(p.kind)?.default_api_base ?? '').replace('{region}', p.options.region || 'us-east-1')}</div>
            <div className="ai-chips">
              {(kindOf(p.kind)?.capabilities ?? []).map((c) => <span key={c} className="pill">{tr(catalog.uses.find((u) => u.capability === c)?.label ?? c)}</span>)}
              {!p.api_key_set && <span className="pill danger">{tr('No key')}</span>}
            </div>
            {p.used_by.length > 0 && <div className="tiny">{tr('Used for')}: {p.used_by.map(useLabel).join(', ')}</div>}
          </div>
          <button className="small" onClick={() => setEditing({ draft: draftFor(p, kindOf(p.kind)!), stored: p })}>{tr('Edit')}</button>
          <button className="small" onClick={() => removeProvider(p)}>{tr('Delete')}</button>
        </div>
      ))}
      {editing && !editing.draft.id && <ProviderForm draft={editing.draft} kind={kindOf(editing.draft.kind)!} stored={null} saving={saving}
        onChange={(draft) => setEditing({ ...editing, draft })} onSave={saveProvider} onCancel={() => setEditing(null)} />}
      {!editing && <div className="row">
        <select className="grow" value={newKind} onChange={(e) => setNewKind(e.target.value)}>
          {catalog.kinds.map((k) => <option key={k.id} value={k.id}>{tr(k.label)}</option>)}
        </select>
        <button className="primary small" onClick={() => { const k = kindOf(newKind)!; setEditing({ draft: draftFor(null, k), stored: null }); }}>{tr('Add provider')}</button>
      </div>}
      {!editing && <div className="tiny muted">{tr('Can do')}: {(kindOf(newKind)?.capabilities ?? []).map((c) => tr(catalog.uses.find((u) => u.capability === c)?.label ?? c)).join(', ')}</div>}

      <div className="section-label">{tr('Model uses')}</div>
      <div className="tiny muted">{tr('Pick the provider and model for each use. Only providers that can do a use are offered.')}</div>
      <div className="ai-uses">
        {catalog.uses.map((u) => <UseRow key={u.id} use={u} catalog={catalog} providers={ai.providers}
          value={uses[u.id] ?? { provider: u.default, model: '', options: {} }} onChange={(v) => setUses({ ...uses, [u.id]: v })} />)}
      </div>
      <div className="row"><span className="grow" />
        {changed && <button className="ghost" onClick={() => setUses(ai.uses)} disabled={saving}>{tr('Undo changes')}</button>}
        <button className="primary" onClick={saveUses} disabled={saving || !changed}>{tr('Save model uses')}</button>
      </div>
      <div className="tiny muted">{tr('Keys are encrypted on the server and never sent back to the browser.')}</div>
    </div>
  );
}
