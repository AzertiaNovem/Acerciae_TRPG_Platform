// Real REST + WebSocket round trip on an isolated local backend, in the UI shared by web and desktop.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
if (!['127.0.0.1','localhost'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const engine = process.argv[2] || 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({channel:process.env.CHROME_CHANNEL});
try {
  const ctx = await browser.newContext({baseURL:site});
  async function api(method,path,body,token) {
    const res = await ctx.request.fetch('/api'+path,{method,data:body,headers:token?{Authorization:'Bearer '+token}:{}});
    assert.ok(res.ok(),`${path}: ${res.status()} ${await res.text()}`); return res.json();
  }
  const {token} = await api('POST','/auth/register',{username:'browser_recall_'+Date.now(),display_name:'Recall Tester',password:'password'});
  await api('PUT','/auth/me',{ui_language:'en'},token);
  const server = await api('POST','/servers',{name:'Recall browser verification'},token);
  const channel = await api('POST',`/servers/${server.id}/channels`,{name:'WebSocket and recall'},token);
  const [win] = await api('GET',`/channels/${channel.id}/windows`,undefined,token);
  const root = `/channels/${channel.id}/windows/${win.id}/messages`;
  const original = await api('POST',root,{content:'Original text to take back.',kind:'ooc'},token);
  await api('POST',root,{content:'A reply quoting the original.',kind:'ooc',reference_ids:[original.id]},token);
  await ctx.addInitScript(token=>{
    localStorage.setItem('acerciae.token',token);
    const Original = window.WebSocket; window.testSockets = [];
    window.WebSocket = class extends Original { constructor(...args) { super(...args); window.testSockets.push(this); } };
  },token);
  const author=await ctx.newPage(), other=await ctx.newPage();
  author.setDefaultTimeout(15000); other.setDefaultTimeout(15000);
  await Promise.all([author.goto(site),other.goto(site)]);
  await other.locator('.chat-reference').filter({hasText:'Original text to take back.'}).waitFor();
  // Miss a line during a dropped connection; reconnect must retrieve it without a manual refresh.
  await other.evaluate(()=>window.testSockets.filter(ws=>ws.url.includes('/ws/chat')).forEach(ws=>ws.close()));
  await api('POST',root,{content:'Sent during reconnect.',kind:'ooc'},token);
  await other.getByText('Sent during reconnect.',{exact:true}).waitFor();
  await other.locator('#msg-'+original.id).getByRole('button',{name:'Quote as reference',exact:true}).click();
  await author.locator('#msg-'+original.id).getByRole('button',{name:'Recall',exact:true}).click();
  await other.locator('#msg-'+original.id+'.recalled').waitFor();
  await other.locator('.chat-reference').filter({hasText:'This message was recalled.'}).waitFor();
  assert.equal(await other.locator('.chat-reference-drafts').count(),0);
  assert.equal(await other.getByText('Original text to take back.',{exact:true}).count(),0);
  await author.getByRole('button',{name:'Re-edit',exact:true}).click();
  // Re-edit reaches the controlled textarea through a React effect. Wait for that user-visible state.
  await author.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'Original text to take back.');
  assert.equal(await author.locator('.composer textarea').inputValue(),'Original text to take back.');
  await other.reload();
  await other.locator('#msg-'+original.id+'.recalled').waitFor();
  assert.equal(await other.getByText('Original text to take back.',{exact:true}).count(),0);
  console.log(engine+': live recall on a second client, quoted originals, pending references, re-edit, reload and reconnect catch-up passed');
  await ctx.close();
} finally { await browser.close(); }
