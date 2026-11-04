import { readStorage, writeStorage } from './storage';

// A local cache of the platform's images and audio (web and desktop), so an avatar, a portrait, a backdrop or a voice
// line is downloaded once and then kept on the device for weeks.
//
// Keys. The server names the SHA-256 of every picture it stores (`content_hash` on media rows, `avatar_hash` on users,
// `hash` / `*_hash` wherever a picture is referenced): when a reference carries one, the entry is keyed by it, so the
// same bytes are one entry however many assets, versions or users show them, and a changed hash is a new entry. An
// object stored before hashes existed is hashed by the server the first time it is served; until then the entry is
// keyed by the URL without its file token (the token changes on every sign-in and renewal, which would defeat any
// cache). Keys are scoped to the signed-in account and server, so entries never cross accounts.
//
// What is kept. Only responses the server marks `immutable`: a named version of something a player may see. A stored
// object never changes and GM-private material is never marked, so it is never written here. For media in the public
// bucket the API answers with the object's URL and its own keep decision (`?direct=1`, see directUrl); the object is
// then fetched straight from the bucket, whose CORS policy must allow the app's origin (a bucket that refuses it just
// leaves the picture to the browser, as before).
//
// How long. Each time an entry is shown its lifespan starts over: it is dropped only when it has not been shown for
// ASSET_CACHE_MAX_AGE_MS, or when the cache passes ASSET_CACHE_MAX_BYTES (least recently used first). Without
// IndexedDB (private windows, blocked storage) or on any error the direct URL is used as before.
export const ASSET_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // not shown for 30 days → gone
export const ASSET_CACHE_MAX_BYTES = 768 * 1024 * 1024;          // the whole cache
export const ASSET_CACHE_MAX_ITEM_BYTES = 64 * 1024 * 1024;      // bigger files stream from the server every time
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;                        // a hit refreshes lastUsed, at most this often
const DB = 'acerciae-assets', STORE = 'assets', DB_VERSION = 2;  // v2: entries carry lastUsed/storedAt and hash keys
const MEMORY_KEPT = 400;
const OWNER_KEY = 'acerciae.media-cache-owner';

export type CacheEntry = { key: string; bytes: number; lastUsed: number; storedAt: number };
interface Entry extends CacheEntry { blob: Blob; mime: string }

let scope = '';
const memory = new Map<string, string>();            // key → object URL, for this page
const inflight = new Map<string, Promise<string>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

// The signed-in account (and server): entries never cross accounts. A different account than the one that filled the
// cache on this browser empties it first.
export function setAssetScope(s: string) {
  scope = s;
  const previous = readStorage(OWNER_KEY);
  if (previous && previous !== s) void clearAssetCache();
  writeStorage(OWNER_KEY, s);
}

// The content hash's key, or null without one.
export const contentKey = (hash?: string | null) => (hash ? `${scope}|sha:${hash}` : null);
// The entry's key: the content hash when known, else the URL without its file token (a renewed token is the same
// asset); '' for data: and blob: URLs, which are never cached.
export function assetKey(url: string | null | undefined, hash?: string | null): string {
  const byContent = contentKey(hash);
  if (byContent) return byContent;
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return '';
  try {
    const u = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    u.searchParams.delete('token');
    u.searchParams.sort();
    return `${scope}|${u.origin}${u.pathname}?${u.searchParams.toString()}`;
  } catch { return ''; }
}

// ---- the public bucket ------------------------------------------------------------------------------------------------
// The routes that may hand an object over to the public bucket (an avatar, a media asset, a voice clip) answer
// `?direct=1` with {url, keep} instead of a redirect. Fetching that URL from the page is one cross-origin hop, so the
// browser sends the page's own origin; following the API's redirect would be a second hop from another origin, sent
// as `Origin: null`, which no CORS policy naming the site accepts.
export const DIRECT_TYPE = 'application/vnd.acerciae.direct+json';
const DIRECT_PATH = /\/api\/(users\/[^/]+\/avatar|channels\/[^/]+\/(media\/[^/]+|studio\/tts\/audio\/[^/]+))$/;
export function directUrl(url: string): string {
  try {
    const u = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    if (!DIRECT_PATH.test(u.pathname)) return url;
    u.searchParams.set('direct', '1');
    return u.toString();
  } catch { return url; }
}

// ---- eviction: expired entries, then the least recently used until the rest fits the budget -------------------------
export function planEviction(entries: CacheEntry[], now: number, limits = { maxAgeMs: ASSET_CACHE_MAX_AGE_MS, maxBytes: ASSET_CACHE_MAX_BYTES }): string[] {
  const dropped = new Set<string>();
  const kept: CacheEntry[] = [];
  for (const e of entries) { if (now - e.lastUsed > limits.maxAgeMs) dropped.add(e.key); else kept.push(e); }
  let total = kept.reduce((n, e) => n + e.bytes, 0);
  for (const e of [...kept].sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= limits.maxBytes) break;
    dropped.add(e.key); total -= e.bytes;
  }
  return [...dropped];
}

// ---- IndexedDB --------------------------------------------------------------------------------------------------------
function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const r = indexedDB.open(DB, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (d.objectStoreNames.contains(STORE)) d.deleteObjectStore(STORE);   // v1 entries had no lifespan: start over
          d.createObjectStore(STORE, { keyPath: 'key' }).createIndex('lastUsed', 'lastUsed');
        };
        r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbPromise = null; }; resolve(d); };
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}
const done = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function read(key: string, now: number): Promise<Blob | null> {
  const d = await db(); if (!d) return null;
  try {
    const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
    const e = await done(store.get(key) as IDBRequest<Entry | undefined>);
    if (!e) return null;
    if (now - e.lastUsed > ASSET_CACHE_MAX_AGE_MS) { store.delete(key); return null; }   // expired: downloaded again
    if (now - e.lastUsed > TOUCH_INTERVAL_MS) store.put({ ...e, lastUsed: now });         // shown: the lifespan starts over
    return e.blob;
  } catch { return null; }
}
async function write(key: string, blob: Blob, now: number) {
  if (blob.size > ASSET_CACHE_MAX_ITEM_BYTES) return;
  const d = await db(); if (!d) return;
  try {
    await done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, blob, mime: blob.type, bytes: blob.size, lastUsed: now, storedAt: now } as Entry));
    await trim(d, now);
  } catch { /* a full or unavailable store just means no caching */ }
}
// Drops what expired and the least recently used entries beyond the budget.
async function trim(d: IDBDatabase, now: number) {
  const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
  const all = await done(store.getAll() as IDBRequest<Entry[]>);
  for (const key of planEviction(all.map(({ key, bytes, lastUsed, storedAt }) => ({ key, bytes, lastUsed, storedAt })), now)) store.delete(key);
}
export async function cacheStats(): Promise<{ entries: number; bytes: number }> {
  const d = await db(); if (!d) return { entries: 0, bytes: 0 };
  try { const all = await done(d.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<Entry[]>); return { entries: all.length, bytes: all.reduce((n, e) => n + (e.bytes || 0), 0) }; }
  catch { return { entries: 0, bytes: 0 }; }
}
// Runs once per session start, after the app is up.
export async function sweepAssetCache(now = Date.now()): Promise<void> { const d = await db(); if (d) { try { await trim(d, now); } catch { /* nothing to sweep */ } } }
let swept = false;
export function scheduleSweep() {
  if (swept) return; swept = true;
  const run = () => { sweepAssetCache().catch(() => undefined); };
  if (typeof (globalThis as any).requestIdleCallback === 'function') (globalThis as any).requestIdleCallback(run, { timeout: 15000 }); else setTimeout(run, 5000);
}

function remember(key: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  memory.set(key, url);
  if (memory.size > MEMORY_KEPT) { const [oldest, old] = memory.entries().next().value as [string, string]; memory.delete(oldest); URL.revokeObjectURL(old); }
  return url;
}

// What is already at hand for this page, without waiting.
export function peekSrc(url: string | null | undefined, hash?: string | null): string | undefined {
  const key = assetKey(url, hash);
  return key ? memory.get(key) : undefined;
}

// A source for `url` that comes from the local cache when it can: an object URL of the kept bytes, or `url` itself
// when the asset is not to be kept (or anything fails: the page then loads it as before). With `hash` the entry is
// the content itself: a picture whose hash did not change is never downloaded again while its entry lives.
export function cachedSrc(url: string | null | undefined, hash?: string | null): Promise<string> {
  const key = assetKey(url, hash);
  if (!url || !key) return Promise.resolve(url ?? '');
  const hit = memory.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const now = Date.now();
      const kept = await read(key, now);
      if (kept) return remember(key, kept);
      // Whatever cannot be read here (a bucket whose CORS policy refuses the page, an older server's redirect, an
      // error) is left to the browser, which loads the URL as before.
      const res = await fetch(directUrl(url), { redirect: 'manual', credentials: 'omit' });
      if (res.type === 'opaqueredirect' || !res.ok) return url;
      if ((res.headers.get('Content-Type') ?? '').startsWith(DIRECT_TYPE)) {
        // In the public bucket: fetched from there directly. `no-store` skips any copy an <img> left in the browser's
        // HTTP cache without CORS headers (the bucket only adds them to requests that carry an Origin).
        const d = (await res.json()) as { url?: unknown; keep?: unknown };
        if (typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url)) return url;
        const obj = await fetch(d.url, { credentials: 'omit', cache: 'no-store' });
        if (!obj.ok) return url;
        const bytes = await obj.blob();
        // The bucket marks every object immutable; whether this one may be kept is the API's call.
        if (d.keep !== true) return URL.createObjectURL(bytes);
        void write(key, bytes, now);
        return remember(key, bytes);
      }
      const blob = await res.blob();
      // Not marked for keeping (the current version of something, GM-private material): these bytes serve this one
      // view and are neither stored nor remembered, so the next view asks again (and the browser revalidates by ETag).
      if (!/\bimmutable\b/.test(res.headers.get('Cache-Control') ?? '')) return URL.createObjectURL(blob);
      void write(key, blob, now);
      return remember(key, blob);
    })().catch(() => url).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// Empties the device: the user's own choice (personal settings), or another account signing in on this browser.
export async function clearAssetCache() {
  for (const u of memory.values()) URL.revokeObjectURL(u);
  memory.clear();
  const d = await db(); if (!d) return;
  try { await done(d.transaction(STORE, 'readwrite').objectStore(STORE).clear()); } catch { /* nothing to clear */ }
}
export function formatCacheSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return bytes < 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
