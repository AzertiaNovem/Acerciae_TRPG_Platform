import { useEffect, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import { useUi } from '../../store/ui';
import { downloadHybridProject } from '../../openstudio/hybridImport';
import { useOpenStudio } from '../../openstudio/ui/state';
import { loadAiSettings } from '../../openstudio/providers/settings';
import { openNeeds, voiceJobs } from '../../openstudio/actions';
import { startPaint, startVoice } from '../../openstudio/tasks';
import AiSettingsDialog from '../../openstudio/ui/AiSettingsDialog';

export default function HybridVnTransfer({ channelId, presentationId }: { channelId: string; presentationId: string }) {
  const toast = useUi((s) => s.toast);
  const [settings, setSettings] = useState(false);
  const [generate, setGenerate] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const transfer = async () => {
    const ctrl = new AbortController(); controller.current = ctrl; setBusy(tr('Preparing…'));
    try {
      const p = await downloadHybridProject(channelId, presentationId, ctrl.signal,
        (done, total) => setBusy(tr('Downloading existing art… {done}/{total}', { done, total })));
      const ai = loadAiSettings();
      if (generate) {
        if (ai.image.provider !== 'none' && openNeeds(p).length) startPaint(p.id);
        if (ai.tts.provider !== 'none' && voiceJobs(p).length) startVoice(p.id);
      }
      useOpenStudio.getState().openProject(p.id);
    } catch (e: any) { if (!ctrl.signal.aborted) toast(e?.message ?? String(e), 'error'); }
    finally { controller.current = null; setBusy(null); }
  };
  return <div className="card col" style={{ gap: 8 }} data-testid="hybrid-vn-transfer">
    <h4 style={{ margin: 0 }}>{tr('Hybrid · finish on this computer')}</h4>
    <div className="tiny muted">{tr('Keep the server-written script, existing backgrounds, main portraits and dubbing cast. Open Log Studio generates missing poses, backgrounds and speech with this computer’s AI services, then saves a player folder or video locally. New media is never uploaded to the platform.')}</div>
    <label className="tiny"><input type="checkbox" checked={generate} disabled={!!busy} onChange={(e) => setGenerate(e.target.checked)} /> {tr('Start missing art and voices after import (configured services only)')}</label>
    <div className="tiny muted">{tr('Review the imported voices in the local dubbing cast. Custom voices must be available to your local service account; otherwise choose a local voice.')}</div>
    <div className="row" style={{ gap: 8 }}>
      <button className="small" disabled={!!busy} onClick={() => setSettings(true)}>{tr('Local AI services')}</button>
      <button className="primary small" disabled={!!busy} onClick={transfer}>{tr('Continue in the local studio')}</button>
      {busy && <><span className="tiny muted">{busy}</span><button className="ghost small" onClick={() => controller.current?.abort()}>{tr('Cancel')}</button></>}
    </div>
    {settings && <AiSettingsDialog onClose={() => setSettings(false)} />}
  </div>;
}
