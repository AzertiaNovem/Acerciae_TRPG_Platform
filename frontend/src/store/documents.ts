import { create } from 'zustand';
import { api } from '../api/client';
import type { DocumentSummary, DocumentFull, DocType } from '../types';
import { sessionEpoch, isStale } from './session';

// Document bodies live here. Highlights live in a separate store so that a highlight arriving every few
// seconds never re-renders the markdown of every entry.
interface DocState {
  list: DocumentSummary[];
  full: Record<string, DocumentFull>;
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
export const useDocuments = create<DocState>((set, get) => ({
  list: [], full: {}, seenVersion: JSON.parse(localStorage.getItem('acerciae.seen') || '{}'), pulse: {}, expandedId: null, dockCollapsed: false, focusEntryId: null,
  loadList: async (ch) => { const e = sessionEpoch(); const list = await api.documents(ch); if (isStale(e)) return; set({ list }); },
  loadDocument: async (ch, id, sceneId) => {
    const since = get().seenVersion[id] ?? -1;
    const e = sessionEpoch();
    try {
      const doc = await api.document(ch, id, sceneId, since);
      if (isStale(e)) return;
      set((s) => ({ full: { ...s.full, [id]: doc } }));
    } catch {
      // A document that no longer exists in this context must not keep showing cached content.
      if (!isStale(e)) set((s) => { const full = { ...s.full }; delete full[id]; return { full, expandedId: s.expandedId === id ? null : s.expandedId }; });
    }
  },
  expand: (id) => { set({ expandedId: id, dockCollapsed: false }); if (id) get().markSeen(id); },
  toggleDock: () => set((s) => ({ dockCollapsed: !s.dockCollapsed, expandedId: s.dockCollapsed ? s.expandedId : null })),
  markSeen: (id) => set((s) => {
    const v = s.full[id]?.version ?? s.list.find((d) => d.id === id)?.version ?? 0;
    const seen = { ...s.seenVersion, [id]: v };
    localStorage.setItem('acerciae.seen', JSON.stringify(seen));
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
  reset: () => set({ list: [], full: {}, pulse: {}, expandedId: null, focusEntryId: null }),
  focusEntry: (entryId) => set({ focusEntryId: entryId }),
  byType: (t) => get().list.find((d) => d.doc_type === t),
}));
