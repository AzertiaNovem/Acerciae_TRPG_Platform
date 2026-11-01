// Open projects, held outside the UI: the project view shows one, and AI tasks keep writing their results into it
// (and to disk) after the view is closed. Every change is applied to the latest copy and saved half a second after
// the last one. A project leaves memory once no view shows it and no task works on it.
import { create } from 'zustand';
import type { Project } from './types';
import { loadProject, saveProject } from './storage';

interface ProjectsState { projects: Record<string, Project> }
export const useProjects = create<ProjectsState>(() => ({ projects: {} }));

// How projects are read and written; tests replace it.
export const persistence = {
  load: (id: string) => loadProject(id),
  save: (p: Project) => saveProject(p),
  onError: (e: unknown) => console.error('Open Log Studio: could not save the project', e),
};

const SAVE_DELAY_MS = 500;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Promise<Project>>();
const viewers = new Map<string, number>();
const holders = new Map<string, number>();   // running tasks per project

export function getProject(id: string): Project | undefined { return useProjects.getState().projects[id]; }

/** The project, from memory or from disk. */
export function openProject(id: string): Promise<Project> {
  const have = getProject(id);
  if (have) return Promise.resolve(have);
  let p = pending.get(id);
  if (!p) {
    p = persistence.load(id).then((project) => {
      // A copy that arrived meanwhile (or was changed meanwhile) wins over the one read from disk.
      const cur = getProject(id);
      if (cur) return cur;
      useProjects.setState((s) => ({ projects: { ...s.projects, [id]: project } }));
      return project;
    }).finally(() => pending.delete(id));
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
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.set(id, setTimeout(() => { void flushProject(id); }, SAVE_DELAY_MS));
  return true;
}

/** Saves a scheduled change now. */
export async function flushProject(id: string): Promise<void> {
  const t = timers.get(id);
  if (!t) return;
  clearTimeout(t);
  timers.delete(id);
  const p = getProject(id);
  if (!p) return;
  try { await persistence.save(p); } catch (e) { persistence.onError(e); }
}

function evictIfIdle(id: string) {
  if ((viewers.get(id) ?? 0) > 0 || (holders.get(id) ?? 0) > 0) return;
  void flushProject(id).then(() => {
    if ((viewers.get(id) ?? 0) > 0 || (holders.get(id) ?? 0) > 0) return;
    useProjects.setState((s) => { const projects = { ...s.projects }; delete projects[id]; return { projects }; });
  });
}

/** A view shows the project: it stays in memory until the view is gone. Returns the release. */
export function viewProject(id: string): () => void {
  viewers.set(id, (viewers.get(id) ?? 0) + 1);
  return () => { viewers.set(id, Math.max(0, (viewers.get(id) ?? 1) - 1)); evictIfIdle(id); };
}

/** A task works on the project: it stays in memory until the task ends. Returns the release. */
export function holdProject(id: string): () => void {
  holders.set(id, (holders.get(id) ?? 0) + 1);
  let released = false;
  return () => { if (released) return; released = true; holders.set(id, Math.max(0, (holders.get(id) ?? 1) - 1)); evictIfIdle(id); };
}

/** Drops a deleted project without saving it. */
export function forgetProject(id: string) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  useProjects.setState((s) => { const projects = { ...s.projects }; delete projects[id]; return { projects }; });
}
