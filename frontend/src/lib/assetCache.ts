// A local cache of the platform's images and audio (web and desktop), so an avatar, a portrait, a backdrop or a voice
// line is downloaded once, not on every page load.
//
// Media URLs carry a short-lived file token that changes on every sign-in and renewal, which defeats the browser's
// own cache; here an entry is keyed by the URL without its token, scoped to the signed-in account and server. Only
// responses the server marks `immutable` are kept: a named version of something a player may see. A stored object
// never changes, and GM-private material is never marked, so it is never written here. Assets in the public bucket
// (a redirect) are left to the browser, which already keeps them for good. At most CAP bytes are kept; the least
// recently used go first. Signing out clears it.
const DB = 'acerciae-assets';
const STORE = 'assets';
const CAP = 300 * 1024 * 1024;
const MEMORY_KEPT = 400;

interface Entry { key: string; blob: Blob; size: number; used: number }

let scope = '';
const memory = new Map<string, string>();            // key → object URL, for this page
const inflight = new Map<string, Promise<string>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

// The signed-in account (and server): entries never cross accounts.
export function setAssetScope(s: string) { scope = s; }

export function assetKey(url: string | null | undefined): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return '';
  try {
    const u = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    u.searchParams.delete('token');
    u.searchParams.sort();
    return `${scope}|${u.origin}${u.pathname}?${u.searchParams.toString()}`;
  } catch { return ''; }
}

function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'key' }); s.createIndex('used', 'used'); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

const done = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function read(key: string): Promise<Blob | null> {
  const d = await db(); if (!d) return null;
  try {
    const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
    const e = await done(store.get(key) as IDBRequest<Entry | undefined>);
    if (!e) return null;
    store.put({ ...e, used: Date.now() });
    return e.blob;
  } catch { return null; }
}

async function write(key: string, blob: Blob) {
  const d = await db(); if (!d) return;
  try {
    await done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, blob, size: blob.size, used: Date.now() } as Entry));
    await trim(d);
  } catch { /* a full or unavailable store just means no caching */ }
}

// Drops the least recently used entries beyond CAP.
async function trim(d: IDBDatabase) {
  const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
  const all = await done(store.index('used').getAll() as IDBRequest<Entry[]>);
  let total = all.reduce((n, e) => n + e.size, 0);
  for (const e of all) { if (total <= CAP) break; store.delete(e.key); total -= e.size; }
}

function remember(key: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  memory.set(key, url);
  if (memory.size > MEMORY_KEPT) { const [oldest, old] = memory.entries().next().value as [string, string]; memory.delete(oldest); URL.revokeObjectURL(old); }
  return url;
}

// What is already at hand for this page, without waiting.
export function peekSrc(url: string | null | undefined): string | undefined {
  const key = assetKey(url);
  return key ? memory.get(key) : undefined;
}

// A source for `url` that comes from the local cache when it can: an object URL of the kept bytes, or `url` itself
// when the asset is not to be kept (or anything fails: the page then loads it as before).
export function cachedSrc(url: string | null | undefined): Promise<string> {
  const key = assetKey(url);
  if (!url || !key) return Promise.resolve(url ?? '');
  const hit = memory.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const kept = await read(key);
      if (kept) return remember(key, kept);
      // A redirect goes to the public bucket: the browser keeps that object itself.
      const res = await fetch(url, { redirect: 'manual', credentials: 'omit' });
      if (res.type === 'opaqueredirect' || !res.ok) return url;
      // Not marked for keeping (the current version of something, GM-private material): the page loads the URL
      // itself, and the browser revalidates it by its ETag.
      if (!/\bimmutable\b/.test(res.headers.get('Cache-Control') ?? '')) return url;
      const blob = await res.blob();
      void write(key, blob);
      return remember(key, blob);
    })().catch(() => url).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// Signing out: nothing of this account stays on the device.
export async function clearAssetCache() {
  for (const u of memory.values()) URL.revokeObjectURL(u);
  memory.clear();
  const d = await db(); if (!d) return;
  try { await done(d.transaction(STORE, 'readwrite').objectStore(STORE).clear()); } catch { /* nothing to clear */ }
}
