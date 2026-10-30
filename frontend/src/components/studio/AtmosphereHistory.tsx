import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { t } from '../../i18n';

export default function AtmosphereHistory({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.atmosphereHistory>>>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setHistory([]); setError('');
    if (!open) return;
    let active = true;
    api.atmosphereHistory(channelId).then(h => { if (active) setHistory(h); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [channelId, open, revision]);
  const labels: Record<string, string> = {
    day_landscape: t('Landscape · light theme'), night_landscape: t('Landscape · dark theme'),
    day_portrait: t('Portrait · light theme'), night_portrait: t('Portrait · dark theme'),
  };
  return <details className="card" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{t('Atmosphere background history')}</summary>
    {open && <>
      <button className="small" onClick={() => setRevision(r => r + 1)}>{t('Refresh')}</button>
      {error && <p role="alert">{error}</p>}
      {history.map(h => <details key={h.id} className="node">
        <summary>{h.scene_label} · {new Date(h.created_at).toLocaleString()}</summary>
        <p>{h.reason}</p>
        {Object.entries(h.prompts).map(([key, prompt]) => <div key={key}>
          <h4>{labels[key]} · {t(h.variants.find(v => v.variant === key)?.status || 'pending')}</h4>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{prompt}</p>
          {h.variants.find(v => v.variant === key)?.error && <p role="alert">{h.variants.find(v => v.variant === key)?.error}</p>}
        </div>)}
      </details>)}
    </>}
  </details>;
}
