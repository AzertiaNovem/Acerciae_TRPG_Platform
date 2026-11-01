import { t as tr } from '../../i18n';
import { useEffect, useState } from 'react';
import { useEscape } from '../../hooks/useEscape';
import { useUi } from '../../store/ui';
import { getSecret, setSecret } from '../storage';
import { DEFAULTS, KEY_NAMES, loadAiSettings, saveAiSettings, type AiSettings } from '../providers/settings';

// The AI services Open Log Studio may use, with the user's own keys (kept in the system keychain).
export default function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const toast = useUi((s) => s.toast);
  const [s, setS] = useState<AiSettings>(loadAiSettings());
  const [keys, setKeys] = useState<Record<keyof typeof KEY_NAMES, string>>({ llm: '', image: '', tts: '' });
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  useEffect(() => { (Object.keys(KEY_NAMES) as (keyof typeof KEY_NAMES)[]).forEach((k) => getSecret(KEY_NAMES[k]).then((v) => setHasKey((h) => ({ ...h, [k]: !!v }))).catch(() => undefined)); }, []);
  const pick = <K extends keyof AiSettings>(kind: K, provider: string) => {
    const d = (DEFAULTS as any)[kind][provider] ?? { base_url: '', model: '' };
    setS({ ...s, [kind]: { ...s[kind], provider, base_url: d.base_url, model: d.model } });
  };
  const save = async () => {
    try {
      saveAiSettings(s);
      for (const k of Object.keys(KEY_NAMES) as (keyof typeof KEY_NAMES)[]) if (keys[k]) await setSecret(KEY_NAMES[k], keys[k].trim());
      toast(tr('AI services saved')); onClose();
    } catch (e: any) { toast(e?.message ?? String(e), 'error'); }
  };
  const forget = async (k: keyof typeof KEY_NAMES) => { await setSecret(KEY_NAMES[k], ''); setHasKey((h) => ({ ...h, [k]: false })); };
  const keyField = (k: keyof typeof KEY_NAMES) => (
    <label className="col tiny" style={{ gap: 4 }}>{tr('API key')}
      <span className="row" style={{ gap: 6 }}>
        <input type="password" value={keys[k]} placeholder={hasKey[k] ? tr('Saved in the system keychain') : ''} onChange={(e) => setKeys({ ...keys, [k]: e.target.value })} autoComplete="off" style={{ flex: 1 }} />
        {hasKey[k] && <button type="button" className="ghost small" onClick={() => forget(k)}>{tr('Forget')}</button>}
      </span>
    </label>
  );
  const common = (k: 'llm' | 'image' | 'tts') => s[k].provider !== 'none' && (
    <>
      <label className="col tiny" style={{ gap: 4 }}>{tr('Service address')}<input value={s[k].base_url} onChange={(e) => setS({ ...s, [k]: { ...s[k], base_url: e.target.value } })} spellCheck={false} /></label>
      <label className="col tiny" style={{ gap: 4 }}>{tr('Model')}<input value={s[k].model} onChange={(e) => setS({ ...s, [k]: { ...s[k], model: e.target.value } })} spellCheck={false} /></label>
      {keyField(k)}
    </>
  );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card col" style={{ width: 560, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', gap: 10 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 style={{ margin: 0 }}>{tr('AI services')}</h3>
        <p className="tiny muted" style={{ margin: 0 }}>{tr('Open Log Studio calls these services from this computer with your own keys. Keys stay in the system keychain; nothing goes through the Acerciae server.')}</p>
        <fieldset className="col" style={{ gap: 6 }}><legend>{tr('Script writer (language model)')}</legend>
          <select value={s.llm.provider} onChange={(e) => pick('llm', e.target.value)}>
            <option value="none">{tr('None — rule-based script')}</option><option value="openai">{tr('OpenAI or compatible')}</option><option value="anthropic">Anthropic</option>
          </select>{common('llm')}
        </fieldset>
        <fieldset className="col" style={{ gap: 6 }}><legend>{tr('Images')}</legend>
          <select value={s.image.provider} onChange={(e) => pick('image', e.target.value)}>
            <option value="none">{tr('None — only the art you add')}</option><option value="openai">{tr('OpenAI or compatible')}</option>
          </select>{common('image')}
          {s.image.provider !== 'none' && <label className="col tiny" style={{ gap: 4 }}>{tr('Quality')}<select value={s.image.quality} onChange={(e) => setS({ ...s, image: { ...s.image, quality: e.target.value as any } })}><option value="auto">{tr('Automatic')}</option><option value="low">{tr('Low')}</option><option value="medium">{tr('Medium')}</option><option value="high">{tr('High')}</option></select></label>}
        </fieldset>
        <fieldset className="col" style={{ gap: 6 }}><legend>{tr('Voices (speech)')}</legend>
          <select value={s.tts.provider} onChange={(e) => pick('tts', e.target.value)}>
            <option value="none">{tr('None — no voice lines')}</option><option value="openai">{tr('OpenAI or compatible')}</option><option value="qwen">Qwen (DashScope)</option>
          </select>{common('tts')}
        </fieldset>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}><button className="ghost" onClick={onClose}>{tr('Cancel')}</button><button className="primary" onClick={save}>{tr('Save')}</button></div>
      </div>
    </div>
  );
}
