import { getToken } from '../api/client';
import { readStorage, writeStorage } from './storage';

// Media kept on this device. Every media URL carries a short-lived file token, so the browser's own HTTP cache forgets
// a portrait or a background each time the token rotates (a few hours) and the server only allows an hour anyway. A
// stored object never changes once it exists (a new version is a new key on the server), so an asset fetched once can
// be kept for weeks: in IndexedDB, keyed by asset id and version, used from a blob: URL, and evicted only when it has
// not been used for ASSET_CACHE_MAX_AGE_MS or the budget is full (least recently used first). The cache is a comfort,
// never a requirement: without IndexedDB (private windows, blocked storage, old WebViews) or on any error the direct
// URL is used as before.
export const ASSET_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // unused for 30 days → gone
export const ASSET_CACHE_MAX_BYTES = 768 * 1024 * 1024;          // the whole cache
export const ASSET_CACHE_MAX_ITEM_BYTES = 64 * 1024 * 1024;      // bigger files stream from the server every time
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;                        // how often a hit rewrites lastUsed
const DB_NAME = 'acerciae-media', STORE = 'assets', DB_VERSION = 1;
const OWNER_KEY = 'acerciae.media-cache-owner';

export type CacheEntry = { key: string; bytes: number; lastUsed: number; storedAt: number };
type StoredEntry = CacheEntry & { blob: Blob; mime: string };

// ---- keys: only immutable content is cacheable -------------------------------------------------------------------
// A media asset without a version could change under the same URL, so it is not cached.
export const mediaKey = (channelId: string, assetId: string, version?: number | null) => (version ? `media:${channelId}:${assetId}:v${version}` : null);
export const avatarKey = (userId: string, version?: number | null) => (version ? `avatar:${userId}:v${version}` : null);
export const atmosphereKey = (channelId: string, assetId: string) => `atmosphere:${channelId}:${assetId}`;   // one generated image per id
export const ttsKey = (channelId: string, audioId: string) => `tts:${channelId}:${audioId}`;                   // content-addressed by the server

// ---- eviction: expired entries, then the least recently used until the rest fits the budget -------------------------
export function planEviction(entries: CacheEntry[], now: number, limits = { maxAgeMs: ASSET_CACHE_MAX_AGE_MS, maxBytes: ASSET_CACHE_MAX_BYTES }): string[] {
  const drop: string[] = [];
  const kept: CacheEntry[] = [];
  for (const e of entries) (now - e.lastUsed > limits.maxAgeMs ? drop : kept).push(e as any);
  const dropped = new Set(drop.map((e: any) => e.key));
  let total = kept.reduce((n, e) => n + e.bytes, 0);
  for (const e of [...kept].sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= limits.maxBytes) break;
    dropped.add(e.key); total -= e.bytes;
  }
  return [...dropped];
}

// ---- IndexedDB --------------------------------------------------------------------------------------------------------
let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('lastUsed', 'lastUsed'); };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) { resolve(undefined); return; }
    try {
      const t = db.transaction(STORE, mode);
      let result: T | undefined;
      const r = run(t.objectStore(STORE));
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}
const readEntry = (key: string) => tx<StoredEntry>('readonly', (s) => s.get(key));
const writeEntry = (e: StoredEntry) => tx<IDBValidKey>('readwrite', (s) => s.put(e));
const allEntries = () => tx<StoredEntry[]>('readonly', (s) => s.getAll());
const deleteKeys = (keys: string[]) => tx<void>('readwrite', (s) => { for (const k of keys) s.delete(k); });

export async function cacheStats(): Promise<{ entries: number; bytes: number }> {
  const all = (await allEntries()) ?? [];
  return { entries: all.length, bytes: all.reduce((n, e) => n + (e.bytes || 0), 0) };
}
// Drops what expired or does not fit; returns how many entries went. Runs once per session start, after the app is up.
export async function sweepAssetCache(now = Date.now()): Promise<number> {
  const all = (await allEntries()) ?? [];
  const drop = planEviction(all.map(({ key, bytes, lastUsed, storedAt }) => ({ key, bytes, lastUsed, storedAt })), now);
  if (drop.length) await deleteKeys(drop);
  return drop.length;
}
export async function clearAssetCache(): Promise<void> {
  await tx<void>('readwrite', (s) => { s.clear(); });
  resolved.clear(); pending.clear();
}
// The cache belongs to the account that filled it: when a different account signs in on this browser, it starts empty.
export function adoptCacheOwner(userId: string) {
  const previous = readStorage(OWNER_KEY);
  if (previous && previous !== userId) void clearAssetCache();
  writeStorage(OWNER_KEY, userId);
}
let swept = false;
export function scheduleSweep() {
  if (swept) return; swept = true;
  const run = () => { sweepAssetCache().catch(() => undefined); };
  if (typeof (globalThis as any).requestIdleCallback === 'function') (globalThis as any).requestIdleCallback(run, { timeout: 15000 }); else setTimeout(run, 5000);
}

// ---- resolution: one blob: URL per asset per session ---------------------------------------------------------------
const resolved = new Map<string, string>();            // key → blob: URL, valid for the rest of the session
const pending = new Map<string, Promise<string>>();
export function peekAsset(key: string | null): string | undefined { return key ? resolved.get(key) : undefined; }
// The URL to show for `key`: from this device when it is here, else fetched from `url` (and kept). Falls back to `url`
// itself when the cache is unavailable or the fetch fails, so a missing cache never hides media.
export function resolveAsset(key: string | null, url: string): Promise<string> {
  if (!key || !url) return Promise.resolve(url);
  const hit = resolved.get(key); if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(key); if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const now = Date.now();
      const stored = await readEntry(key);
      if (stored?.blob) {
        if (now - (stored.lastUsed || 0) > TOUCH_INTERVAL_MS) void writeEntry({ ...stored, lastUsed: now });
        const u = URL.createObjectURL(stored.blob); resolved.set(key, u); return u;
      }
      const token = getToken();
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'omit' });
      if (!res.ok) return url;
      const blob = await res.blob();
      if (!blob.size) return url;
      if (blob.size <= ASSET_CACHE_MAX_ITEM_BYTES) void writeEntry({ key, blob, mime: blob.type, bytes: blob.size, lastUsed: now, storedAt: now });
      const u = URL.createObjectURL(blob); resolved.set(key, u); return u;
    } catch { return url; }
    finally { pending.delete(key); }
  })();
  pending.set(key, p);
  return p;
}
export function formatCacheSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return bytes < 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
