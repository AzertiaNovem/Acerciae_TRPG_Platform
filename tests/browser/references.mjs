// The real chat view, isolated from the production service and real credentials.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const site = process.env.WEB_BASE || 'http://127.0.0.1:5196';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(site).hostname)) throw Error('Use a local test server.');
const engine = process.argv[2] ?? 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({channel: process.env.CHROME_CHANNEL});
try {
  for (const theme of ['classic', 'glass']) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('acerciae.token', 'fixture-reference-token'));
    await ctx.routeWebSocket(/.*/, () => {});
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { requested = resolve; });
    const requests = [];
    const message = (id, content, extra = {}) => ({id, content, author_id:'keeper', author_name:'GM', author_role:'gm', channel_id:'north', chat_window_id:'north-table', kind:'narration', visibility:'window', seq:1, created_at:'2026-11-05T12:00:00Z', ...extra});
    const original = message('original', 'First line of the original.\nSecond line stays visible.');
    const dice = message('dice', '.r 1d20', {dice:{text:'1d20 = 17'}});
    const cached = message('cached', 'Already loaded original.');
    await ctx.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      let body = [], status = 200;
      if (path === '/api/auth/me') body = {id:'keeper', username:'fixture', display_name:'GM', ui_language:'en', ui_theme:theme};
      else if (path === '/api/auth/file-token') body = {token:'fixture-file', expires_at:Math.floor(Date.now()/1000)+3600};
      else if (path === '/api/servers') body = [{id:'s', name:'Reference table', my_role:'owner'}];
      else if (path === '/api/servers/s/settings') body = {features:{dice:true,atmosphere:false}};
      else if (path === '/api/servers/s/channels') body = ['north','south'].map(id => ({id,name:id+' channel',my_role:'gm'}));
      else if (/^\/api\/channels\/(north|south)$/.test(path)) body = {id:path.split('/').pop(),name:'Table',my_role:'gm'};
      else if (path.endsWith('/windows')) body = [{id:path.split('/')[3]+'-table',name:'Main Chat',kind:'main',members:[]}];
      else if (path === '/api/channels/north/windows/north-table/messages') body = url.searchParams.has('before_seq') ? [] : [cached, message('reply','My reply.',{seq:2,reference_ids:['original','dice','cached','denied','late']})];
      else if (path === '/api/channels/south/windows/south-table/messages') body = [message('new','Different channel.',{channel_id:'south',chat_window_id:'south-table'})];
      else if (path.includes('/messages/')) {
        const id = path.split('/').pop(); requests.push(id);
        if (id === 'late' || id === 'cached') {
          if (id === 'late') requested();
          await gate;
        }
        if (id === 'denied') { status = 403; body = {error:'forbidden'}; }
        else body = id === 'original' ? original : id === 'dice' ? dice : id === 'cached' ? cached : message('late','Old channel response.');
      }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    });
    const page = await ctx.newPage(); page.setDefaultTimeout(15000);
    try {
    await page.goto(site);
    const quotes = page.locator('.chat-reference');
    await quotes.filter({hasText:original.content}).waitFor();
    await quotes.filter({hasText:dice.dice.text}).waitFor();
    await quotes.filter({hasText:cached.content}).waitFor();
    await quotes.filter({hasText:'Reference unavailable for your current view.'}).waitFor();
    await pending;
    assert.equal(await page.getByRole('button',{name:'View chat reference',exact:true}).count(),0);
    assert.deepEqual([...new Set(requests)].sort(), ['cached','denied','dice','late','original']);
    // A slow reference must not disable the composer or overwrite a newly selected channel.
    await page.locator('.composer textarea').fill('Typing while the original loads');
    await quotes.filter({hasText:original.content}).getByRole('button',{name:'Go to original message'}).click();
    await page.locator('#msg-original').waitFor();
    assert.ok(requests.filter(id => id === 'original').length >= 2, 'Jump revalidates access');
    await page.getByText('south channel',{exact:true}).click();
    await page.getByText('Different channel.',{exact:true}).waitFor();
    const late = page.waitForResponse(r => r.url().endsWith('/messages/late'));
    release(); await late;
    assert.equal(await quotes.count(),0);
    assert.equal(await page.getByText('Old channel response.',{exact:true}).count(),0);
    console.log(`${engine}/${theme}: automatic originals, cache-first display, dice, access denial, responsive composer and channel isolation passed`);
    } catch (error) {
      console.error(await page.locator('body').innerText());
      throw error;
    } finally { release(); await ctx.close(); }
  }
} finally { await browser.close(); }
