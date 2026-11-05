import { t as tr } from '../../i18n';
import type { Project } from '../types';
import { setLocalVoice } from '../actions';
import { loadAiSettings, TTS_VOICES } from '../providers/settings';

export default function HybridCast({ p, update, disabled }: { p: Project; update: (fn: (d: Project) => void) => void; disabled: boolean }) {
  const ai = loadAiSettings();
  const choices = ai.tts.provider === 'none' ? [] : TTS_VOICES[ai.tts.provider];
  const rows = [{ name: null, label: tr('Narrator'), voice: p.vn!.narrator_voice, config: p.vn!.narrator_voice_config },
    ...p.characters.map((c) => ({ name: c.name, label: c.name, voice: c.voice, config: c.voice_config }))];
  return <details open className="col tiny" style={{ gap: 6 }}>
    <summary>{tr('Local dubbing cast')}</summary>
    <div className="muted">{tr('Server voice IDs and delivery settings are retained. Change a voice here to use your local service; only that speaker’s recordings are cleared.')}</div>
    <datalist id="hybrid-local-voices">{choices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</datalist>
    {rows.map((r) => <label className="row tiny" key={r.name ?? '__narrator'} style={{ gap: 8 }}>
      <span style={{ minWidth: 100 }}>{r.label}</span>
      <input list="hybrid-local-voices" value={r.voice} disabled={disabled} placeholder={tr('Voice ID (empty = silent)')}
        onChange={(e) => update((d) => setLocalVoice(d, r.name, e.target.value))} />
      {r.config && <span className="muted">{r.config.provider} · {r.config.language}{r.config.style_instruction ? ` · ${r.config.style_instruction}` : ''}</span>}
    </label>)}
  </details>;
}
