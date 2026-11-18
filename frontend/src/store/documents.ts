import { create } from 'zustand';
import { readJson, writeStorage } from '../lib/storage';
import { api } from '../api/client';
import type { DocumentSummary, DocumentFull, DocType } from '../types';
import { sessionEpoch, isStale } from './session';

// Document bodies live here. Highlights live in a separate store so that a highlight arriving every few
// seconds never re-renders the markdown of every entry.
interface DocState {
  list: DocumentSummary[];
  full: Record<string, DocumentFull>;
  fullScene: Record<string, string | undefined>;
  seenVersion: Record<string, number>;         // version the user last looked at (for change badges)
  pulse: Record<string, number>;               // bump to animate a bubble when an update arrives
  expandedId: string | null;
  dockCollapsed: boolean;
  focusEntryId: string | null;
  loadList: (ch: string) => Promise<void>;
  loadDocument: (ch: string, id: string, sceneId?: string) => Promise<void>;
  expand: (id: string | null) => void;
  toggleDock: () => void;
  markSeen: (id: string) => void;
  onUpdated: (payload: { document_id: string; version: number; change_count: number; doc_type: DocType; entry_ids?: string[] }, ch: string, sceneId?: string) => void;
  focusEntry: (entryId: string | null) => void;
  byType: (t: DocType) => DocumentSummary | undefined;
  reset: () => void;
}
let documentRead = 0;
export const useDocuments = create<DocState>((set, get) => ({
  list: [], full: {}, fullScene: {}, seenVersion: readJson<Record<string, number>>('acerciae.seen', {}), pulse: {}, expandedId: null, dockCollapsed: false, focusEntryId: null,
  loadList: async (ch) => {
    const e = sessionEpoch();
    const apply = (list: DocumentSummary[]) => {
      if (isStale(e) || get().list === list) return;
      set(s => ({ list, full: Object.fromEntries(Object.entries(s.full).filter(([id]) => list.some(d => d.id === id))), expandedId: list.some(d => d.id === s.expandedId) ? s.expandedId : null }));
    };
    apply(await api.documents(ch, { cached: apply }));
  },
  loadDocument: async (ch, id, sceneId) => {
    const since = get().seenVersion[id] ?? -1, e = sessionEpoch(), call = ++documentRead;
    const current = () => !isStale(e) && call === documentRead;
    const apply = (doc: DocumentFull) => {
      if (!current() || (get().full[id] === doc && get().fullScene[id] === sceneId)) return;
      set(s => ({ full: { ...s.full, [id]: doc }, fullScene: { ...s.fullScene, [id]: sceneId } }));
    };
    try { apply(await api.document(ch, id, sceneId, since, { cached: apply })); }
    catch (err) {
      if (current() && [401,403,404].includes((err as {status:number}).status))
        set(s => { const full = { ...s.full }; delete full[id]; return { full, expandedId: s.expandedId === id ? null : s.expandedId }; });
    }
  },
  expand: (id) => { set({ expandedId: id, dockCollapsed: false }); if (id) get().markSeen(id); },
  toggleDock: () => set((s) => ({ dockCollapsed: !s.dockCollapsed, expandedId: s.dockCollapsed ? s.expandedId : null })),
  markSeen: (id) => set((s) => {
    const v = s.full[id]?.version ?? s.list.find((d) => d.id === id)?.version ?? 0;
    const seen = { ...s.seenVersion, [id]: v };
    writeStorage('acerciae.seen', JSON.stringify(seen));
    return { seenVersion: seen };
  }),
  onUpdated: (p, ch, sceneId) => {
    set((s) => ({
      list: s.list.map((d) => (d.id === p.document_id ? { ...d, version: p.version, recent_changes: d.recent_changes + p.change_count } : d)),
      pulse: { ...s.pulse, [p.document_id]: Date.now() },
    }));
    // Refresh the body when it is open or when the summary list needs the preview; never touches the composer.
    if (get().expandedId === p.document_id) get().loadDocument(ch, p.document_id, sceneId);
    get().loadList(ch).catch(() => undefined);
  },
  reset: () => set({ list: [], full: {}, fullScene: {}, pulse: {}, expandedId: null, focusEntryId: null }),
  focusEntry: (entryId) => set({ focusEntryId: entryId }),
  byType: (t) => get().list.find((d) => d.doc_type === t),
}));
