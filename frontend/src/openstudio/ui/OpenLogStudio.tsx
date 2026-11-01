import { t as tr, currentLocale } from '../../i18n';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useUi } from '../../store/ui';
import { deleteProject, listProjects, type ProjectMeta } from '../storage';
import { useOpenStudio } from './state';
import AiSettingsDialog from './AiSettingsDialog';
import NewProject from './NewProject';
const ProjectView = lazy(() => import('./ProjectView'));

// Open Log Studio: the Log Studio on this computer. Logs from SealDice, QQ or Acerciae become projects stored in the
// app's data folder; nothing needs an account or the server, and AI runs on the user's own keys.
export default function OpenLogStudio() {
  const close = useOpenStudio((s) => s.setOpen);
  const toast = useUi((s) => s.toast);
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'new' } | { kind: 'project'; id: string }>({ kind: 'list' });
  const [ai, setAi] = useState(false);
  const load = () => listProjects().then(setProjects).catch((e) => { toast(String(e?.message ?? e), 'error'); setProjects([]); });
  useEffect(() => { if (view.kind === 'list') load(); }, [view.kind]);
  const remove = async (p: ProjectMeta) => {
    if (!confirm(tr('Delete "{title}" and every file it holds from this computer?', { title: p.title }))) return;
    try { await deleteProject(p.id); load(); } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
  };
  return (
    <div className="open-studio">
      <header className="open-studio-head">
        <button className="ghost small" onClick={() => (view.kind === 'list' ? close(false) : setView({ kind: 'list' }))}>{view.kind === 'list' ? tr('← Back to Acerciae') : tr('← Projects')}</button>
        <b>{tr('Open Log Studio')}</b>
        <span className="tiny muted">{tr('On this computer · no account needed')}</span>
        <span className="grow" />
        <button className="ghost small" onClick={() => setAi(true)}>{tr('AI services')}</button>
      </header>
      <main className="open-studio-main">
        {view.kind === 'new' && <NewProject onCreated={(id) => setView({ kind: 'project', id })} onCancel={() => setView({ kind: 'list' })} />}
        {view.kind === 'project' && <Suspense fallback={<div className="muted">{tr('Loading…')}</div>}><ProjectView key={view.id} id={view.id} /></Suspense>}
        {view.kind === 'list' && (
          <div className="col" style={{ gap: 12, maxWidth: 820 }}>
            <div className="card col" style={{ gap: 8 }}>
              <h3 style={{ margin: 0 }}>{tr('Make something from a game log')}</h3>
              <p className="small muted" style={{ margin: 0 }}>{tr('Import SealDice logs (text or JSON, several files of one campaign are joined in order), QQ chat exports or logs exported from Acerciae. Add the setting and the characters\' looks, then export a styled HTML log, a PDF, or a visual novel (player, folder or video).')}</p>
              <div><button className="primary" onClick={() => setView({ kind: 'new' })}>{tr('New project')}</button></div>
            </div>
            <div className="card col" style={{ gap: 6 }}>
              <h3 style={{ margin: 0 }}>{tr('Projects')}</h3>
              {projects === null && <div className="tiny muted">{tr('Loading…')}</div>}
              {projects?.length === 0 && <div className="tiny muted">{tr('No projects yet.')}</div>}
              {projects?.map((p) => (
                <div key={p.id} className="row open-studio-item" onClick={() => setView({ kind: 'project', id: p.id })}>
                  <div className="grow"><b>{p.title}</b><div className="tiny muted">{tr('{n} lines', { n: p.events })} · {tr('{n} characters', { n: p.characters })} · {new Date(p.updated_at).toLocaleString(currentLocale())}</div></div>
                  <button className="small" onClick={(e) => { e.stopPropagation(); setView({ kind: 'project', id: p.id }); }}>{tr('open')}</button>
                  <button className="ghost small" onClick={(e) => { e.stopPropagation(); remove(p); }}>{tr('delete')}</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
      {ai && <AiSettingsDialog onClose={() => setAi(false)} />}
    </div>
  );
}
