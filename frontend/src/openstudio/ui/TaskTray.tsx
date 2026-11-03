import { t as tr } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { useUi } from '../../store/ui';
import { cancelTask, clearFinishedTasks, dismissTask, pool, taskEvents, useTasks, type StudioTask } from '../tasks';

export function taskLabel(t: StudioTask): string {
  switch (t.kind) {
    case 'compose': return tr('Composing the script');
    case 'continue': return tr('Continuing the story');
    case 'paint': return tr('Painting backgrounds and poses');
    case 'voice': return tr('Voicing the lines');
    default: return tr('Painting {what}', { what: t.subject });
  }
}
export function conflictText(code: string | null | undefined): string {
  if (code === 'same') return tr('This is already running.');
  if (code === 'script-running') return tr('Wait until the script is written.');
  if (code === 'script-in-use') return tr('Art or voices for this script are still being made; the script can change when they are done.');
  return String(code ?? '');
}

// Finished tasks are announced wherever the user is in the app.
taskEvents.finished = (t) => {
  const toast = useUi.getState().toast;
  if (t.status === 'failed') { toast(`${taskLabel(t)}: ${t.error}`, 'error'); return; }
  if (t.status === 'waiting') { toast(`${t.projectTitle ? `${t.projectTitle}: ` : ''}${tr('The script editor has questions about {n} parts; answer them in Visual novel', { n: Number(t.result) || 1 })}`, 'ai'); return; }
  if (t.status !== 'done') return;
  const [a, b] = t.result.split('/').map(Number);
  let text = t.kind === 'compose' ? tr('Composed: {scenes} scenes, {shown} lines', { scenes: a, shown: b })
    : t.kind === 'continue' ? tr('Continued: {n} new lines, {scenes} new scenes', { n: a, scenes: b })
    : tr('{task} — done', { task: taskLabel(t) });
  if (t.projectTitle) text = `${t.projectTitle}: ${text}`;
  if (t.failures.length) text += ` · ${tr('{n} could not be made', { n: t.failures.length })}`;
  toast(text, t.failures.length ? 'error' : 'ai');
};

// One task: what it does, how far it is, and Stop (or ✕ once it has ended).
export function TaskRow({ task: t, project }: { task: StudioTask; project?: boolean }) {
  const running = t.status === 'running';
  const status = running ? (t.total ? `${t.done}/${t.total}` : tr('Starting…')) : t.status === 'done' ? tr('Done') : t.status === 'waiting' ? tr('waiting for your answers') : t.status === 'cancelled' ? tr('Stopped') : tr('Failed');
  return (
    <div className={`studio-task ${t.status}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className="tiny"><b>{taskLabel(t)}</b>{project && t.projectTitle ? <span className="muted"> · {t.projectTitle}</span> : null}</span>
        <span className="grow" />
        <span className="tiny muted">{status}</span>
        {running ? <button className="ghost small" onClick={() => cancelTask(t.id)}>{tr('Stop')}</button>
          : <button className="ghost small" aria-label={tr('Dismiss')} onClick={() => dismissTask(t.id)}>✕</button>}
      </div>
      {running && <div className="studio-task-bar"><span style={{ width: `${t.total ? Math.round((t.done / t.total) * 100) : 4}%` }} /></div>}
      {t.status === 'failed' && <div className="tiny" style={{ color: 'var(--danger)', overflowWrap: 'anywhere' }}>{t.error}</div>}
      {t.failures.length > 0 && <details className="tiny"><summary style={{ color: 'var(--danger)' }}>{tr('{n} could not be made', { n: t.failures.length })}</summary>{t.failures.slice(0, 30).map((f, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>{f}</div>)}</details>}
    </div>
  );
}

// The header's task list: every AI task of every project, running or recently ended, and how busy the pool is.
export default function TaskTray() {
  const tasks = useTasks((s) => s.tasks);
  const active = useTasks((s) => s.active);
  const waiting = useTasks((s) => s.waiting);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!tasks.length) return null;
  const running = tasks.filter((t) => t.status === 'running').length;
  return (
    <div className="studio-tasks" ref={box}>
      <button className={running ? 'small' : 'ghost small'} aria-expanded={open} onClick={() => setOpen(!open)}>
        {running ? <span className="studio-tasks-dot" aria-hidden /> : null}{running ? tr('AI tasks: {n} running', { n: running }) : tr('AI tasks')}
      </button>
      {open && (
        <div className="studio-tasks-panel card col" role="dialog" aria-label={tr('AI tasks')}>
          <div className="tiny muted">{tr('Requests: {active} of {limit} at a time, {waiting} waiting. Change the limit in AI services.', { active, limit: pool.limit(), waiting })}</div>
          {[...tasks].reverse().map((t) => <TaskRow key={t.id} task={t} project />)}
          {tasks.some((t) => t.status !== 'running') && <button className="ghost small" style={{ alignSelf: 'flex-end' }} onClick={clearFinishedTasks}>{tr('Clear finished')}</button>}
        </div>
      )}
    </div>
  );
}
