import type { Message } from '../types';
import { readStorage, writeStorage } from './storage';

// The chat history of each window, kept on this device (IndexedDB) so that a window opens at once with what was read
// before, even after a reload, scrolling up goes through what is already here, and opening a window only asks the
// server for what came after (see store/chat.ts).
//
// Each entry is one window's contiguous block of lines: every line the viewer may read from `from` to `through`
// (seq), and `complete` when it reaches back to the window's first line. It records the viewer's access when the
// lines were read (role, player group and its version, knowledge mode); under any other access it is thrown away
// unread. Entries are scoped to the signed-in account and server like the media cache: another account signing in on
// this browser empties it, and signing out removes the account's history. Only the newest HISTORY_KEPT lines of a
// window and the HISTORY_WINDOWS most recently opened windows are kept. Without IndexedDB (private windows, blocked
// storage) or on any error nothing is kept and the app reads from the server as before.
export const HISTORY_KEPT = 1500;
export const HISTORY_WINDOWS = 150;
const DB = 'acerciae-chat', STORE = 'windows', DB_VERSION = 1;
const OWNER_KEY = 'acerciae.chat-history-owner';
const WRITE_DELAY_MS = 400;   // a burst of pushes is one write

export interface WindowHistory {
  windowId: string; channelId: string; access: string;
  messages: Message[];          // oldest first
  from: number; through: number; complete: boolean;
}
interface Entry extends WindowHistory { key: string; scope: string; openedAt: number }

let scope = '';
let dbPromise: Promise<IDBDatabase | null> | null = null;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; entry: () => WindowHistory | null }>();

// The signed-in account (and server). Another account than the one that filled the history here empties it first
// (the desktop app keeps several accounts side by side).
export function setHistoryScope(s: string, keepOtherScopes = false) {
  cancelWrites();
  scope = s;
  const previous = readStorage(OWNER_KEY);
  if (!keepOtherScopes && previous && previous !== s) void clearHistory(true);
  writeStorage(OWNER_KEY, s);
}

// Keeps at most `kept` lines, the newest; the block no longer starts at the first line once trimmed. A kept copy never
// offers a recall (`recall_seconds_left` counted from when it was fetched; recent lines are read again on opening),
// and the search vector the API sends along is not worth the space.
export function trimHistory(h: WindowHistory, kept = HISTORY_KEPT): WindowHistory {
  const lines = h.messages.filter((m) => m.seq >= h.from).map(({ search: _search, recall_seconds_left: _left, ...m }: Message & { search?: unknown }) => m as Message);
  if (lines.length <= kept) return { ...h, messages: lines };
  const rest = lines.slice(lines.length - kept);
  return { ...h, messages: rest, from: rest[0].seq, complete: false };
}

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return dbPromise ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, DB_VERSION);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'key' }); s.createIndex('openedAt', 'openedAt'); s.createIndex('scope', 'scope'); };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbPromise = null; }; resolve(d); };
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
const done = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const keyOf = (windowId: string) => `${scope}|${windowId}`;

export async function readHistory(windowId: string): Promise<WindowHistory | null> {
  if (!scope) return null;
  const d = await db(); if (!d) return null;
  try {
    const e = await done(d.transaction(STORE).objectStore(STORE).get(keyOf(windowId))) as Entry | undefined;
    return e && e.scope === scope ? { windowId: e.windowId, channelId: e.channelId, access: e.access, messages: e.messages, from: e.from, through: e.through, complete: e.complete } : null;
  } catch { return null; }
}

// Writes the window's history shortly (the latest state when the time comes: `entry` is read then).
export function writeHistory(windowId: string, entry: () => WindowHistory | null) {
  if (!scope) return;
  const key = keyOf(windowId);
  const queued = pending.get(key);
  if (queued) { queued.entry = entry; return; }
  const forScope = scope;
  pending.set(key, { entry, timer: setTimeout(() => { const p = pending.get(key); pending.delete(key); if (p && forScope === scope) void store(p.entry()); }, WRITE_DELAY_MS) });
}
async function store(h: WindowHistory | null) {
  if (!h || !scope) return;
  const d = await db(); if (!d) return;
  try {
    const t = trimHistory(h);
    const tx = d.transaction(STORE, 'readwrite'); const s = tx.objectStore(STORE);
    s.put({ ...t, key: keyOf(h.windowId), scope, openedAt: Date.now() } satisfies Entry);
    // The least recently opened windows go once there are too many.
    const total = await done(s.count());
    if (total > HISTORY_WINDOWS) {
      let extra = total - HISTORY_WINDOWS;
      const cursor = s.index('openedAt').openCursor();
      cursor.onsuccess = () => { const c = cursor.result; if (!c || extra <= 0) return; c.delete(); extra--; c.continue(); };
    }
  } catch { /* nothing kept this time */ }
}

// Drops the kept history of one window, or of every window of a channel (access changed, window gone).
export async function dropHistory(match: { windowId?: string; channelId?: string }) {
  if (match.windowId) { const p = pending.get(keyOf(match.windowId)); if (p) { clearTimeout(p.timer); pending.delete(keyOf(match.windowId)); } }
  if (match.channelId) cancelWrites();
  const d = await db(); if (!d || !scope) return;
  try {
    const s = d.transaction(STORE, 'readwrite').objectStore(STORE);
    if (match.windowId) { await done(s.delete(keyOf(match.windowId))); return; }
    const cursor = s.index('scope').openCursor(IDBKeyRange.only(scope));
    await new Promise<void>((resolve) => {
      cursor.onsuccess = () => { const c = cursor.result; if (!c) return resolve(); if ((c.value as Entry).channelId === match.channelId) c.delete(); c.continue(); };
      cursor.onerror = () => resolve();
    });
  } catch { /* nothing to drop */ }
}

// Empties the history of the signed-in account (signing out), or of every account on this browser.
export async function clearHistory(everyone = false) {
  cancelWrites();
  const d = await db(); if (!d) return;
  try {
    const s = d.transaction(STORE, 'readwrite').objectStore(STORE);
    if (everyone || !scope) { await done(s.clear()); return; }
    const cursor = s.index('scope').openCursor(IDBKeyRange.only(scope));
    await new Promise<void>((resolve) => {
      cursor.onsuccess = () => { const c = cursor.result; if (!c) return resolve(); c.delete(); c.continue(); };
      cursor.onerror = () => resolve();
    });
  } catch { /* nothing to clear */ }
}
function cancelWrites() { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); }
