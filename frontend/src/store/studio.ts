import { create } from 'zustand';
import { api } from '../api/client';
import type { LogProject, LogSnapshot, LogEvent, SceneSummary } from '../types';
import { sessionEpoch, isStale } from './session';

export type StudioView = 'library' | 'import' | 'editor' | 'vn' | 'voice' | 'assets' | 'pdf' | 'published';

interface StudioState {
  view: StudioView;
  projects: LogProject[];
  project: LogProject | null;
  events: LogEvent[];
  scenes: SceneSummary[];
  snapshots: LogSnapshot[];
  snapshot: LogSnapshot | null;
  presentationId: string | null;
  busy: boolean;
  setView: (v: StudioView) => void;
  loadProjects: (ch: string) => Promise<void>;
  openProject: (ch: string, id: string | null) => Promise<void>;
  reloadEvents: (ch: string) => Promise<void>;
  openSnapshot: (ch: string, id: string | null) => Promise<void>;
  setPresentation: (id: string | null) => void;
  reset: () => void;
}
export const useStudio = create<StudioState>((set, get) => ({
  view: 'library', projects: [], project: null, events: [], scenes: [], snapshots: [], snapshot: null, presentationId: null, busy: false,
  setView: (v) => set({ view: v }),
  loadProjects: async (ch) => { const e = sessionEpoch(); const projects = await api.studioProjects(ch); if (isStale(e)) return; set({ projects }); },
  openProject: async (ch, id) => {
    if (!id) { set({ project: null, events: [], scenes: [], snapshots: [], snapshot: null, presentationId: null }); return; }
    const e = sessionEpoch(); set({ busy: true });
    try {
      const [project, events] = await Promise.all([api.studioProject(ch, id), api.studioEvents(ch, id)]);
      if (isStale(e)) return;
      set({ project, events, scenes: project.scenes ?? [], snapshots: project.snapshots ?? [], snapshot: null, presentationId: null });
    } finally { if (!isStale(e)) set({ busy: false }); }
  },
  reloadEvents: async (ch) => { const p = get().project; if (!p) return; const e = sessionEpoch(); const [project, events] = await Promise.all([api.studioProject(ch, p.id), api.studioEvents(ch, p.id)]); if (isStale(e)) return; set({ project, events, scenes: project.scenes ?? [], snapshots: project.snapshots ?? [] }); },
  openSnapshot: async (ch, id) => { if (!id) { set({ snapshot: null }); return; } const e = sessionEpoch(); const snapshot = await api.studioSnapshot(ch, id, true); if (isStale(e)) return; set({ snapshot }); },
  setPresentation: (id) => set({ presentationId: id }),
  reset: () => set({ view: 'library', projects: [], project: null, events: [], scenes: [], snapshots: [], snapshot: null, presentationId: null, busy: false }),
}));
