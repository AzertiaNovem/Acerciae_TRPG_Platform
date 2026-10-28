import { t as tr } from '../../i18n';
import { studioAccess } from './access';
import { useEffect } from 'react';
import { useNav } from '../../store/nav';
import { useStudio, type StudioView } from '../../store/studio';
import CampaignLog from './CampaignLog';
import VisualNovelEditor from './VisualNovelEditor';
import VoiceStudio from './VoiceStudio';
import AssetLibrary from './AssetLibrary';
import PdfTemplateEditor from './PdfTemplateEditor';
import PublishedLogs from './PublishedLogs';

const TABS: { id: StudioView; label: string; gm?: boolean }[] = [
  { id: 'log', label: 'Campaign log' }, { id: 'vn', label: 'Visual novel' }, { id: 'pdf', label: 'PDF' }, { id: 'voice', label: 'Voice studio' }, { id: 'assets', label: 'Assets' }, { id: 'published', label: 'Published' },
];

// The production workspace: one campaign log per channel, and what is made from it.
export default function StudioWorkspace() {
  const { channelId, channel, serverSettings, setStudioOpen } = useNav();
  const { view, setView, loadLog, snapshot } = useStudio();
  const isGm = channel?.my_role === 'gm';
  const access = studioAccess(channel, serverSettings);
  const allowed = access === 'open';
  useEffect(() => { if (channelId && allowed) loadLog(channelId).catch(() => undefined); }, [channelId, loadLog, allowed]);
  if (!allowed) return (
    <div className="workspace"><div className="content"><div className="card">
      <h3>{tr("Log Studio")}</h3>
      <div className="muted small">{access === 'disabled' ? tr("The server maintainer has turned the Log Studio off for this server.") : access === 'locked' ? tr("The Keeper opens the Log Studio to players when the story ends.") : tr("The Keeper has hidden the Log Studio in this channel.")}</div>
      <button style={{ marginTop: 8 }} onClick={() => setStudioOpen(false)}>{tr("← back to chat")}</button>
    </div></div></div>
  );
  return (
    <div className="workspace">
      <div className="tabs studio-tabs">
        {TABS.filter((t) => !t.gm || isGm).map((t) => <button key={t.id} className={view === t.id ? 'active' : ''} onClick={() => setView(t.id)}>{tr(t.label)}</button>)}
        <span className="grow" />
        {snapshot && <span className="pill ai" title={tr("frozen version of the log in use")}>{tr("v")}{snapshot.version} · {snapshot.scope}</span>}
        <button className="ghost" onClick={() => setStudioOpen(false)}>{tr("← back to chat")}</button>
      </div>
      <div className="content" style={{ paddingBottom: 40 }}>
        {view === 'log' && <CampaignLog />}
        {view === 'vn' && <VisualNovelEditor />}
        {view === 'voice' && <VoiceStudio />}
        {view === 'assets' && <AssetLibrary />}
        {view === 'pdf' && <PdfTemplateEditor />}
        {view === 'published' && <PublishedLogs />}
      </div>
    </div>
  );
}
