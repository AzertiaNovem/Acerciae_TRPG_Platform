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
  postMessage() { this.stops++; queueMicrotask(() => this.emit('exit', 0)); }
  terminate() { this.emit('exit', 1); }
}
test('shared credentials, independent policies, relative paths and invalid override rejection', t => {
  const host = fixture(t), a = channelConfig(host, host.channels[0]), b = channelConfig(host, host.channels[1]);
  assert.equal(a.llm.apiKey, 'shared-secret'); assert.equal(b.llm.apiKey, a.llm.apiKey);
  assert.equal(a.password, 'password-secret'); assert.equal(a.calendarMaxDays, 1);
  assert.equal(b.level, 4); assert.equal(b.autonomy, false); assert.notEqual(a.channelId, b.channelId);
  assert.equal(a.stateDir, path.join(host.root, '.state'));
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
  assert.equal(code, 1); assert.deepEqual(messages, ['failed']);
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
