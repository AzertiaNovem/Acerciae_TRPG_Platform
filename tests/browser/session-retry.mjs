import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const site=process.env.WEB_BASE || 'http://127.0.0.1:18442';
if(!['localhost','127.0.0.1'].includes(new URL(site).hostname))throw Error('Use a local fixture');
const engine=process.argv[2]==='webkit'?webkit:chromium;
for (const failure of ['unavailable','offline','gateway-auth']) {
 const browser=await engine.launch(engine===chromium?{channel:process.env.CHROME_CHANNEL}:{});
 try {
  const ctx=await browser.newContext();let outage=true;
  await ctx.addInitScript(()=>{localStorage.setItem('acerciae.token','session-fixture');localStorage.setItem('acerciae.ui-language','en');});
  await ctx.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(!path.startsWith('/api/'))return route.continue();
   if(path==='/api/auth/me'&&outage&&failure==='offline')return route.abort('failed');
   if(path==='/api/auth/me'&&outage&&failure==='gateway-auth')return route.fulfill({status:401,contentType:'text/html',body:'Gateway login required'});
   const status=path==='/api/auth/me'&&outage?503:200;
   const body=path==='/api/auth/me'?(outage?{error:'busy',message:'Temporary outage'}:{id:'u',username:'fixture',display_name:'Fixture',ui_language:'en',ui_theme:'classic'}):path==='/api/auth/file-token'?{token:'file-fixture',expires_at:Math.floor(Date.now()/1000)+3600}:[];
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await ctx.routeWebSocket(/\/ws\//,()=>{});
  const page=await ctx.newPage();await page.goto(site);
  const retry=page.getByRole('button',{name:'Retry',exact:true});await retry.waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('acerciae.token')),'session-fixture');
  outage=false;await retry.click();await retry.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'User settings',exact:true}).waitFor();
  console.log(engine.name()+': '+failure+' retained session; retry restored account');
 }finally{await browser.close();}
}
