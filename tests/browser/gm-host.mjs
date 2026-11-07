// Run with Playwright available (or PLAYWRIGHT_MODULE pointing to its index.mjs).
// Uses the real host/API/UI with isolated YAML and fake workers; never contacts a platform or AI service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadHost } from '../../gm-agent/src/host-config.mjs';
import { HostManager } from '../../gm-agent/src/host-manager.mjs';
import { startWeb } from '../../gm-agent/src/host-web.mjs';
import { Store } from '../../gm-agent/src/store.mjs';
import { usageSnapshot } from '../../gm-agent/src/host-status.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-host-ui-')));
const token = 'fixture-access-token-longer-than-24';
const stores = new Map();
const plan = { version: 7, updatedAt: new Date().toISOString(), trigger: 'interval', mode: 'full', throughline: '找到失踪的地图', played: '调查员到达港口',
  beat: { title: '港口的密信', purpose: '建立与船长的关系', exit: '船长提供线索', closed: false }, verdict: { moveOn: true, why: '调查员已找到突破口' },
  threads: [{ id: 'P1', title: '旧日航线', status: 'live', stakes: '失去船员的信任', hooks: ['一张潮湿的地图'], twist: '船长其实是竞争者', ripeWhen: '玩家提出航线问题', weaveWith: null }],
  next: [{ what: '一封信抵达港口', when: '黎明之后' }], review: { critique: '应复用现存 NPC', changed: '让船长承担新线索' }, calendar: { advice: '保持清晨', upcoming: [] } };
function usage(id) {
  if (!stores.has(id)) {
    const store = new Store(), now = Date.now(); stores.set(id, store);
    if (id === 'a') {
      store.recordUsage({ at: now, purpose: 'director', phase: 'human', model: 'fixture-gm', input: 1000, cacheRead: 800, cacheWrite: 100, output: 100 });
      store.recordUsage({ at: now, purpose: 'planner', phase: 'draft', model: 'fixture-draft', input: 2000, cacheRead: 1000, output: 500 });
      store.recordUsage({ at: now, purpose: 'planner', phase: 'revise', model: 'fixture-revise', input: 3000, output: 700, estimated: true });
      store.recordUsage({ at: now, purpose: 'coplayer_turn', usageKnown: false, status: 'failed' });
      store.recordUsage({ at: now - 86400000, purpose: 'coplayer_phone', input: 600, output: 100 });
    } else store.recordUsage({ at: now, purpose: 'director', input: 1500, output: 500 });
  }
  return { ...usageSnapshot(stores.get(id)), budget: 20000 };
}
class FakeWorker extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; queueMicrotask(() => this.emit('message', 'ready')); }
  postMessage(msg) {
    if (msg === 'stop') return setTimeout(() => this.emit('exit', 0), 150);
    if (msg?.type === 'status') queueMicrotask(() => this.emit('message', { type: 'status', id: msg.id,
      snapshot: { at: new Date().toISOString(), channel: { name: `主持 ${this.cfg.channelId.toUpperCase()}`, rule: 'coc7e', gm: true, knowledge: 'public', language: 'zh' },
        usage: usage(this.cfg.channelId), planner: { on: true, plan, version: 7, pendingVersion: 8, mode: 'full', updatedAt: plan.updatedAt, moveOn: true } } }));
  }
  terminate() { this.emit('exit', 1); }
}
let manager, web, context;
const start = async (port = 0) => {
  const host = loadHost(path.join(dir, 'host.yml'));
  manager = new HostManager(host, { makeWorker: cfg => new FakeWorker(cfg) });
  await manager.startAll(); web = await startWeb(manager, { ...host.web, port });
};
const stop = async () => { await manager?.close(); if (web) await new Promise(resolve => web.close(resolve)); web = null; };
const open = () => chromium.launchPersistentContext(path.join(dir, 'browser'), { channel: process.env.CHROME_CHANNEL || 'chrome', viewport: { width: 1280, height: 900 } });
try {
  fs.writeFileSync(path.join(dir, 'a.yml'), 'table:\n  coplayers: 0\n');
  fs.writeFileSync(path.join(dir, 'b.yml'), 'table:\n  coplayers: 0\n');
  fs.writeFileSync(path.join(dir, 'host.yml'), JSON.stringify({ llm: { provider: 'mock' }, webui: { enabled: true, token, port: 0 }, channels: ['a', 'b'].map(id => ({ id, config: id + '.yml' })) }));
  fs.mkdirSync(path.join(dir, '.state')); fs.writeFileSync(path.join(dir, '.state/a.json'), '{"retained":true}');
  await start(); const port = web.address().port, base = `http://127.0.0.1:${port}`;
  context = await open(); let page = context.pages()[0]; const errors = [], auth = [];
  const watch = p => { p.on('pageerror', e => errors.push(e.message)); p.on('request', r => { if (r.headers().authorization) auth.push(new URL(r.url()).pathname); }); };
  watch(page); await page.goto(base);
  await page.locator('#login button').waitFor({ state: 'visible' });
  await page.getByLabel('访问令牌').fill(token); await page.locator('#login button').click();
  await page.locator('#session').waitFor({ state: 'visible' });
  assert.ok(!(await page.locator('#summary').innerText()).includes('null'));
  assert.equal(await page.getByLabel('访问令牌').inputValue(), '');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(token));
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('acerciae_gm_session'));
  const cookie = (await context.cookies()).find(c => c.name === 'acerciae_gm_session');
  assert.ok(cookie.httpOnly && cookie.expires > Date.now() / 1000 + 89 * 86400);
  await page.reload(); await page.locator('#session').waitFor({ state: 'visible' });
  // Actually close the persistent browser profile and restart the host on the same address.
  await context.close(); context = null; await stop(); await start(port);
  context = await open(); page = context.pages()[0]; watch(page); await page.goto(base);
  await page.locator('#session').waitFor({ state: 'visible' });
  assert.deepEqual(auth, ['/api/session'], 'restoration and ordinary API calls never resend the administrative token');
  // A transient restore failure keeps the existing login for the next visit.
  await page.route(base + '/api/session', route => route.abort());
  await page.reload(); await page.getByText(/无法恢复连接/).waitFor();
  assert.ok((await context.cookies()).some(c => c.name === cookie.name));
  await page.unroute(base + '/api/session'); await page.reload(); await page.locator('#session').waitFor({ state: 'visible' });
  await page.locator('#host-usage').getByRole('button', { name: '主持 A', exact: true }).click();
  const usageCard = page.locator('#usage-card'); await usageCard.waitFor();
  assert.ok((await usageCard.locator('[data-usage-id=planner]').innerText()).includes('6,200'));
  assert.equal(await usageCard.locator('[data-usage-id=planner] svg rect.usage-fill').count(), 3);
  assert.ok((await usageCard.innerText()).includes('1 次未上报完整用量'));
  assert.ok(!(await usageCard.locator('[data-usage-id=coplayer_turn]').innerText()).includes('输入 0'));
  assert.ok((await page.locator('.channel-item').filter({ hasText: '主持 A' }).innerText()).includes('7,300 token'));
  await usageCard.getByRole('button', { name: '近 7 天', exact: true }).click();
  await page.locator('#usage-card [data-usage-id=coplayer_phone]').waitFor();
  assert.ok((await usageCard.innerText()).includes('8,000 token'));
  await usageCard.getByRole('button', { name: '今日', exact: true }).click();
  assert.equal(await usageCard.locator('[data-usage-id=coplayer_phone]').count(), 0);
  await usageCard.getByText('按阶段和模型查看明细', { exact: true }).click();
  assert.equal(await usageCard.getByRole('cell', { name: /fixture-draft/ }).count(), 1);
  await page.screenshot({ path: '/tmp/gm-host-token-charts.png', fullPage: true });
  await page.getByRole('tab', { name: '计划', exact: true }).click();
  await page.getByText('船长其实是竞争者', { exact: true }).waitFor();
  assert.equal(await page.getByText('船长提供线索', { exact: true }).count(), 1);
  await page.getByText('完整 plan JSON', { exact: true }).click();
  await page.waitForTimeout(4200);
  assert.equal(await page.locator('#plan-view details').getAttribute('open'), '', 'plan polling preserves the expanded raw view');
  assert.ok((await page.locator('#plan-view pre').innerText()).includes('找到失踪的地图'));
  await page.screenshot({ path: '/tmp/gm-host-plan.png', fullPage: true });
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  assert.equal(await usageCard.locator('details').getAttribute('open'), '', 'chart detail remains expanded across polls');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/gm-host-token-charts-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '删除主持任务', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/gm-host-webui-desktop.png', fullPage: true });
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.locator('#f-table-coplayers').fill('1');
  assert.equal(await page.locator('#savebar').isVisible(), true);
  page.once('dialog', d => d.dismiss()); await page.getByRole('button', { name: '删除主持任务', exact: true }).click();
  assert.ok(manager.entry('a')); assert.equal(manager.status()[0].status, 'running');
  assert.equal(await page.locator('#f-table-coplayers').inputValue(), '1', 'cancelling preserves the draft');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '删除主持任务', exact: true }).click();
  await page.getByText(/主持任务已删除。平台频道/).waitFor();
  assert.equal(await page.getByRole('button', { name: /主持 A/ }).count(), 0);
  assert.equal(await page.locator('#savebar').isVisible(), false, 'deletion discards the removed task’s unsaved form');
  assert.deepEqual(manager.status().map(c => [c.id, c.status]), [['b', 'running']]);
  assert.deepEqual(loadHost(path.join(dir, 'host.yml')).channels.map(c => c.id), ['b']);
  assert.ok(fs.existsSync(path.join(dir, 'a.yml'))); assert.equal(fs.readFileSync(path.join(dir, '.state/a.json'), 'utf8'), '{"retained":true}');
  await page.locator('.channel-item').filter({ hasText: '主持 B' }).click();
  // Failed deletion keeps both the selected task and its controls available for a retry.
  await page.route(base + '/api/channels/b/remove', route => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"fixture: shared file cannot be written"}' }));
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '删除主持任务', exact: true }).click();
  await page.getByText('fixture: shared file cannot be written', { exact: true }).waitFor();
  assert.ok(manager.entry('b')); assert.equal(await page.locator('#channel').isVisible(), true);
  await page.unroute(base + '/api/channels/b/remove');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/gm-host-webui-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.locator('#login').waitFor({ state: 'visible' }); await page.reload();
  await page.waitForFunction(() => !document.querySelector('#login button').disabled);
  assert.equal(await page.locator('#session').isVisible(), false);
  assert.ok(!(await context.cookies()).some(c => c.name === cookie.name));
  assert.deepEqual(errors, []);
  console.log('GM WebUI: token charts, date ranges, stage/model details, full plan, persistent login and hosting task controls passed');
} finally { await context?.close(); await stop(); for (const s of stores.values()) s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
