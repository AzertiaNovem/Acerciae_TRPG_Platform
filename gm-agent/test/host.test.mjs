import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { loadHost, channelConfig } from '../src/host-config.mjs';
import { HostManager } from '../src/host-manager.mjs';
import { startWeb } from '../src/host-web.mjs';
import { acquireLock, lockPath } from '../src/state.mjs';
import { HostManager as _M, redact, secretsOf } from '../src/host-manager.mjs';
import { FIELDS, applyChanges, formValues, schema } from '../src/host-schema.mjs';
import { buildConfig } from '../src/config.mjs';
import { parseChannel } from '../src/host-config.mjs';
import { PassThrough } from 'node:stream';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.yml'), 'table:\n  coplayers: 0\ncalendar:\n  max_days: 1\n');
  fs.writeFileSync(path.join(dir, 'b.yml'), 'table:\n  level: 4\nautonomy:\n  enabled: false\n');
  fs.writeFileSync(path.join(dir, 'host.yml'), JSON.stringify({ account: { username: 'fixture', password: 'password-secret' }, llm: { provider: 'mock', api_base: 'http://endpoint', api_key: 'shared-secret' }, webui: { enabled: true, token: 'test-token-longer-than-24-characters', port: 0 }, channels: [{ id: 'a', config: 'a.yml' }, { id: 'b', config: 'b.yml' }] }));
  return loadHost(path.join(dir, 'host.yml'));
}
class FakeWorker extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; this.stops = 0; queueMicrotask(() => this.emit('message', 'ready')); }
  postMessage(msg) { if (msg !== 'stop') return; this.stops++; queueMicrotask(() => this.emit('exit', 0)); }
  terminate() { this.emit('exit', 1); }
}
test('shared credentials, independent policies, relative paths and invalid override rejection', t => {
  const host = fixture(t), a = channelConfig(host, host.channels[0]), b = channelConfig(host, host.channels[1]);
  assert.equal(a.llm.apiKey, 'shared-secret'); assert.equal(b.llm.apiKey, a.llm.apiKey);
  assert.equal(a.password, 'password-secret'); assert.equal(a.calendarMaxDays, 1);
  assert.equal(b.level, 4); assert.equal(b.autonomy, false); assert.notEqual(a.channelId, b.channelId);
  assert.equal(a.stateDir, path.join(host.root, '.state'));
  assert.equal(channelConfig(host, { ...host.channels[0], prepareOnStart: false }).prepareOnStart, false);
  assert.throws(() => channelConfig(host, host.channels[0], 'llm:\n  api_key: override'), /shared configuration/);
  assert.throws(() => channelConfig(host, host.channels[0], 'llm:\n  api_base: http:\/\/other'), /shared configuration/);
  assert.throws(() => channelConfig(host, host.channels[0], 'mystery: true'), /unknown section/);
  const data = host.data; data.channels[1].id = 'a'; fs.writeFileSync(host.file, JSON.stringify(data));
  assert.throws(() => loadHost(host.file), /duplicate/);
});
test('saving one active channel restarts only it; failures do not stop peers; same-PID locks remain exclusive', async t => {
  const host = fixture(t), made = [];
  const manager = new HostManager(host, { makeWorker: cfg => { const w = new FakeWorker(cfg); made.push(w); return w; } });
  t.after(() => manager.close()); await manager.startAll();
  await manager.save('a', 'calendar:\n  max_days: 5\n');
  assert.equal(made.length, 3); assert.equal(made[0].stops, 1); assert.equal(made[1].stops, 0);
  assert.equal(made[2].cfg.calendarMaxDays, 5);
  made[2].emit('exit', 1); assert.equal(manager.status()[0].status, 'failed');
  assert.equal(manager.status()[1].status, 'running');
  await manager.save('a', 'table:\n  coplayers: 1\n'); assert.equal(made.length, 3);
  const release = acquireLock(host.stateDir, 'test'); assert.ok(release);
  assert.equal(acquireLock(host.stateDir, 'test'), null); release();
});
test('Web UI authenticates, blocks cross-origin writes, redacts shared secrets and rejects stale edits', async t => {
  const host = fixture(t), manager = new HostManager(host, { makeWorker: cfg => new FakeWorker(cfg) });
  const web = await startWeb(manager, host.web);
  t.after(async () => { await manager.close(); await new Promise(resolve => web.close(resolve)); });
  const base = `http://127.0.0.1:${web.address().port}`;
  const headers = { Authorization: `Bearer ${host.web.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/channels')).status, 401);
  const listing = await (await fetch(base + '/api/channels', { headers })).text();
  assert.ok(!listing.includes('shared-secret') && !listing.includes('password-secret'));
  const config = await (await fetch(base + '/api/channels/a/config', { headers })).json();
  const write = extra => fetch(base + '/api/channels/a/config', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ yaml: 'table:\n  coplayers: 3\n', revision: config.revision }) });
  assert.equal((await write({ Origin: 'http://foreign.example' })).status, 403);
  assert.equal((await write({})).status, 200); assert.equal((await write({})).status, 409);
  fs.writeFileSync(host.channels[0].config, 'llm:\n  api_key: private-value\n');
  const rejected = await fetch(base + '/api/channels/a/config', { headers });
  assert.equal(rejected.status, 400); assert.ok(!(await rejected.text()).includes('private-value'));
  assert.match(await (await fetch(base)).text(), /GM 控制台/);
});
test('forced worker stop waits for exit and releases only locks acquired by that worker', async t => {
  const host = fixture(t);
  const manager = new HostManager(host, { stopTimeout: 10, makeWorker: cfg => {
    const worker = new FakeWorker(cfg); worker.postMessage = () => {};
    fs.mkdirSync(cfg.stateDir, { recursive: true }); fs.writeFileSync(lockPath(cfg.stateDir, cfg.channelId), String(process.pid));
    queueMicrotask(() => worker.emit('message', 'locked')); return worker;
  }});
  await manager.start(host.channels[0]); await manager.stop('a');
  assert.equal(fs.existsSync(lockPath(host.stateDir, 'a')), false);
});
test('a real worker can import the single-channel runtime without executing the CLI', async () => {
  const worker = new Worker(new URL('../src/host-worker.mjs', import.meta.url), { workerData: { username: '', password: '' }, stdout: true, stderr: true });
  const messages = []; worker.on('message', m => messages.push(m));
  const [code] = await once(worker, 'exit');
  assert.equal(code, 1); assert.deepEqual(messages, [{ type: 'failed', error: 'set GM_USERNAME and GM_PASSWORD (or --username / --password)' }], 'the failure says why');
});

test('two real workers host CoC and D&D concurrently and restart independently', async t => {
  const { createServer } = await import('node:http');
  const { DND_RULES } = await import('./fixtures/dndRules.mjs');
  const host = fixture(t), seen = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume fixture login */ }
    const pathname = new URL(req.url, 'http://localhost').pathname; seen.push(pathname);
    let value = [];
    if (pathname === '/api/auth/login') value = { token: 'fixture', user: { id: 'gm' } };
    else if (/^\/api\/channels\/[ab]$/.test(pathname)) value = { id: pathname.at(-1), server_id: 's', my_role: 'gm', name: pathname.at(-1), rule_system: pathname.endsWith('a') ? 'coc7e' : 'dnd2024', knowledge_mode: 'public' };
    else if (pathname.endsWith('/settings')) value = { language: 'en' };
    else if (pathname.endsWith('/windows')) value = [{ id: 'main', kind: 'main', name: 'Main Chat', members: [] }];
    else if (pathname === '/api/coc7/rules') value = { skills: [], families: [] };
    else if (pathname === '/api/dnd/rules') value = DND_RULES;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  host.data.api_base = `http://127.0.0.1:${server.address().port}`;
  for (const entry of host.channels) entry.prepareOnStart = false;
  for (const entry of host.channels) fs.writeFileSync(entry.config, 'table:\n  coplayers: 0\nautonomy:\n  enabled: false\nplanner:\n  enabled: false\n');
  const manager = new HostManager(host, { stopTimeout: 1000 });
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await manager.startAll();
  const waitReady = async () => {
    const deadline = Date.now() + 8000;
    while (!manager.status().every(e => e.status === 'running')) {
      assert.ok(Date.now() < deadline, JSON.stringify(manager.status()));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitReady();
  assert.ok(seen.includes('/api/coc7/rules') && seen.includes('/api/dnd/rules'));
  const live = await manager.detail('b');
  assert.equal(live.status, 'running'); assert.equal(live.live.channel.rule, 'dnd2024'); assert.equal(live.live.channel.name, 'b');
  assert.equal(live.live.channel.gm, true); assert.equal(typeof live.live.usage.today.billable, 'number'); assert.deepEqual(live.live.cast.coplayers, []);
  assert.equal(live.live.timelines[0].handle, 'T0'); assert.equal(live.live.settings.sceneForks, false); assert.ok(!live.live.errors, JSON.stringify(live.live.errors));
  assert.ok(manager.logs('a').lines.some(l => /keeping "a"/.test(l.text)), 'the worker log reaches the UI');
  assert.equal(manager.status().find(c => c.id === 'b').name, 'b', 'the list shows the channel name once a snapshot was taken');
  for (const id of ['a', 'b']) assert.ok(fs.existsSync(path.join(host.stateDir, `${id}.db`)));
  const peer = manager.running.get('b').worker;
  const priorExit = manager.running.get('a').exited;
  await manager.action('a', 'restart'); await waitReady();
  assert.equal(await priorExit, 0, 'restart drains the real worker without forced termination');
  assert.equal(manager.running.get('b').worker, peer);
  await manager.action('a', 'stop');
  assert.equal(manager.status()[1].status, 'running');
  assert.equal(fs.existsSync(lockPath(host.stateDir, 'a')), false);
});

test('redaction masks known secrets and anything shaped like a credential', () => {
  const secrets = secretsOf({ data: { account: { password: 'hunter2-pass' }, llm: { api_key: 'sk-ant-api03-abcdefghijklmnop' } }, web: { token: 'web-token-123456789012345678' } }, {});
  const text = redact('login hunter2-pass; key sk-ant-api03-abcdefghijklmnop; Authorization: Bearer abc.def-ghijklmn; ws://x/ws/chat?token=eyJhbGciOi.eyJzdWIiOiJ4.c2lnbmF0dXJl&x=1; {"api_key":"zzzzzzzz"}; web-token-123456789012345678; sk-proj-0123456789abcdefXYZ', secrets);
  for (const leak of ['hunter2-pass', 'sk-ant-api03', 'abc.def-ghijklmn', 'eyJhbGciOi', 'zzzzzzzz', 'web-token-1234', 'sk-proj-0123']) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`);
  assert.match(text, /^login ••••; key ••••; Authorization: Bearer ••••; ws:\/\/x\/ws\/chat\?token=••••&x=1; \{"api_key":"••••"\}/, text);
  assert.equal(redact('password: hunter3 and api_key=abcd1234', []), 'password: •••• and api_key=••••');
});

test('the settings form edits YAML in place, keeps comments, and knows every key it offers', () => {
  for (const x of FIELDS) {
    const [section, key] = x.key.split('.');
    const sample = { bool: true, tri: false, int: x.min ?? 1, enum: x.options?.find(Boolean), list: ['Main Chat'], string: 'value' }[x.type];
    const data = { [section]: { [key]: sample } };
    assert.deepEqual(buildConfig({}, {}, { data }).warnings, [], x.key);
    assert.doesNotThrow(() => parseChannel(applyChanges('', { [x.key]: sample })), x.key);
  }
  const text = '# night table\npacing:\n  debounce_ms: 4000 # wait for slow typists\n  post_delay_ms: 1200\ncalendar:\n  max_days: 2\n';
  const out = applyChanges(text, { 'pacing.debounce_ms': 2500, 'calendar.max_days': null, 'timelines.scene_forks': 'true', 'llm.effort': 'high', 'table.coplayer_windows': 'Main Chat, Docks' });
  assert.match(out, /^# night table\npacing:\n  debounce_ms: 2500 # wait for slow typists\n  post_delay_ms: 1200\n/);
  assert.ok(!out.includes('calendar'), 'an emptied section is removed');
  assert.deepEqual(parseChannel(out).table.coplayer_windows, ['Main Chat', 'Docks']); assert.equal(parseChannel(out).timelines.scene_forks, true);
  assert.equal(applyChanges(text, { 'pacing.debounce_ms': null, 'pacing.post_delay_ms': '', 'calendar.max_days': undefined }), '{}\n', 'every key removed: an empty mapping, still a valid channel file');
  assert.throws(() => applyChanges(text, { 'pacing.debounce_ms': -5 }), /不能小于 0/);
  assert.throws(() => applyChanges(text, { 'table.coplayers': 9 }), /不能大于 8/);
  assert.throws(() => applyChanges(text, { 'llm.effort': 'extreme' }), /必须是/);
  assert.throws(() => applyChanges(text, { 'llm.api_key': 'x' }), /Unknown setting/);
  assert.throws(() => applyChanges(text, { 'channel.era': 'a\nb' }), /一行/);
  const values = formValues({ pacing: { debounce_ms: 2500 } }, buildConfig({}, {}, { data: { pacing: { debounce_ms: 2500 } } }));
  assert.deepEqual(values['pacing.debounce_ms'], { set: 2500, effective: 2500, default: 2500 }, 'no rebuild given: the default is not known apart');
  assert.deepEqual(values['planner.interval_minutes'], { set: undefined, effective: 30, default: 30 });
  const rebuilt = formValues({ pacing: { debounce_ms: 2500 } }, buildConfig({}, {}, { data: { pacing: { debounce_ms: 2500 } } }), data => buildConfig({}, {}, { data }));
  assert.deepEqual(rebuilt['pacing.debounce_ms'], { set: 2500, effective: 2500, default: 4000 });
  assert.equal(values['modes.casual'].effective, null, 'casual left to the state file');
  assert.ok(!JSON.stringify(schema()).includes('effective'), 'the browser gets labels, not functions');
});

class TalkingWorker extends EventEmitter {
  constructor(cfg, { fail = null } = {}) {
    super(); this.cfg = cfg; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.asked = 0;
    queueMicrotask(() => {
      this.stdout.write('12:00:00 keeping "a" with key shared-secret\n');
      if (fail) { this.emit('message', { type: 'failed', error: fail }); this.emit('exit', 1); } else this.emit('message', 'ready');
    });
  }
  postMessage(msg) {
    if (msg?.type === 'status') { this.asked++; queueMicrotask(() => this.emit('message', { type: 'status', id: msg.id, snapshot: { at: 'now', channel: { name: 'Table A', rule: 'coc7e' }, usage: { today: { billable: 42 } }, note: 'password-secret' } })); return; }
    queueMicrotask(() => this.emit('exit', 0));
  }
  terminate() { this.emit('exit', 1); }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
test('the manager keeps runtime facts, a redacted log, the reason a channel failed, and live snapshots', async t => {
  const host = fixture(t);
  let fail = 'cannot sign in with password-secret';
  const manager = new _M(host, { makeWorker: cfg => new TalkingWorker(cfg, { fail: cfg.channelId === 'b' ? fail : null }) });
  t.after(() => manager.close());
  await manager.startAll(); await settle();
  const b = await manager.detail('b');
  assert.equal(b.status, 'failed'); assert.equal(b.runtime.lastError, 'cannot sign in with ••••'); assert.equal(b.live, null);
  assert.equal(manager.status().find(c => c.id === 'b').lastError, 'cannot sign in with ••••');
  const a = await manager.detail('a');
  assert.equal(a.status, 'running'); assert.equal(a.runtime.starts, 1); assert.ok(a.runtime.readyAt); assert.equal(a.config, 'a.yml');
  assert.equal(a.live.channel.name, 'Table A'); assert.equal(a.live.note, '••••', 'snapshots are redacted too');
  const logs = manager.logs('a');
  assert.ok(logs.lines.some(l => l.text === '12:00:00 keeping "a" with key ••••'), JSON.stringify(logs));
  assert.deepEqual(manager.logs('a', logs.last).lines, []);
  assert.equal(manager.status()[0].usageToday, 42);
  // A form save writes only the changed key and restarts the running channel.
  const before = manager.config('a');
  assert.equal(before.values['calendar.max_days'].set, 1);
  const saved = await manager.saveForm('a', { 'calendar.max_days': 3, 'pacing.debounce_ms': 1500 }, before.revision);
  assert.equal(saved.restarted, true); assert.match(fs.readFileSync(host.channels[0].config, 'utf8'), /table:\n  coplayers: 0\ncalendar:\n  max_days: 3\npacing:\n  debounce_ms: 1500\n/);
  await assert.rejects(manager.saveForm('a', { 'calendar.max_days': 4 }, before.revision), /reload before saving/);
  assert.equal((await manager.detail('a')).runtime.starts, 2);
  // The worker stops answering: the last snapshot is shown, marked stale.
  const quiet = new _M(host, { statusTimeout: 30, makeWorker: cfg => Object.assign(new TalkingWorker(cfg), { postMessage(msg) { if (msg !== 'stop') return; queueMicrotask(() => this.emit('exit', 0)); } }) });
  t.after(() => quiet.close());
  await quiet.start(host.channels[0]); await settle();
  quiet.runtime('a').snapshot = { at: 'earlier', channel: { name: 'old' } };
  assert.deepEqual(await quiet.snapshot('a'), { at: 'earlier', channel: { name: 'old' }, stale: true });
  assert.throws(() => manager.validate('a', 'llm:\n  api_key: x\n'), /shared configuration/);
  assert.equal(manager.validate('a', 'pacing:\n  debounce_ms: 900\n').values['pacing.debounce_ms'].effective, 900);
});

test('Web UI: host summary, schema, status, logs, validation and form saves, all without secrets', async t => {
  const host = fixture(t), manager = new _M(host, { makeWorker: cfg => new TalkingWorker(cfg) });
  const web = await startWeb(manager, host.web);
  t.after(async () => { await manager.close(); await new Promise(resolve => web.close(resolve)); });
  await manager.startAll(); await settle();
  const base = `http://127.0.0.1:${web.address().port}`;
  const headers = { Authorization: `Bearer ${host.web.token}`, 'Content-Type': 'application/json' };
  const get = async path => { const r = await fetch(base + path, { headers }); return { status: r.status, text: await r.text() }; };
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  for (const path of ['/api/host', '/api/schema', '/api/channels', '/api/channels/a/status', '/api/channels/a/logs', '/api/channels/a/config']) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    for (const secret of ['shared-secret', 'password-secret', host.web.token, 'http://endpoint']) assert.ok(!r.text.includes(secret), `${secret} in ${path}`);
  }
  assert.equal((await fetch(base + '/api/host')).status, 401);
  const info = JSON.parse((await get('/api/host')).text);
  assert.equal(info.account, 'fixture'); assert.equal(info.llm.provider, 'mock'); assert.equal(info.counts.running, 2);
  assert.equal(JSON.parse((await get('/api/channels/a/status')).text).live.channel.name, 'Table A');
  assert.equal((await get('/api/channels/a/status')).status, 200); assert.equal((await get('/api/channels/zz/status')).status, 404);
  assert.equal((await get('/api/channels/a/bogus')).status, 404);
  assert.equal((await post('/api/channels/a/logs', {})).status, 405);
  assert.equal((await post('/api/channels/a/validate', { yaml: 'mystery: 1\n' })).status, 400);
  assert.equal((await post('/api/channels/a/validate', { yaml: 'pacing:\n  debounce_ms: 700\n' })).body.values['pacing.debounce_ms'].effective, 700);
  const config = JSON.parse((await get('/api/channels/a/config')).text);
  assert.equal(config.values['table.coplayers'].set, 0); assert.equal(config.values['table.coplayers'].default, 2, 'what removing the key would give');
  assert.equal((await post('/api/channels/a/form', { changes: { 'table.coplayers': 99 }, revision: config.revision })).status, 400);
  const saved = await post('/api/channels/a/form', { changes: { 'table.coplayers': 2, 'llm.model': 'claude-sonnet-5-5' }, revision: config.revision });
  assert.equal(saved.status, 200); assert.equal(saved.body.restarted, true); assert.equal(saved.body.values['llm.model'].set, 'claude-sonnet-5-5');
  assert.equal((await post('/api/channels/a/form', { changes: { 'table.coplayers': 1 }, revision: config.revision })).status, 409);
  assert.equal((await post('/api/channels/a/form', { changes: { 'llm.api_key': 'x' }, revision: saved.body.revision })).status, 400);
  const page = await (await fetch(base)).text();
  assert.match(page, /GM 控制台/); assert.ok(!/<script>|style="/.test(page), 'no inline script or style (CSP)');
  assert.equal((await fetch(base + '/app.js')).status, 200);
});

// A platform with one server where the account is GM of two channels, and room to create more.
async function fakePlatform(t) {
  const { createServer } = await import('node:http');
  const state = { servers: [{ id: 's1', name: 'Thursday' }], channels: { s1: [{ id: 'kept-1', name: 'Kept One', my_role: 'gm', knowledge_mode: 'public', rule_system: 'coc7e' }, { id: 'kept-2', name: 'Kept Two', my_role: 'gm', knowledge_mode: 'isolated', rule_system: 'dnd2024' }, { id: 'other', name: 'Not mine', my_role: 'player' }] }, made: [], logins: 0 };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {}, url = new URL(req.url, 'http://localhost').pathname;
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url === '/api/auth/login') { state.logins++; return body.password === 'password-secret' ? send(200, { token: 'session-token', user: { id: 'gm' } }) : send(401, { error: 'bad login' }); }
    if (req.method === 'GET' && url === '/api/servers') return send(200, state.servers);
    if (req.method === 'POST' && url === '/api/servers') { const s = { id: `s${state.servers.length + 1}`, name: body.name }; state.servers.push(s); state.channels[s.id] = []; return send(200, s); }
    let m = url.match(/^\/api\/servers\/(\w+)\/channels$/);
    if (m && req.method === 'GET') return send(200, state.channels[m[1]] ?? []);
    if (m && req.method === 'POST') { const c = { id: `new-${state.made.length + 1}`, name: body.name, my_role: 'gm', knowledge_mode: body.knowledge_mode, rule_system: body.rule_system }; state.channels[m[1]].push(c); state.made.push({ server: m[1], ...body }); return send(200, c); }
    if ((m = url.match(/^\/api\/servers\/(\w+)\/invites$/))) return send(200, { code: 'INVITE42' });
    if ((m = url.match(/^\/api\/channels\/([\w-]+)$/))) {
      const c = Object.values(state.channels).flat().find(x => x.id === m[1]);
      if (!c) return send(404, { error: 'not found' });
      if (req.method === 'PUT') { Object.assign(c, body); return send(200, c); }
      return send(200, c);
    }
    send(404, { error: url });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, state };
}

test('hosting tasks: attach a kept channel or create one on the platform, toggle start-up, remove; the shared file keeps its secrets and comments', async t => {
  const host = fixture(t), platform = await fakePlatform(t);
  fs.writeFileSync(host.file, `# the shared file\napi_base: ${platform.base}\naccount:\n  username: fixture\n  password: password-secret   # keep private\nllm:\n  provider: mock\n  api_key: shared-secret\nwebui:\n  enabled: true\n  token: test-token-longer-than-24-characters\n  port: 0\nchannels:\n  - id: a\n    config: a.yml\n`);
  const loaded = loadHost(host.file), made = [];
  const manager = new _M(loaded, { makeWorker: cfg => { const w = new TalkingWorker(cfg); made.push(w); return w; } });
  t.after(() => manager.close());
  const view = await manager.platform();
  assert.equal(view.account, 'fixture');
  assert.deepEqual(view.channels.map(c => [c.id, c.rule, c.knowledge, c.hosted]), [['kept-1', 'coc7e', 'public', false], ['kept-2', 'dnd2024', 'isolated', false]], 'only channels the account is GM of');
  assert.deepEqual(view.servers, [{ id: 's1', name: 'Thursday' }]);
  assert.equal(view.defaults['table.coplayers'].default, 2);
  // Attach a kept channel, with settings, started at once.
  const attached = await manager.create({ source: 'existing', channel_id: 'kept-2', settings: { 'table.level': '3', 'table.coplayers': 1 } });
  assert.deepEqual(attached, { id: 'kept-2', name: 'Kept Two', rule: 'dnd2024', created: false, invite: null, config: 'kept-2.yml' });
  assert.equal(fs.readFileSync(path.join(loaded.root, 'kept-2.yml'), 'utf8'), 'table:\n  level: 3\n  coplayers: 1\n');
  assert.equal(made.at(-1).cfg.channelId, 'kept-2'); assert.equal(made.at(-1).cfg.level, 3);
  await settle(); assert.equal(manager.status().find(c => c.id === 'kept-2').status, 'running');
  const shared = fs.readFileSync(host.file, 'utf8');
  assert.match(shared, /^# the shared file\n/); assert.match(shared, /password: password-secret +# keep private/); assert.match(shared, /api_key: shared-secret/);
  assert.match(shared, /channels:\n  - id: a\n    config: a\.yml\n  - id: kept-2\n    config: kept-2\.yml\n/);
  assert.equal((fs.statSync(host.file).mode & 0o777).toString(8), '600');
  await assert.rejects(manager.create({ source: 'existing', channel_id: 'kept-2' }), /已经在主持中/);
  await assert.rejects(manager.create({ source: 'existing', channel_id: 'other' }), /not the GM/);
  await assert.rejects(manager.create({ source: 'existing', channel_id: 'kept-1', settings: { 'table.coplayers': 99 } }), /不能大于 8/);
  assert.equal(platform.state.made.length, 0);
  // Create a new channel on a new server: casual makes it isolated; the invite code comes back; not started.
  const created = await manager.create({ source: 'new', server_name: 'Weekend', channel_name: 'The Shadow', rule_system: 'coc7e', era: '1920s', settings: { 'modes.casual': 'true' }, start: false, enabled: false, prepare_on_start: false });
  assert.deepEqual(created, { id: 'new-1', name: 'The Shadow', rule: 'coc7e', created: true, invite: 'INVITE42', config: 'new-1.yml' });
  assert.deepEqual(platform.state.made, [{ server: 's2', name: 'The Shadow', knowledge_mode: 'isolated', rule_system: 'coc7e' }]);
  assert.equal(fs.readFileSync(path.join(loaded.root, 'new-1.yml'), 'utf8'), 'modes:\n  casual: true\nchannel:\n  era: 1920s\n');
  assert.equal(manager.status().find(c => c.id === 'new-1').status, 'stopped');
  await assert.rejects(manager.create({ source: 'new', channel_name: '', rule_system: 'coc7e', server_name: 'x' }), /频道名称不能为空/);
  await assert.rejects(manager.create({ source: 'new', channel_name: 'x', rule_system: 'gurps', server_name: 'x' }), /规则必须是/);
  // The registry as a fresh host would read it.
  assert.deepEqual(loadHost(host.file).channels.map(c => [c.id, c.enabled, c.prepareOnStart]), [['a', true, true], ['kept-2', true, true], ['new-1', false, false]]);
  assert.deepEqual(await manager.setRegistry('new-1', { enabled: true }), { enabled: true, prepareOnStart: false });
  assert.deepEqual(loadHost(host.file).channels.find(c => c.id === 'new-1'), { id: 'new-1', config: fs.realpathSync(path.join(loaded.root, 'new-1.yml')), enabled: true, prepareOnStart: false });
  await manager.setRegistry('a', { prepare_on_start: false });
  assert.match(fs.readFileSync(host.file, 'utf8'), /- id: a\n    config: a\.yml\n    prepare_on_start: false\n/);
  // Remove: stopped, out of the registry, files kept; it can be attached again.
  await manager.remove('kept-2');
  assert.ok(!manager.running.has('kept-2'), 'its worker was stopped');
  assert.ok(!manager.status().some(c => c.id === 'kept-2')); assert.ok(!loadHost(host.file).channels.some(c => c.id === 'kept-2'));
  assert.ok(fs.existsSync(path.join(loaded.root, 'kept-2.yml')));
  assert.equal((await manager.platform()).channels.find(c => c.id === 'kept-2').hosted, false);
  const again = await manager.create({ source: 'existing', channel_id: 'kept-2', start: false });
  assert.equal(again.config, 'kept-2-2.yml', 'the kept file is never overwritten');
  assert.match(fs.readFileSync(host.file, 'utf8'), /password: password-secret +# keep private/);
});

test('Web UI hosting-task routes: platform listing, create, switches and remove, without secrets', async t => {
  const host = fixture(t), platform = await fakePlatform(t);
  const data = JSON.parse(fs.readFileSync(host.file, 'utf8')); data.api_base = platform.base; fs.writeFileSync(host.file, JSON.stringify(data));
  const loaded = loadHost(host.file), manager = new _M(loaded, { makeWorker: cfg => new TalkingWorker(cfg) });
  const web = await startWeb(manager, loaded.web);
  t.after(async () => { await manager.close(); await new Promise(resolve => web.close(resolve)); });
  const base = `http://127.0.0.1:${web.address().port}`, headers = { Authorization: `Bearer ${loaded.web.token}`, 'Content-Type': 'application/json' };
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const listing = await fetch(base + '/api/platform', { headers }); const text = await listing.text();
  assert.equal(listing.status, 200); for (const secret of ['password-secret', 'shared-secret', 'session-token']) assert.ok(!text.includes(secret), secret);
  assert.equal((await fetch(base + '/api/platform')).status, 401);
  assert.equal((await post('/api/channels', { source: 'existing', channel_id: 'kept-1', start: false })).status, 200);
  assert.equal((await post('/api/channels', { source: 'existing', channel_id: 'kept-1' })).status, 409);
  assert.equal((await post('/api/channels', { source: 'existing' })).status, 400);
  assert.equal((await fetch(base + '/api/channels', { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
  assert.deepEqual((await post('/api/channels/kept-1/registry', { enabled: false })).body, { ok: true, enabled: false, prepareOnStart: true });
  assert.equal((await post('/api/channels/kept-1/remove', {})).status, 400, 'removal needs the id as confirmation');
  assert.equal((await post('/api/channels/kept-1/remove', { confirm: 'kept-1' })).status, 200);
  assert.equal((await fetch(base + '/api/channels/kept-1/status', { headers })).status, 404);
  const wrong = JSON.parse(fs.readFileSync(host.file, 'utf8')); wrong.account.password = 'nope'; fs.writeFileSync(host.file, JSON.stringify(wrong));
  const failing = new _M(loadHost(host.file), { makeWorker: cfg => new TalkingWorker(cfg) });
  await assert.rejects(failing.platform(), /bad login|401/);
});
