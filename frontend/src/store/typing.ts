import { create } from 'zustand';

// Who is being written as right now, per character (the flag is the character's, not the user's). Fed by the chat
// socket's `typing.changed` and `typing.snapshot`. The server announces a flag once when it goes up and once when it
// falls (the writer's heartbeats are not relayed) and sends the whole list after every subscription, so a flag stays
// up here until it is lowered; STALE_MS is only a last resort for a fall that never arrived, long enough that nobody
// composing a long paragraph loses their pen.
const STALE_MS = 10 * 60000;
interface TypingState {
  byCharacter: Record<string, { windowId: string; since: number; until: number }>;
  changed: (m: { character_id: string; chat_window_id: string; active: boolean }) => void;
  snapshot: (list: { character_id: string; chat_window_id: string }[]) => void;
  prune: () => void;
  reset: () => void;
}
export const useTyping = create<TypingState>((set, get) => ({
  byCharacter: {},
  changed: (m) => set((s) => {
    const next = { ...s.byCharacter };
    if (m.active) next[m.character_id] = { windowId: m.chat_window_id, since: next[m.character_id]?.since ?? Date.now(), until: Date.now() + STALE_MS };
    else delete next[m.character_id];
    return { byCharacter: next };
  }),
  snapshot: (list) => set(() => { const now = Date.now(); const next: TypingState['byCharacter'] = {}; for (const x of list) next[x.character_id] = { windowId: x.chat_window_id, since: now, until: now + STALE_MS }; return { byCharacter: next }; }),
  prune: () => { const now = Date.now(); const cur = get().byCharacter; if (!Object.values(cur).some((x) => x.until <= now)) return; set({ byCharacter: Object.fromEntries(Object.entries(cur).filter(([, x]) => x.until > now)) }); },
  reset: () => set({ byCharacter: {} }),
}));
