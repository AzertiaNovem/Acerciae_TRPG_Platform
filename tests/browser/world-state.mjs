import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWeb } from '../../gm-agent/src/host-web.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'world-ui-')),token='world-browser-fixture-access-token';
const at=Date.now(),definitions={},values=[];
for(let i=0;i<42;i++) {
  definitions['trust'+i]={id:'trust'+i,label:'信任 '+i,type:'number',scope:'relation',initial:0,min:0,max:10,description:'私有态度',changeRule:'遵守承诺 +1',thresholds:[]};
  values.push({metric:'trust'+i,subject:'npc',target:i===0?'bob':'alice',value:i===0?2:6,reason:i===1?'<img src=x onerror=alert(1)>':'守约',at});
}
const data={on:true,at,revision:1,characters:[{id:'npc',name:'Maren'},{id:'alice',name:'Alice'},{id:'bob',name:'Co-player'}],definitions,values,events:[{status:'pending',subject:'npc',target:'alice',text:'开放日记'}],audit:[],inventory:[{id:'alice',name:'Alice',items:[{name:'钥匙',qty:1,note:'黄铜'}]}],inventoryAvailable:true};
let reads=0;
const manager={host:{stateDir:dir},warm(){},entry(){},status:()=>[{id:'a',name:'Fixture',status:'running',enabled:true}],hostInfo:()=>({}),config:()=>({yaml:'{}',values:{}}),detail:async()=>({id:'a',status:'running',runtime:{},live:{worldState:{revision:1}}}),snapshot:async(id,section)=>{assert.equal(section,'world');reads++;return data;}};
const server=await startWeb(manager,{host:'127.0.0.1',port:0,token}),base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true});
try {
  assert.equal((await fetch(base+'/api/channels/a/world')).status,401);
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  await page.locator('#token').fill(token);await page.locator('#login button').click();
  await page.locator('.channel-item').click();await page.locator('[data-tab=world]').click();
  await page.getByRole('heading',{name:'Maren → Co-player',exact:true}).waitFor();
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  assert.equal(await page.getByRole('heading',{name:'Maren → Co-player',exact:true}).count(),0);
  await page.getByLabel('全部对象').selectOption('bob');
  assert.match(await page.locator('#world-view').innerText(),/信任 0 · 2/);
  assert.doesNotMatch(await page.locator('#world-view').innerText(),/开放日记/);
  await page.getByLabel('全部对象').selectOption('alice');
  await page.locator('#world-view summary').first().click();
  assert.equal(await page.locator('#world-view img').count(),0);
  assert.match(await page.locator('#world-view').innerText(),/<img src=x onerror=alert\(1\)>/);
  assert.match(await page.locator('#world-view').innerText(),/开放日记/);
  await page.screenshot({path:'/tmp/gm-world-state-ui.png'});
  await page.locator('[data-tab=overview]').click();await page.locator('[data-tab=world]').click();assert.equal(reads,1);
  const cookie=(await context.cookies()).map(c=>`${c.name}=${c.value}`).join('; ');
  assert.equal((await fetch(base+'/api/channels/a/world',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,405);
  await page.locator('#logout').click();await page.locator('#login').waitFor();
  assert.equal(await page.locator('#world-view').innerText(),'');
  assert.equal((await fetch(base+'/api/channels/a/world',{headers:{cookie}})).status,401);
  assert.deepEqual(errors,[]);
  console.log('World state UI: private, read-only, per-target filters, pagination, safe text, cached reads and logout verified.');
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
