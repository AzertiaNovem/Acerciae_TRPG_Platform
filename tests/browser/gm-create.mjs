// Real host, schema and creation API, with an in-memory platform and fake workers; no live accounts or AI calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium, webkit } from 'playwright';
import { loadHost } from '../../gm-agent/src/host-config.mjs';
import { HostManager } from '../../gm-agent/src/host-manager.mjs';
import { startWeb } from '../../gm-agent/src/host-web.mjs';
import YAML from '../../gm-agent/node_modules/yaml/dist/index.js';

const engine = process.argv[2] ?? 'chromium', dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-create-ui-')));
const token = 'fixture-create-access-token-long-enough';
const rows = [
  { id: 'public', name: '公开频道 <img>', knowledge_mode: 'public' },
  { id: 'saved', name: '已有日常世界', knowledge_mode: 'isolated' },
  { id: 'module', name: '仍绑定模组', knowledge_mode: 'isolated', module_id: 'module-1' },
  { id: 'playing', name: '已结束共创', knowledge_mode: 'isolated' },
  { id: 'forging', name: '正在共创', knowledge_mode: 'isolated' },
].map(c => ({ server_id: 'server', rule_system: 'coc7e', my_role: 'gm', ...c }));
const created = [], servers = [{ id: 'server', name: '周末故事' }];
const users = ['alice', 'amy'].map(username => ({ id: crypto.randomUUID(), username, display_name: username })), roster = new Set(), invitations = [];
const [aliceId, amyId] = users.map(p => p.id);
let rejectAmy = true;
const platform = { user: { id: 'gm' }, searchUsers: async q => users.filter(p => p.username.includes(q)), channelMembers: async () => [...roster].map(id => ({ id, role: 'player' })),
  invitePlayer: async (_, id) => { invitations.push(id); if (id === amyId && rejectAmy) throw Error('invite denied'); roster.add(id); },
  servers: async () => servers, channels: async () => rows, channel: async id => rows.find(c => c.id === id),
  createServer: async name => { const s = { id: 'new-server', name }; servers.push(s); return s; },
  createChannel: async (server, body) => { const c = { id: `created-${created.length + 1}`, server_id: server, my_role: 'gm', ...body }; rows.push(c); created.push(c); return c; },
  updateChannel: async (id, body) => Object.assign(rows.find(c => c.id === id), body), createInvite: async () => ({ code: 'TEST-INVITE' }) };
class FakeWorker extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; queueMicrotask(() => this.emit('message', 'ready')); }
  postMessage(msg) { if (msg === 'stop') queueMicrotask(() => this.emit('exit', 0)); else if (msg.type === 'status') queueMicrotask(() => this.emit('message', { type: 'status', id: msg.id, snapshot: { at: new Date().toISOString(), channel: { name: 'Fixture', rule: 'coc7e' } } })); }
  terminate() { this.emit('exit', 1); }
}
let manager, web, browser;
try {
  fs.mkdirSync(path.join(dir, '.state'));
  for (const id of ['saved', 'module', 'playing', 'forging']) fs.writeFileSync(path.join(dir, `.state/${id}.json`), JSON.stringify({ channelId: id, improv: { on: true, world: 'PRIVATE-WORLD-NOT-FOR-LISTING', secrets: 'PRIVATE-SECRET-NOT-FOR-LISTING' }, casual: { on: true }, ...(id === 'playing' || id === 'forging' ? { forge: { phase: id === 'playing' ? 'playing' : 'review' } } : {}) }));
  fs.writeFileSync(path.join(dir, 'host.yml'), JSON.stringify({ account: { username: 'fixture', password: 'private-password' }, llm: { provider: 'mock' }, webui: { enabled: true, token, port: 0 }, channels: [] }));
  const host = loadHost(path.join(dir, 'host.yml'));
  manager = new HostManager(host, { makeWorker: cfg => new FakeWorker(cfg) });
  manager.signIn = async () => ({ cfg: { username: 'fixture' }, api: platform });
  const listing = JSON.stringify(await manager.platform());
  assert.ok(!listing.includes('PRIVATE-')); assert.ok(!listing.includes('private-password'));
  web = await startWeb(manager, host.web); const base = `http://127.0.0.1:${web.address().port}`;
  browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'webkit' ? {} : { channel: process.env.CHROME_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [], bodies = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/channels') bodies.push(r.postDataJSON()); });
  await page.goto(base); await page.locator('#token').fill(token); await page.locator('#login button').click(); await page.locator('#session').waitFor();
  const next = () => page.locator('#create-next').click();
  const step = async n => { await page.locator(`#create-steps button:nth-child(${n})`).click(); };
  const open = async () => { await page.locator('#new-task').click(); await page.waitForFunction(() => !document.querySelector('#create-next').disabled); };
  await open();
  assert.equal(await page.locator('[data-create-step="1"]').isVisible(), false);
  await next(); assert.match(await page.locator('#create-status').innerText(), /请选择/);
  await page.getByLabel('在平台上新建频道', { exact: true }).check();
  await next(); assert.match(await page.locator('#create-status').innerText(), /频道名称/);
  await page.locator('#c-name').fill('港口故事'); await page.locator('#c-server').selectOption('server'); await page.locator('#c-rule').selectOption('dnd2024');
  await next(); await next(); assert.match(await page.locator('#create-status').innerText(), /选择故事模式/);
  await page.locator('#c-story-improv').check();
  assert.equal(await page.locator('#c-world-forge').isChecked(), true);
  await page.locator('#c-modes-casual').selectOption('true');
  await page.screenshot({ path: `/tmp/gm-create-modes-${engine}.png`, fullPage: true });
  await next();
  await page.locator('#c-table-level').fill('5'); await page.locator('#c-timelines-scene_forks').selectOption('true');
  await page.locator('#c-planner-enabled').selectOption('false'); assert.equal(await page.locator('#c-planner-final_review').count(), 0);
  await page.locator('#c-illustrations-enabled').selectOption('false'); assert.equal(await page.locator('#c-illustrations-allow_cloud').count(), 0);
  await page.locator('#c-context-daily_token_budget').fill('20000');
  // Moving between modes keeps drafts, but removes hidden branches from the resulting configuration.
  await step(2); await page.locator('#c-story-module').check(); await next();
  assert.equal(await page.locator('#c-table-level').inputValue(), '5');
  await step(1); await page.locator('#c-rule').selectOption('coc7e'); await next();
  await page.locator('#c-story-improv').check(); await page.locator('#c-world-file').check();
  await next(); assert.match(await page.locator('#create-status').innerText(), /世界设定文件/);
  await page.locator('#c-modes-world_file').fill('/srv/world.md'); await page.locator('#c-modes-secrets_file').fill('/srv/secrets.md');
  await page.locator('#c-world-forge').check(); await next();
  assert.equal(await page.locator('#c-table-level').count(), 0);
  assert.equal(await page.locator('#c-context-daily_token_budget').inputValue(), '20000');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/gm-create-features-mobile-${engine}.png`, fullPage: true });
  await next(); await page.locator('#c-player-query').fill('a'); await page.locator('#c-player-search').click();
  for (const p of users) await page.getByRole('button', { name: `选择 @${p.username}`, exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '已选 @alice' }).isDisabled(), true);
  await next(); await page.getByText('invite denied', { exact: true }).waitFor();
  assert.equal(manager.host.channels.length, 0); assert.deepEqual([...roster], [aliceId]);
  rejectAmy = false; await next(); await page.locator('#c-review').waitFor(); assert.deepEqual(invitations, [aliceId, amyId, amyId]);
  assert.match(await page.locator('#c-review').innerText(), /先共创开局/); assert.match(await page.locator('#c-review').innerText(), /@alice、@amy/);
  roster.delete(amyId); await page.locator('#create-submit').click(); await page.getByText(/创建失败：有受邀玩家/).waitFor();
  assert.equal(manager.host.channels.length, 0); await page.locator('#create-back').click(); await next(); await page.locator('#c-review').waitFor();
  await page.locator('#c-prepare').uncheck(); await page.locator('#create-submit').click();
  assert.match(await page.locator('#create-status').innerText(), /启动时准备频道/); assert.equal(created.length, 1); assert.equal(manager.host.channels.length, 0);
  await page.locator('#c-prepare').check();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `/tmp/gm-create-review-${engine}.png`, fullPage: true });
  await page.route(base + '/api/channels', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"fixture failure"}' }) : route.continue());
  await page.locator('#create-submit').click(); await page.getByText('创建失败：fixture failure', { exact: true }).waitFor();
  assert.equal(await page.locator('#create-submit').isEnabled(), true);
  await page.unroute(base + '/api/channels');
  await page.locator('#create-submit').evaluate(el => { el.click(); el.click(); });
  await page.locator('#create-result').waitFor();
  assert.equal(created.length, 1); assert.equal(created[0].knowledge_mode, 'isolated');
  const submitted = bodies.at(-1).settings;
  assert.equal(submitted['forge.enabled'], true); assert.equal(submitted['context.daily_token_budget'], '20000');
  assert.ok(!Object.keys(submitted).some(k => k.startsWith('daily.')));
  for (const key of ['table.level', 'modes.world_file', 'modes.secrets_file', 'illustrations.allow_cloud', 'planner.final_review']) assert.equal(key in submitted, false, key);
  const persisted = YAML.parse(fs.readFileSync(manager.entry('created-1').config, 'utf8'));
  assert.equal(persisted.context.daily_token_budget, 20000); assert.equal(persisted.planner.enabled, false);
  assert.equal(await page.locator('#create-flow').isVisible(), false);
  // Existing public channels explain the restrictions; saved modes and pending Forge are discovered without exposing prose.
  await open(); await page.locator('#c-channel').selectOption('public'); await next(); await page.locator('#c-story-inherit').check();
  await page.locator('#c-modes-casual').selectOption('true'); assert.match(await page.locator('#c-casual').innerText(), /私密手机不能启用/); await next();
  assert.equal(await page.locator('#c-timelines-scene_forks').count(), 0);
  await step(1); await page.locator('#c-channel').selectOption('module'); await next(); await page.locator('#c-story-inherit').check(); await next();
  await step(1); await page.locator('#c-channel').selectOption('forging'); await next(); assert.equal(await page.locator('#c-story-module').isDisabled(), true);
  await step(1); await page.locator('#c-channel').selectOption('playing'); await next(); await page.locator('#c-story-improv').check();
  assert.equal(await page.locator('#c-world-forge').isDisabled(), true); assert.equal(await page.locator('#c-world-saved').isChecked(), true);
  await page.locator('#create-cancel').click();
  await open(); await page.locator('#c-channel').selectOption('saved'); await next(); await page.locator('#c-story-inherit').check(); await next();
  assert.equal(await page.locator('[data-feature^="daily."]').count(), 0, 'no daily-life switch');
  await next();
  await page.locator('#c-prepare').uncheck(); await page.locator('#c-start').uncheck(); await page.locator('#create-submit').click(); await page.locator('#create-result').waitFor();
  assert.equal(manager.entry('saved').prepareOnStart, false);
  assert.equal('modes.improv' in bodies.at(-1).settings, false); assert.equal('modes.casual' in bodies.at(-1).settings, false);
  // New scene forks alone must actually create private windows' prerequisite, without enabling casual mode.
  await open(); await page.getByLabel('在平台上新建频道', { exact: true }).check(); await page.locator('#c-server').selectOption('server'); await page.locator('#c-name').fill('分头调查'); await page.locator('#c-rule').selectOption('pbta');
  await next(); await page.locator('#c-story-module').check(); await next(); await page.locator('#c-timelines-scene_forks').selectOption('true'); await next(); await next();
  assert.match(await page.locator('#c-review').innerText(), /审核规则草案/);
  await page.locator('#c-start').uncheck(); await page.locator('#create-submit').click(); await page.locator('#create-result').waitFor();
  assert.equal(created[1].knowledge_mode, 'isolated'); assert.equal(bodies.at(-1).settings['modes.casual'], false);
  assert.deepEqual(errors, []);
  console.log(`${engine}: creation wizard branches, prerequisites, retained drafts, safe requests, private channel creation, failed-submit retry and mobile layout passed`);
} finally { await browser?.close(); await manager?.close(); if (web) { web.closeAllConnections(); await new Promise(r => web.close(r)); } fs.rmSync(dir, { recursive: true, force: true }); }
