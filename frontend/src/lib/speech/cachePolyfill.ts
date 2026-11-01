// Kokoro's model and voice files (90–330 MB) are kept with the Cache API by the libraries themselves. Some desktop
// webviews have no Cache API (an insecure or custom-scheme origin): the English package then refuses to load at all,
// and the Chinese one downloads everything again on every start. Where it is missing, this installs a small stand-in
// backed by IndexedDB, with the two calls the libraries use (match and put), so the files are downloaded once there
// too.
const DB = 'acerciae-model-cache';
const STORE = 'files';

interface Row { key: string; body: ArrayBuffer; status: number; headers: [string, string][] }

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
const done = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const urlOf = (req: RequestInfo | URL) => (typeof req === 'string' ? req : req instanceof URL ? req.href : req.url);

class IdbCache {
  constructor(private name: string) {}
  private key(req: RequestInfo | URL) { return `${this.name}|${urlOf(req)}`; }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const row = await done((await db()).transaction(STORE).objectStore(STORE).get(this.key(req)) as IDBRequest<Row | undefined>);
    return row ? new Response(row.body, { status: row.status, headers: row.headers }) : undefined;
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const body = await res.arrayBuffer();
    const row: Row = { key: this.key(req), body, status: res.status, headers: [...res.headers.entries()] };
    await done((await db()).transaction(STORE, 'readwrite').objectStore(STORE).put(row));
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    await done((await db()).transaction(STORE, 'readwrite').objectStore(STORE).delete(this.key(req)));
    return true;
  }
  async keys(): Promise<Request[]> { return []; }
}

export function installCachePolyfill(scope: any = globalThis) {
  if (typeof scope.caches !== 'undefined' || typeof indexedDB === 'undefined') return false;
  scope.caches = {
    open: async (name: string) => new IdbCache(name),
    has: async () => true,
    delete: async () => false,
    keys: async () => [],
    match: async () => undefined,
  };
  return true;
}
