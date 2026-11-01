import { t as tr } from '../i18n';
import { useChatSpeech } from '../lib/speech';
import { KOKORO_VOICES } from '../lib/speech/text';

// The chat header's read-aloud switch: new lines others post in this window are spoken with Kokoro on this device.
export default function ReadAloudButton() {
  const { enabled, status, progress, voice, error, speaking, toggle, setVoice } = useChatSpeech();
  const label = enabled ? tr('Reading aloud') : tr('Read aloud');
  return (
    <span className={`read-aloud ${enabled ? 'on' : ''}`}>
      <button type="button" className={enabled ? 'primary small' : 'ghost small'} aria-pressed={enabled} onClick={toggle}
        title={tr('Speak new messages in this window with Kokoro, on this device. The voice model (about 90 MB) downloads once. Kokoro speaks English only: text in other languages is skipped.')}>
        <span className={`read-aloud-icon ${speaking ? 'speaking' : ''}`} aria-hidden>{enabled ? '🔊' : '🔈'}</span> {label}
      </button>
      {enabled && <select className="small" aria-label={tr('Voice')} value={voice} onChange={(e) => setVoice(e.target.value)}>{KOKORO_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select>}
      {enabled && status === 'loading' && <span className="tiny muted" role="status">{tr('Loading the voice model… {percent}%', { percent: progress })}</span>}
      {enabled && status === 'error' && <span className="tiny" role="alert" style={{ color: 'var(--danger)' }} title={error}>{tr('The voice model could not load')}</span>}
    </span>
  );
}
