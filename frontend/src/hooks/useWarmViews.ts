// Populate lightweight views advertised to this viewer, one request at a time between interactions.
// Never follow asset URLs, fetch chat history, or run a generator as part of this pass.
import { useEffect } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useDocuments } from '../store/documents';
import { sessionEpoch } from '../store/session';

export function useWarmViews() {
  const ch = useNav(s => s.channelId);
  const role = useNav(s => s.channel?.my_role);
  const rosterKey = useNav(s => s.characters.map(c=>c.id).join(','));
  const docKey = useDocuments(s => s.list.map(d=>d.id).join(','));
  useEffect(() => {
    if (!ch) return;
    let stopped = false, timer = 0, idle = 0;
    const opts = { maxAge: 60_000 };
    function* work() {
      const nav = useNav.getState(), docs = useDocuments.getState();
      if (nav.channelId !== ch) return;
      const id = ch!;
      for (const c of nav.characters) yield () => api.characterSpace(id, c.id, opts);
      if (role === 'gm') {
        yield () => api.scriptKnowledge(id, undefined, opts);
        yield () => api.gmWorkspace(id, opts);
        yield () => api.aiStatus(id, opts);
        yield () => api.channelMembers(id, opts);
        for (const d of docs.list) {
          const scene = nav.windows.find(w => w.id === nav.windowId)?.active_scene_id ?? undefined;
          yield () => api.document(id, d.id, scene, d.version, opts);
          yield () => api.document(id, d.id, 'all', undefined, opts);
        }
      }
      if (nav.channel?.rule_system === 'dnd2024') for (const w of nav.windows) yield () => api.initiative(id, w.id, opts);
    }
    let tasks = work(), epoch = sessionEpoch();
    const schedule = (delay: number) => {
      if (stopped) return;
      timer = window.setTimeout(() => {
        if (document.hidden) { schedule(2000); return; }
        if ('requestIdleCallback' in window) idle = window.requestIdleCallback(step, { timeout: 1500 });
        else void step();
      }, delay);
    };
    const step = async () => {
      if (stopped) return;
      if (epoch !== sessionEpoch()) { tasks = work(); epoch = sessionEpoch(); }
      const next = tasks.next();
      if (next.done) { tasks = work(); schedule(60000); return; }
      try { await next.value(); } catch { /* user navigation and temporary failures take priority */ }
      schedule(60);
    };
    schedule(450);
    return () => { stopped = true; clearTimeout(timer); if (idle) window.cancelIdleCallback(idle); };
  }, [ch, role, rosterKey, docKey]);
}
