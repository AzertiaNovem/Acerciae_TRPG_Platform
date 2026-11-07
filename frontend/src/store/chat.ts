import { create } from 'zustand';
import { useUi } from './ui';
import { api } from '../api/client';
import type { Channel, Message } from '../types';
import { sessionEpoch, isStale } from './session';
import { readHistory, writeHistory, dropHistory } from '../lib/chatHistory';

// A recall is final: a copy fetched before it (a reload still in flight) never replaces the tombstone.
const keep = (prev: Message | undefined, next: Message) => !(prev?.recalled_at && !next.recalled_at);
function merge(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) if (keep(byId.get(m.id), m)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

// When each message stops being recallable, from `recall_seconds_left` the first time it arrived (local clock).
const recallDeadlines = new Map<string, number>();
export function recallDeadline(m: Message): number | null {
  if (m.recalled_at || !m.recall_seconds_left) return null;
  const seen = recallDeadlines.get(m.id);
  const now = Date.now() + m.recall_seconds_left * 1000;
  if (seen === undefined || now < seen) recallDeadlines.set(m.id, now);
  return recallDeadlines.get(m.id)!;
}
// The server's refusals, in words the interface translates.
export function recallError(err: any): string {
  if (err?.code === 'recall_expired') return 'Messages can only be recalled within 2 minutes of sending.';
  if (err?.code === 'not_recallable') return "This message can't be recalled.";
  return err?.message ?? String(err);
}

// ---- the history of each window ---------------------------------------------------------------------------------
// A window's lines are kept here for the visit and on this device between visits (lib/chatHistory), so switching to
// a window shows what was read before at once and scrolling up goes through what is already here. Lines pushed over
// the chat stream are recorded as they arrive, in every window of the channel. Fetching only makes up for what the
// stream could not deliver:
// - While the stream stayed subscribed to the channel since a window was last brought up to date, every line of it
//   was pushed and recorded: opening the window asks the server for nothing.
// - Otherwise (the socket dropped, another channel was open, the page was reloaded) opening it asks for the lines
//   after the last one kept (`after_seq`), from a little earlier when recent lines are kept, so that one recalled in
//   the meantime turns into its tombstone. A gap too long to page through starts again from the newest lines.
// - Scrolling up asks for older lines until the window's first line has been reached.
// Each window keeps one contiguous block of lines, as `Span`: `from` its first seq, `through` the seq up to which it
// is complete, `complete` when it reaches the window's first line, `live` the chat stream subscription it is kept
// current by. A message opened elsewhere (a reference, a hint) may sit outside the block for this visit only.
export interface Span { channelId: string; access: string; from: number; through: number; complete: boolean; live: number | null }
export const PAGE = 80;              // the newest lines, and each step back
export const CATCH_UP_PAGE = 200;    // each step forward when catching up
export const CATCH_UP_PAGES = 5;     // beyond this many lines missed, start again from the newest
export const RECENT_MS = 5 * 60 * 1000;    // lines this recent are read again on catching up (a recall takes 2 minutes at most)
export const RECENT_LINES = 50;            // ... among the newest ones kept

// The viewer's access to a channel's lines: kept history read under another access is never shown.
export const accessKey = (c: Pick<Channel, 'my_role' | 'player_group_id' | 'player_group_version' | 'knowledge_mode'> | null | undefined) =>
  c ? [c.my_role, c.player_group_id ?? '', c.player_group_version ?? '', c.knowledge_mode ?? ''].join('|') : '';

// The chat stream's current subscription: lines of its channel arrive by push from the moment it was confirmed.
let stream: { gen: number; channelId: string } | null = null;
let streamGen = 0;
const live = (span: Span | undefined) => !!span && !!stream && span.live === stream.gen && span.channelId === stream.channelId;

interface ChatState {
  byWindow: Record<string, Message[]>;
  spans: Record<string, Span>;
  loading: Record<string, boolean>;
  references: Message[];
  addReference: (message: Message) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;
  jumpTo: { messageId: string; nonce: number } | null;
  // Shows the window from what is kept, then fetches only what the chat stream did not deliver.
  open: (channelId: string, windowId: string, access: string) => Promise<void>;
  // Brings a window up to date from the server (open calls it when the stream did not keep the window current).
  catchUp: (channelId: string, windowId: string, access: string) => Promise<void>;
  loadOlder: (channelId: string, windowId: string) => Promise<void>;
  push: (m: Message) => void;
  // A recalled line's tombstone takes its place in every window that shows it (forks show their parents' lines).
  applyRecall: (tombstone: Message) => void;
  // The author's own recall; the text comes back as a draft for "Re-edit".
  recall: (m: Message) => Promise<void>;
  recallDrafts: Record<string, string>;
  // The chat stream confirmed (or lost) its subscription to a channel.
  streamUp: (channelId: string) => void;
  streamDown: () => void;
  // The viewer's access changed or the window is gone: what was kept is thrown away.
  forgetChannel: (channelId: string) => void;
  forgetWindow: (windowId: string) => void;
  requestJump: (messageId: string) => void;
  clearJump: () => void;
  reset: () => void;
}
const olderInFlight = new Set<string>();
const catching = new Map<string, Promise<void>>();

// Kept on this device shortly after it changes: the contiguous block only.
function persist(w: string) {
  writeHistory(w, () => {
    const s = useChat.getState(); const span = s.spans[w];
    if (!span || !span.through) return null;
    return { windowId: w, channelId: span.channelId, access: span.access, messages: (s.byWindow[w] ?? []).filter((m) => m.seq >= span.from), from: span.from, through: span.through, complete: span.complete };
  });
}
// Where catching up starts: after the last line known, or before the oldest recent line kept, so a recall made since
// it was read comes back as its tombstone.
export function resumeAfter(lines: Message[], span: Span, now = Date.now()): number {
  const block = lines.filter((m) => m.seq >= span.from && m.seq <= span.through);
  const recent = block.slice(-RECENT_LINES).find((m) => !m.recalled_at && Date.parse(m.created_at) > now - RECENT_MS);
  return recent ? Math.min(span.through, recent.seq - 1) : span.through;
}

export const useChat = create<ChatState>((set, get) => ({
  byWindow: {}, spans: {}, loading: {}, jumpTo: null, references: [], recallDrafts: {},
  addReference: (m) => set(s=>({references:s.references.some(r=>r.id===m.id)?s.references:[...s.references,m].slice(0,5)})),
  removeReference: (id) => set(s=>({references:s.references.filter(m=>m.id!==id)})),
  clearReferences: () => set({references:[]}),
  open: async (ch, w, access) => {
    const e = sessionEpoch();
    let span: Span | undefined = get().spans[w];
    if (span && (span.access !== access || span.channelId !== ch)) { get().forgetWindow(w); span = undefined; }
    if (!span) {
      const kept = await readHistory(w);
      if (isStale(e)) return;
      span = get().spans[w];   // another open may have filled it meanwhile
      if (!span && kept && kept.access === access && kept.channelId === ch && kept.through > 0) {
        span = { channelId: ch, access, from: kept.from, through: kept.through, complete: kept.complete, live: null };
        const restored = span;
        set((s) => ({ byWindow: { ...s.byWindow, [w]: merge(kept.messages, s.byWindow[w] ?? []) }, spans: { ...s.spans, [w]: restored } }));
      } else if (!span && kept) void dropHistory({ windowId: w });
    }
    if (live(span)) return;   // every line since was pushed and recorded
    await get().catchUp(ch, w, access);
  },
  // One at a time per window; again if the stream changed meanwhile.
  catchUp: async (ch, w, access) => {
    const running = catching.get(w);
    if (running) { await running; if (live(get().spans[w]) || isStale(sessionEpoch())) return; }
    const run = (async () => {
      const e = sessionEpoch();
      const at = stream && stream.channelId === ch ? stream.gen : null;   // pushes reach this window from here on
      set((s) => ({ loading: { ...s.loading, [w]: true } }));
      try {
        const span = get().spans[w];
        const newest = async (): Promise<Span | null> => {
          const page = await api.messages(ch, w, undefined, PAGE);
          if (isStale(e)) return null;
          const fresh: Span = { channelId: ch, access, from: page[0]?.seq ?? 0, through: page.length ? page[page.length - 1].seq : 0, complete: page.length < PAGE, live: null };
          // The block starts again here: older lines kept are not known to join it. Lines in memory from its first one on
          // stay (pushed ones, and a recall applied while this was in flight stays final).
          set((s) => ({ byWindow: { ...s.byWindow, [w]: merge((s.byWindow[w] ?? []).filter((m) => !page.length || m.seq >= fresh.from), page) } }));
          return fresh;
        };
        let next: Span | null;
        if (span && span.through > 0) {
          let after = resumeAfter(get().byWindow[w] ?? [], span);
          const fetched: Message[] = []; let full = false;
          for (let pages = 0; ; pages++) {
            const page = await api.messagesAfter(ch, w, after, CATCH_UP_PAGE);
            if (isStale(e)) return;
            fetched.push(...page);
            if (page.length) after = page[page.length - 1].seq;
            if (page.length < CATCH_UP_PAGE) break;
            if (pages + 1 >= CATCH_UP_PAGES) { full = true; break; }
          }
          if (full) next = await newest();   // too much was missed to page through: start again from the newest lines
          else {
            next = { ...span, through: Math.max(span.through, after), live: null };
            set((s) => ({ byWindow: { ...s.byWindow, [w]: merge(s.byWindow[w] ?? [], fetched) } }));
          }
        } else next = await newest();   // nothing kept: the newest lines
        if (!next) return;
        // Current from now on only if the stream was subscribed before the request and still is.
        next.live = at !== null && stream?.gen === at ? at : null;
        set((s) => ({ spans: { ...s.spans, [w]: next } }));
        persist(w);
      } catch (err: any) { if (!isStale(e)) useUi.getState().toast(err.message, 'error'); }
      finally { if (!isStale(e)) set((s) => ({ loading: { ...s.loading, [w]: false } })); }
    })();
    catching.set(w, run);
    try { await run; } finally { if (catching.get(w) === run) catching.delete(w); }
  },
  loadOlder: async (ch, w) => {
    const cur = get().byWindow[w] ?? [];
    const span = get().spans[w];
    // Not before the window has been opened (its block is known), never past its first line; scrolling fires this many
    // times: one request at a time.
    if (!cur.length || !span || span.complete || olderInFlight.has(w)) return;
    olderInFlight.add(w);
    const e = sessionEpoch();
    try {
      const before = span.from || cur[0].seq;
      const older = await api.messages(ch, w, before, PAGE);
      if (isStale(e)) return;
      set((s) => {
        const sp = s.spans[w];
        return {
          byWindow: { ...s.byWindow, [w]: merge(s.byWindow[w] ?? [], older) },
          spans: sp ? { ...s.spans, [w]: { ...sp, from: older.length ? Math.min(sp.from, older[0].seq) : sp.from, complete: older.length < PAGE } } : s.spans,
        };
      });
      persist(w);
    } catch (err: any) { useUi.getState().toast(err.message, 'error'); }
    finally { olderInFlight.delete(w); }
  },
  push: (m) => {
    const w = m.chat_window_id;
    const s = get(); const list = s.byWindow[w] ?? [];
    if (list.some((x) => x.id === m.id)) return;
    const span = s.spans[w];
    // A live window is complete through every line pushed to it.
    const spans = span && live(span) && m.seq > span.through ? { ...s.spans, [w]: { ...span, through: m.seq } } : s.spans;
    set({ byWindow: { ...s.byWindow, [w]: merge(list, [m]) }, spans });
    if (span) persist(w);
  },
  applyRecall: (tombstone) => {
    const touched: string[] = [];
    set((s) => {
      const byWindow: Record<string, Message[]> = {};
      for (const [w, list] of Object.entries(s.byWindow)) {
        if (list.some((m) => m.id === tombstone.id)) { touched.push(w); byWindow[w] = list.map((m) => (m.id === tombstone.id ? tombstone : m)); }
        else byWindow[w] = list;
      }
      return { byWindow, references: s.references.filter((m) => m.id !== tombstone.id) };
    });
    for (const w of touched) persist(w);
  },
  recall: async (m) => {
    const e = sessionEpoch();
    try {
      const r = await api.recallMessage(m.channel_id, m.id);
      if (isStale(e)) return;
      get().applyRecall(r.message);
      if (r.content) set((s) => ({ recallDrafts: { ...s.recallDrafts, [m.id]: r.content } }));
    } catch (err: any) { if (!isStale(e)) useUi.getState().toast(recallError(err), 'error'); }
  },
  streamUp: (channelId) => { stream = { gen: ++streamGen, channelId }; },
  streamDown: () => { stream = null; },
  forgetChannel: (channelId) => {
    set((s) => {
      const byWindow = { ...s.byWindow }, spans = { ...s.spans };
      for (const [w, span] of Object.entries(s.spans)) if (span.channelId === channelId) { delete byWindow[w]; delete spans[w]; }
      return { byWindow, spans };
    });
    void dropHistory({ channelId });
  },
  forgetWindow: (w) => {
    set((s) => { const byWindow = { ...s.byWindow }, spans = { ...s.spans }; delete byWindow[w]; delete spans[w]; return { byWindow, spans }; });
    void dropHistory({ windowId: w });
  },
  requestJump: (messageId) => set({ jumpTo: { messageId, nonce: Date.now() } }),
  clearJump: () => set({ jumpTo: null }),
  // The visit's copy only; what is kept on this device stays (signing out clears it, see store/auth).
  reset: () => { recallDeadlines.clear(); catching.clear(); set({ byWindow: {}, spans: {}, loading: {}, jumpTo: null, references: [], recallDrafts: {} }); },
}));
