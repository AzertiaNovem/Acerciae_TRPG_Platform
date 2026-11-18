// Persist authorized JSON responses, never credentials or media. A snapshot from an earlier visit
// is only a conditional request candidate: its body is not used until the API confirms its hash.
import type { Snapshot } from './viewCache';

let opening: Promise<IDBDatabase | null> | undefined;
const store = 'views';
function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return opening ??= new Promise(resolve => {
    try {
      const req = indexedDB.open('acerciae-views',1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => { const db=req.result; db.onversionchange=()=>{db.close(); opening=undefined;}; resolve(db); };
      req.onblocked = req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
export const snapshots = {
  async get(key:string):Promise<Snapshot<unknown> | undefined> {
    try { const db=await database(); if (!db) return;
      return await new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    } catch { return undefined; }
  },
  async put(key:string, value?:Snapshot<unknown>) {
    try { const db=await database(); if (!db) return;
      const s=db.transaction(store,'readwrite').objectStore(store); if (value) s.put(value,key); else s.delete(key);
    } catch { /* memory caching still works */ }
  }
};
