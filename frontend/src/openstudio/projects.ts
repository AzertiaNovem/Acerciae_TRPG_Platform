// Open projects, held outside the UI: the project view shows one, and AI tasks keep writing their results into it
// (and to disk) after the view is closed. Every change is applied to the latest copy and saved half a second after
// the last one. A project leaves memory once no view shows it and no task works on it.
import { create } from 'zustand';
import type { Project } from './types';
import { loadProject, saveProject } from './storage';
import { SaveQueue } from './saveQueue';
import { ProjectLeases } from './projectLeases';

interface ProjectsState { projects: Record<string, Project>; saveErrors: Record<string, string> }
export const useProjects = create<ProjectsState>(() => ({ projects: {}, saveErrors: {} }));

// How projects are read and written; tests replace it.
export const persistence = {
  load: (id: string) => loadProject(id),
  save: (p: Project) => saveProject(p),
  onError: (e: unknown) => console.error('Open Log Studio: could not save the project', e),
};

const queue = new SaveQueue<Project>({
  read: getProject, write: p => persistence.save(p),
  error: (id, e) => {
    useProjects.setState(s => ({ saveErrors: { ...s.saveErrors, [id]: e instanceof Error ? e.message : String(e) } }));
    persistence.onError(e);
  },
  saved: id => useProjects.setState(s => { const saveErrors = { ...s.saveErrors }; delete saveErrors[id]; return { saveErrors }; }),
});
export const projectSaveState = (id: string) => queue.state(id);
const leases = new ProjectLeases();
const pending = new Map<string, Promise<Project>>();
const generations = new Map<string, number>();
const deleting = new Set<string>();
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (queue.dirty()) { event.preventDefault(); event.returnValue = ''; }
});

export function getProject(id: string): Project | undefined { return useProjects.getState().projects[id]; }

/** The project, from memory or from disk. */
export function openProject(id: string): Promise<Project> {
  if (deleting.has(id)) return Promise.reject(new Error("Project is being deleted"));
  const have = getProject(id);
  if (have) return Promise.resolve(have);
  let p = pending.get(id);
  if (!p) {
    const generation = generations.get(id);
    p = persistence.load(id).then((project) => {
      if (generation !== generations.get(id)) throw new Error("Project was deleted while loading");
      // A copy that arrived meanwhile (or was changed meanwhile) wins over the one read from disk.
      const cur = getProject(id);
      if (cur) return cur;
      useProjects.setState((s) => ({ projects: { ...s.projects, [id]: project } }));
      return project;
    }).finally(() => { if (pending.get(id) === p) pending.delete(id); });
    pending.set(id, p);
  }
  return p;
}

/** Applies a change to the latest copy of an open project and schedules the save. False when it is not open. */
export function updateProject(id: string, fn: (draft: Project) => void): boolean {
  const cur = getProject(id);
  if (!cur) return false;
  const next: Project = structuredClone(cur);
  fn(next);
  useProjects.setState((s) => ({ projects: { ...s.projects, [id]: next } }));
  queue.edited(id);
  return true;
}

/** Serialize saves; a failed write keeps the latest edit in memory and remains retryable. */
export function flushProject(id: string): Promise<boolean> { return queue.flush(id); }

function evictIfIdle(id: string) {
  if (leases.active(id)) return;
  void flushProject(id).then((saved) => {
    if (!saved || queue.dirty(id)) return;
    if (leases.active(id)) return;
    useProjects.setState((s) => { const projects = { ...s.projects }; delete projects[id]; return { projects }; });
  });
}

/** A view shows the project: it stays in memory until the view is gone. Returns the release. */
export function viewProject(id: string): () => void { return leases.retain(id, 'view', () => evictIfIdle(id)); }

/** A generation task keeps its project resident independently of the editor. */
export function holdProject(id: string): () => void { return leases.retain(id, 'task', () => evictIfIdle(id)); }

/** Drain in-flight writes before deleting storage; late loads and task edits cannot resurrect this copy. */
export async function forgetProject(id: string, remove?: () => Promise<void>): Promise<void> {
  if (deleting.has(id)) throw new Error("Project is being deleted");
  const previous = getProject(id);
  deleting.add(id);
  generations.set(id, (generations.get(id) ?? 0) + 1);
  pending.delete(id);
  useProjects.setState(s => {
    const projects = { ...s.projects }, saveErrors = { ...s.saveErrors };
    delete projects[id]; delete saveErrors[id]; return { projects, saveErrors };
  });
  try {
    await queue.discard(id);
    await remove?.();
  } catch (error) {
    if (previous) {
      useProjects.setState(s => ({ projects: { ...s.projects, [id]: previous } }));
      queue.edited(id);
    }
    throw error;
  } finally { deleting.delete(id); }
}
