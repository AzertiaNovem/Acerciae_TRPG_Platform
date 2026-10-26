import { t as tr } from '../../i18n';
import { useEffect } from 'react';
import { useNav } from '../../store/nav';
import { useStudio, type StudioView } from '../../store/studio';
import LogLibrary from './LogLibrary';
import LogImport from './LogImport';
import LogEditor from './LogEditor';
import StyledLogViewer from './StyledLogViewer';
import VisualNovelEditor from './VisualNovelEditor';
import VoiceStudio from './VoiceStudio';
import AssetLibrary from './AssetLibrary';
import PdfTemplateEditor from './PdfTemplateEditor';
import PublishedLogs from './PublishedLogs';

const TABS: { id: StudioView; label: string; gm?: boolean }[] = [
  { id: 'library', label: 'Library' }, { id: 'import', label: 'Import', gm: true }, { id: 'editor', label: 'Log editor', gm: true },
  { id: 'vn', label: 'Visual novel' }, { id: 'voice', label: 'Voice studio' }, { id: 'assets', label: 'Assets' }, { id: 'pdf', label: 'PDF' }, { id: 'published', label: 'Published' },
];

// Independent production workspace. Reuses the unified log data source for every view.
export default function StudioWorkspace() {
  const { channelId, channel, setStudioOpen } = useNav();
  const { view, setView, loadProjects, project, snapshot } = useStudio();
  const isGm = channel?.my_role === 'gm';
  useEffect(() => { if (channelId) loadProjects(channelId).catch(() => undefined); }, [channelId, loadProjects]);
  return (
    <div className="workspace">
      <div className="tabs studio-tabs">
        {TABS.filter((t) => !t.gm || isGm).map((t) => <button key={t.id} className={view === t.id ? 'active' : ''} onClick={() => setView(t.id)}>{tr(t.label)}</button>)}
        <span className="grow" />
        {project && <span className="pill" title={tr("current log project")}>{project.title}</span>}
        {snapshot && <span className="pill ai" title={tr("current snapshot")}>{tr("v")}{snapshot.version} · {snapshot.scope}</span>}
        <button className="ghost" onClick={() => setStudioOpen(false)}>{tr("← back to chat")}</button>
      </div>
      <div className="content" style={{ paddingBottom: 40 }}>
        {view === 'library' && <LogLibrary />}
        {view === 'import' && <LogImport />}
        {view === 'editor' && <LogEditor />}
        {view === 'vn' && <VisualNovelEditor />}
        {view === 'voice' && <VoiceStudio />}
        {view === 'assets' && <AssetLibrary />}
        {view === 'pdf' && <PdfTemplateEditor />}
        {view === 'published' && <PublishedLogs />}
        {snapshot && view === 'library' && <StyledLogViewer />}
      </div>
    </div>
  );
}
