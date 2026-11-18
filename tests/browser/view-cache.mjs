// Run against the Vite dev server for the browser storage migration and a real authenticated API.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { Api } from '../../gm-agent/src/api.mjs';
const engine=process.argv[2]??'chromium', site=process.env.WEB_BASE??'http://127.0.0.1:5173';
if (!['localhost','127.0.0.1'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const gm=new Api(site),other=new Api(site), tag=crypto.randomUUID().slice(0,8);
await gm.register('view'+tag,'password','Reader'); await other.register('other'+tag,'password','Another reader');
const server=await gm.createServer('View cache'), ch=await gm.createChannel(server.id,{name:'Quiet table'});
const c=await gm.createCharacter(ch.id,{kind:'pc',name:'Ada',bio:'Blue harbour'});
const path='/api/channels/'+ch.id+'/characters/'+c.id+'/space';
const conditional=(token,tag)=>fetch(site+path+'?view_cache=1',{headers:{Authorization:'Bearer '+token,...(tag && {'If-None-Match':tag})}});
const res=await conditional(gm.token); assert.equal(res.status,200); const etag=res.headers.get('etag');assert.ok(etag);
assert.equal((await conditional(gm.token,etag)).status,304); assert.equal((await conditional(other.token,etag)).status,403);
const browser=await (engine==='webkit'?webkit:chromium).launch(engine==='webkit'?{}:{channel:process.env.CHROME_CHANNEL || 'chrome'});
try {
  const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(token=>localStorage.setItem('acerciae.token',token),gm.token);
  // Start with the previous released IndexedDB schema and a genuine kept window.
  await page.goto(site+'/api/health');
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open('acerciae-chat',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('windows',{keyPath:'key'}).put({key:'legacy|w',scope:'legacy',windowId:'w',channelId:'fixture',access:'gm',from:1,through:1,complete:true,messages:[{id:'old',seq:1,content:'before upgrade'}]});
    r.onsuccess=()=>{r.result.close();resolve();};r.onerror=()=>reject(r.error);
  }));
  const warm=page.waitForResponse(r=>new URL(r.url()).pathname===path && r.status()===200);
  await page.goto(site); await (await warm).finished();
  await page.evaluate(path=>{
    const fetch=window.fetch.bind(window), barrier=new Promise(resolve=>window.releaseView=resolve);
    window.fetch=async(...args)=>{
      if(new URL(args[0],location.href).pathname!==path) return fetch(...args);
      window.validationTag=args[1].headers['If-None-Match']; await barrier;
      const response=await fetch(...args);window.validationStatus=response.status;return response;
    };
  },path);
  await page.locator('.item.character').filter({hasText:'Ada'}).click();
  await page.locator('.character-space input:visible').first().waitFor();
  await page.waitForFunction(()=>!!window.validationTag); assert.equal(await page.evaluate(()=>window.validationTag),etag);
  await page.evaluate(()=>window.releaseView()); await page.waitForFunction(()=>!!window.validationStatus);
  assert.equal(await page.evaluate(()=>window.validationStatus),304);
  // A changed visible representation gets a different tag and body, not a 304.
  await gm.updateChannel(ch.id,{era:'After the flood'});
  const changed=await conditional(gm.token,etag);
  assert.equal(changed.status,200);assert.notEqual(changed.headers.get('ETag'),etag);assert.equal((await changed.json()).era,'After the flood');
  // Returning to chat with a long history already in RAM only mounts its latest page.
  await page.evaluate(async()=>{
    const {useChat,accessKey}=await import('/src/store/chat.ts'),{useNav}=await import('/src/store/nav.ts');
    const nav=useNav.getState(),w=nav.windowId, rows=Array.from({length:400},(_,i)=>({id:'row-'+i,channel_id:nav.channelId,chat_window_id:w,seq:i+1,kind:'ooc',visibility:'window',author_name:'Fixture',author_role:'player',content:'History row '+i,created_at:'2026-11-01T00:00:00Z'}));
    useChat.setState(s=>({byWindow:{...s.byWindow,[w]:rows},spans:{...s.spans,[w]:{channelId:nav.channelId,access:accessKey(nav.channel),from:1,through:400,complete:true,checkedAt:Date.now()}}}));
    nav.showChat();
  });
  await page.locator('#msg-row-399').waitFor();assert.equal(await page.locator('.message-list .message').count(),80);
  await page.locator('.message-list').evaluate(el=>{el.scrollTop=0;});
  await page.locator('#msg-row-240').waitFor();assert.equal(await page.locator('.message-list .message').count(),160);
  // Real IndexedDB: >1500 lines, multiple windows, paging, separate accounts, offline reload and durable tombstones.
  // Use the same origin and disk, with no app bootstrap resetting the fixture's account mid-read.
  await page.route('**/history-fixture', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>History fixture</title>'}));
  await page.goto(site+'/history-fixture');
  const storeTest=await page.evaluate(async()=>{
    const h=await import('/src/lib/chatHistory.ts');
    h.setHistoryScope('legacy');
    if ((await h.readHistory('w'))?.messages[0]?.content !== 'before upgrade') throw Error('lost legacy history');
    h.setHistoryScope('fixture-A');
    const save=async(w,n)=>h.writeHistory({windowId:w,channelId:'fixture',access:'gm',from:1,through:n,complete:true,
      messages:Array.from({length:n},(_,i)=>({id:w+(i+1),seq:i+1,content:'line '+(i+1)}))});
    await save('w',1700);
    for(let i=0;i<155;i++) await save('w'+i,1);
    const last=await h.readHistory('w'); const prev=await h.readHistory('w',last.from,80,'gm');
    await h.recallHistory({id:'w1',seq:1,content:'',recalled_at:'today'});
    return [last.messages.length,last.through,prev.messages.at(-1).seq];
  });
  assert.deepEqual(storeTest,[80,1700,1620]); await page.reload();
  await page.evaluate(async()=>{window.historyFixture=await import('/src/lib/chatHistory.ts');});
  await page.context().setOffline(true);
  const history=await page.evaluate(async()=>{
    const h=window.historyFixture;h.setHistoryScope('fixture-B');const other=await h.readHistory('w');
    h.setHistoryScope('fixture-A');const head=await h.readHistory('w',3,80,'gm');const isolated=await h.readHistory('w',3,80,'player');
    return [other,head.messages.map(m=>m.content),head.complete,isolated];
  });
  assert.deepEqual(history,[null,['','line 2'],true,null]);assert.deepEqual(errors,[]);
  console.log(engine+': warm character visible before validation; conditional access, durable paged history and account isolation passed');
}finally{await browser.close();}
