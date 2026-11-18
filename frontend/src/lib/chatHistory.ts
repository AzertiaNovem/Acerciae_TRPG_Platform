// Text has no expiry. Keep one row per visible line; read a page, not a window-sized JSON blob.
// Segments say which intervals the server has verified. A long offline gap is never skipped
// just because there are older lines on disk. Account and access changes cannot join segments.
import type { Message } from '../types';

const DB = 'acerciae-chat', META = 'ranges', LINES = 'lines';
export interface WindowHistory {
  windowId: string; channelId: string; access: string;
  messages: Message[]; from: number; through: number; complete: boolean;
}
type Segment = Pick<WindowHistory, 'from' | 'through' | 'complete'>;
interface Meta { scope:string; windowId:string; channelId:string; access:string; ranges:Segment[] }
let scope = '', dbPromise: Promise<IDBDatabase | null> | undefined;
export function setHistoryScope(s: string) { scope = s; }
function clean({search: _s, recall_seconds_left: _r, ...m}: Message & {search?: unknown}): Message { return m; }
export function joinRanges(ranges: Segment[], next: Segment): Segment[] {
  const out: Segment[] = [];
  for (const r of [...ranges, next].sort((a,b) => a.from-b.from)) {
    const prev = out[out.length-1];
    if (prev && prev.through >= r.from) { prev.through=Math.max(prev.through,r.through); prev.complete ||= r.complete; }
    else out.push({from:r.from,through:r.through,complete:r.complete});
  }
  return out;
}
function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return dbPromise ??= new Promise(resolve => {
    try {
      const r = indexedDB.open(DB,2);
      r.onupgradeneeded = () => {
        const d=r.result, meta=d.createObjectStore(META,{keyPath:['scope','windowId']});
        meta.createIndex('channel',['scope','channelId']);
        const lines=d.createObjectStore(LINES,{keyPath:['scope','windowId','seq']});
        lines.createIndex('message',['scope','id']);
        if (!d.objectStoreNames.contains('windows')) return;
        const legacy=r.transaction!.objectStore('windows').openCursor();
        legacy.onsuccess=()=>{ const c=legacy.result; if (!c) { d.deleteObjectStore('windows'); return; }
          const {scope,windowId,channelId,access,from,through,complete,messages}=c.value;
          meta.put({scope,windowId,channelId,access,ranges:[{from,through,complete}]});
          for (const m of messages) lines.put({scope,windowId,seq:m.seq,id:m.id,m:clean(m)});
          c.continue();
        };
      };
      r.onsuccess=()=>{ const d=r.result; d.onversionchange=()=>{ d.close(); dbPromise=undefined; }; resolve(d); };
      r.onerror=()=>resolve(null); r.onblocked=()=>resolve(null);
    } catch { resolve(null); }
  });
}
const windowRows=(s:string,w:string)=>IDBKeyRange.bound([s,w,0],[s,w,Infinity]);
const done=<T,>(req:IDBRequest<T>)=>new Promise<T>((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});
export async function readHistory(w:string, before?:number, limit=80, access?:string):Promise<WindowHistory|null>{
  const s=scope, d=await db(); if (!s || s!==scope || !d) return null;
  try {
    const tx=d.transaction([META,LINES]), meta:Meta|undefined=await done(tx.objectStore(META).get([s,w]));
    if (!meta || (access!==undefined && meta.access!==access)) return null;
    const range=before===undefined ? meta.ranges[meta.ranges.length-1] ?? {from:0,through:0,complete:false} : meta.ranges.find(r=>r.from<=before && before<=r.through);
    if (!range || before!==undefined && before<=range.from && !range.complete) return null;
    const messages:Message[]=[];
    if (before!==range.from) {
      const keys=IDBKeyRange.bound([s,w,range.from],[s,w,before??range.through],false,before!==undefined);
      const cursor=tx.objectStore(LINES).openCursor(keys,'prev');
      await new Promise<void>((res,rej)=>{cursor.onerror=()=>rej(cursor.error);cursor.onsuccess=()=>{const c=cursor.result;
        if(!c)return res();messages.push(c.value.m);if(messages.length===limit)return res();c.continue();};});
    }
    messages.reverse();
    const from=messages[0]?.seq ?? range.from;
    // Pushes that arrived after the last check survive closing the tab, even if the window
    // had never been opened. They must not advance the cursor used to discover missing lines.
    if (before===undefined) {
      const tail=tx.objectStore(LINES).openCursor(IDBKeyRange.bound([s,w,range.through],[s,w,Infinity],true,false),'prev');
      const extra:Message[]=[];
      await new Promise<void>((res,rej)=>{tail.onerror=()=>rej(tail.error);tail.onsuccess=()=>{
        const c=tail.result;if(!c)return res();extra.push(c.value.m);if(extra.length>=limit)return res();c.continue();
      };});
      messages.push(...extra.reverse());
    }
    return s===scope ? {windowId:w,channelId:meta.channelId,access:meta.access,messages,from,through:range.through,complete:range.complete && from===range.from} : null;
  } catch { return null; }
}
// Save only the page that was just read. An empty verified page can still mark the beginning of history.
export async function writeHistory(h:WindowHistory, verified=true) {
  const s=scope,d=await db(); if (!s || s!==scope || !d) return;
  try {
    const tx=d.transaction([META,LINES],'readwrite'), meta=tx.objectStore(META), rows=tx.objectStore(LINES);
    const old:Meta|undefined=await done(meta.get([s,h.windowId]));
    const same=old?.channelId===h.channelId && old?.access===h.access;
    if (old && !same) rows.delete(windowRows(s,h.windowId));
    meta.put({scope:s,windowId:h.windowId,channelId:h.channelId,access:h.access,ranges:verified ? joinRanges(same ? old!.ranges : [],h) : same ? old!.ranges : []});
    for (const m of h.messages) {
      const put=()=>rows.put({scope:s,windowId:h.windowId,seq:m.seq,id:m.id,m:clean(m)});
      if (m.recalled_at || !same) put();
      else { const existing=rows.get([s,h.windowId,m.seq]); existing.onsuccess=()=>{ if (!existing.result?.m.recalled_at) put(); }; }
    }
  } catch { /* storage may be unavailable or full */ }
}
// Also replace copies in forked windows and in pages not currently loaded.
export async function recallHistory(m:Message) {
  const s=scope,d=await db(); if (!s || s!==scope || !d) return;
  const c=d.transaction(LINES,'readwrite').objectStore(LINES).index('message').openCursor([s,m.id]);
  c.onsuccess=()=>{const row=c.result;if(row){row.update({...row.value,m:clean(m)});row.continue();}};
}
export async function dropHistory(match:{windowId?:string;channelId?:string}) {
  const s=scope,d=await db(); if (!s || !d) return;
  const tx=d.transaction([META,LINES],'readwrite'), meta=tx.objectStore(META),rows=tx.objectStore(LINES);
  const drop=(w:string)=>{meta.delete([s,w]);rows.delete(windowRows(s,w));};
  if(match.windowId) drop(match.windowId);
  else if(match.channelId){const cur=meta.index('channel').openCursor([s,match.channelId]);cur.onsuccess=()=>{const c=cur.result;if(c){drop(c.value.windowId);c.continue();}};}
}
