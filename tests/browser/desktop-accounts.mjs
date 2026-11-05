// Exercise the desktop UI with an isolated keychain bridge and local HTTP fixtures.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const engine = process.argv[2] ?? 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({channel: process.env.CHROME_CHANNEL});
try {
 const ctx = await browser.newContext(); const secrets = new Map(); const revoked = [];
 // Simulate the desktop bridge and two consenting test sessions in a fresh browser profile.
 await ctx.exposeBinding('accountBridge',(_, command,args) => {
   if(command==='secret_get') return secrets.get(args.name) ?? null;
   if(command==='secret_set') secrets.set(args.name,args.value);
   if(command==='secret_delete') secrets.delete(args.name);
   return null;
 });
 await ctx.addInitScript(() => { window.__TAURI_INTERNALS__={invoke:window.accountBridge,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}}; });
 const user = id => ({id,username:id,display_name:id.toUpperCase(),ui_language:'en',ui_theme:id==='alice'?'glass':'classic',avatar_version:0});
 const domain = 'https://accounts.test';
 await ctx.route(domain+'/**', async route=>{
   const req=route.request(), path=new URL(req.url()).pathname, cred=req.headers().authorization?.replace('Bearer ','');
   let body=[],status=200;
   if(path==='/api/auth/login'){const {username}=req.postDataJSON();body={user:user(username),token:'fixture-'+username};}
   else if(path==='/api/auth/me') { assert.ok(cred && !revoked.includes(cred)); body=user(cred.replace('fixture-','')); }
   else if(path==='/api/auth/file-token') body={token:'fixture-file',expires_at:Math.floor(Date.now()/1000)+3600};
   else if(path==='/api/auth/logout') {revoked.push(cred);body={};}
   else if(path==='/api/servers') body=[{id:'s',name:'Shared table',my_role:'member'}];
   else if(path==='/api/servers/s/channels') body=['north','south'].map(id=>({id,name:id+' table',my_role:'player'}));
   else if(/^\/api\/channels\/(north|south)$/.test(path)) body={id:path.split('/').pop(),name:'Table',my_role:'player'};
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await ctx.routeWebSocket(/accounts\.test/,()=>{});
 const page=await ctx.newPage(); page.setDefaultTimeout(30000);
 await page.goto(site);
 const signIn=async name=>{ await page.getByPlaceholder('https://trpg.missazertia.com').fill(domain); await page.getByPlaceholder('username',{exact:true}).fill(name);await page.getByPlaceholder('password',{exact:true}).fill('fixture-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByText('@'+name,{exact:true}).waitFor(); };
 const menu=()=>page.getByRole('button',{name:'Switch account',exact:true}).click();
 const theme = value => page.waitForFunction(t=>document.documentElement.dataset.theme===t,value);
 const channel = name => page.locator('.channel-sidebar .item.active').filter({hasText:name+' table'}).waitFor();
 await signIn('alice'); await theme('glass'); await page.getByText('south table',{exact:true}).click(); await channel('south'); await menu(); await page.getByRole('button',{name:'Add account'}).click();
 await signIn('bob'); await theme('classic'); await channel('north'); await menu(); await page.getByRole('button',{name:/ALICE · @alice/}).click();
 await page.getByText('@alice',{exact:true}).waitFor(); assert.deepEqual(revoked,[]); await theme('glass'); await channel('south');
 await page.reload();await page.getByText('@alice',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await page.getByRole('button',{name:/BOB · @bob/}).click();
 await page.getByText('@bob',{exact:true}).waitFor();assert.deepEqual(revoked,['fixture-alice']); await theme('classic'); await channel('north');
 assert.equal([...secrets.keys()].filter(x=>x.startsWith('account.')).length,1);
 console.log(engine + ': adding, switching, theme and channel restoration, restart and independent logout passed');
} finally { await browser.close(); }
