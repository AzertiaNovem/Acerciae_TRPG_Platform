import { useEffect } from 'react';
import { t as tr } from '../i18n';
import { useNav } from '../store/nav';
import { useChatSpeech } from '../lib/speech';
import { modelForLanguage, VOICES } from '../lib/speech/text';

// The chat header's read-aloud switch: new lines others post in this window are spoken with Kokoro on this device.
// The server language its maintainers set chooses the model: Mandarin for Chinese servers, English otherwise.
export default function ReadAloudButton() {
  const { enabled, status, progress, voice, model, error, speaking, toggle, setVoice, setModel } = useChatSpeech();
  const language = useNav((s) => s.serverSettings?.language);
  useEffect(() => { setModel(modelForLanguage(language)); }, [language, setModel]);
  const label = enabled ? tr('Reading aloud') : tr('Read aloud');
  const help = model === 'zh'
    ? tr('Speak new messages in this window with Kokoro (Mandarin model, chosen by the server language), on this device. The voice model (about 330 MB) downloads once. It reads Chinese and English; other text is skipped.')
    : tr('Speak new messages in this window with Kokoro, on this device. The voice model (about 90 MB) downloads once. Kokoro speaks English only: text in other languages is skipped.');
  return (
    <span className={`read-aloud ${enabled ? 'on' : ''}`}>
      <button type="button" className={enabled ? 'primary small' : 'ghost small'} aria-pressed={enabled} onClick={toggle} title={help}>
        <span className={`read-aloud-icon ${speaking ? 'speaking' : ''}`} aria-hidden>{enabled ? '🔊' : '🔈'}</span> {label}
      </button>
      {enabled && <select className="small" aria-label={tr('Voice')} value={voice} onChange={(e) => setVoice(e.target.value)}>
        {VOICES[model].map((v) => <option key={v.id} value={v.id}>{model === 'zh' ? tr(v.female ? 'Female voice {n}' : 'Male voice {n}', { n: v.label }) : v.label}</option>)}
      </select>}
      {enabled && status === 'loading' && <span className="tiny muted" role="status">{tr('Loading the voice model… {percent}%', { percent: progress })}</span>}
      {enabled && status === 'error' && <span className="tiny" role="alert" style={{ color: 'var(--danger)' }} title={error}>{tr('The voice model could not load')}</span>}
    </span>
  );
}
