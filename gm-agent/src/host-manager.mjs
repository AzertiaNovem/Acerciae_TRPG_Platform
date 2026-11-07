import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import YAML from 'yaml';
import { channelConfig, atomicWrite, parseChannel, sharedConfig, editRegistry, registryIndex, validId } from './host-config.mjs';
import { keptChannels } from './channels.mjs';
import { RULE_SYSTEMS } from './rules/index.mjs';
import { applyChanges, formValues } from './host-schema.mjs';
import { lockPath } from './state.mjs';

const LOG_LINES = 600, LOG_LINE_CHARS = 2000;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');

// Every secret the host knows, longest first, so a key never shows through a shorter one that it contains.
export function secretsOf(host, env = process.env) {
  const values = [host.data?.account?.password, host.data?.llm?.api_key, host.data?.planner?.api_key, host.web?.token,
    env.GM_PASSWORD, env.LLM_API_KEY, env.ANTHROPIC_API_KEY, env.PLANNER_API_KEY];
  return [...new Set(values.filter(v => typeof v === 'string' && v.length >= 4))].sort((a, b) => b.length - a.length);
}
// Worker output can carry provider errors, request URLs and tokens: known secrets and anything shaped like a
// credential are masked before the Web UI sees a line.
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets) s = s.split(v).join('••••');
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ••••')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '••••')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '••••')
    .replace(/([?&](?:token|key|api_key|apikey|access_token|password)=)[^&\s"']+/gi, '$1••••')
    .replace(/("(?:api_key|apiKey|password|token|secret)"\s*:\s*")[^"]{4,}"/gi, '$1••••"')
    .replace(/\b((?:api_key|apikey|password|secret)\s*[:=]\s*)(?!••••)[^\s,;&"']{4,}/gi, '$1••••');
}

const invalid = message => { throw Object.assign(Error(message), { code: 'INVALID_SETTING' }); };
const conflict = message => { throw Object.assign(Error(message), { code: 'CONFLICT' }); };
// A new hosting task from the Web UI: attach a channel the account keeps, or create one on the platform first.
export function checkTask(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) invalid('缺少主持任务');
  const line = (v, max, label, required) => {
    const s = String(v ?? '').trim();
    if (required && !s) invalid(`${label}不能为空`);
    if (s.length > max || /[\r\n]/.test(s)) invalid(`${label}必须是一行，不超过 ${max} 个字符`);
    return s;
  };
  const source = spec.source === 'new' || spec.source === 'existing' ? spec.source : invalid('来源必须是 existing 或 new');
  const settings = spec.settings ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings)) invalid('settings 必须是对象');
  const out = { source, settings, enabled: spec.enabled !== false, prepareOnStart: spec.prepare_on_start !== false, start: spec.start !== false };
  if (source === 'existing') {
    out.channelId = String(spec.channel_id ?? '');
    if (!validId(out.channelId)) invalid('请选择一个频道');
  } else {
    out.channelName = line(spec.channel_name, 100, '频道名称', true);
    out.serverId = String(spec.server_id ?? '');
    if (out.serverId && !validId(out.serverId)) invalid('服务器无效');
    out.serverName = out.serverId ? '' : line(spec.server_name, 100, '新服务器名称', true);
    out.ruleSystem = RULE_SYSTEMS.includes(spec.rule_system) ? spec.rule_system : invalid(`规则必须是 ${RULE_SYSTEMS.join('、')} 之一`);
    out.era = line(spec.era, 200, '时代', false);
  }
  return out;
}

export class HostManager {
  constructor(host, { makeWorker = cfg => new Worker(new URL('./host-worker.mjs', import.meta.url), { workerData: cfg, stdout: true, stderr: true }), stopTimeout = 15000, statusTimeout = 2500, now = () => Date.now() } = {}) {
    this.host = host; this.makeWorker = makeWorker; this.stopTimeout = stopTimeout; this.statusTimeout = statusTimeout; this.now = now;
    this.running = new Map(); this.states = new Map(); this.queue = Promise.resolve(); this.closed = false;
    this.runtimes = new Map(); this.requests = 0; this.startedAt = now();
    this.secrets = secretsOf(host);
  }
  serial(fn) { const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job; }
  entry(id) { const entry = this.host.channels.find(c => c.id === id); if (!entry) throw Error('Unknown channel'); return entry; }
  // What the host knows about a channel across restarts: when it started, how it ended, its log and last snapshot.
  runtime(id) {
    if (!this.runtimes.has(id)) this.runtimes.set(id, { starts: 0, startedAt: null, readyAt: null, stoppedAt: null, exitCode: null, lastError: null, logs: [], seq: 0, snapshot: null });
    return this.runtimes.get(id);
  }
  note(id, line) {
    const rt = this.runtime(id), text = redact(line, this.secrets).slice(0, LOG_LINE_CHARS);
    if (!text.trim()) return;
    rt.logs.push({ seq: ++rt.seq, at: new Date(this.now()).toISOString(), text });
    if (rt.logs.length > LOG_LINES) rt.logs.splice(0, rt.logs.length - LOG_LINES);
  }
  fail(id, message) { const rt = this.runtime(id); rt.lastError = redact(message, this.secrets).slice(0, LOG_LINE_CHARS); this.note(id, `[host] ${rt.lastError}`); }
  status() {
    return this.host.channels.map(e => {
      const rt = this.runtime(e.id), live = rt.snapshot;
      return { id: e.id, enabled: e.enabled, status: this.states.get(e.id) ?? 'stopped', name: live?.channel?.name ?? null, rule: live?.channel?.rule ?? null,
        startedAt: rt.startedAt ? new Date(rt.startedAt).toISOString() : null, lastError: rt.lastError, paused: live?.activity?.paused ?? null,
        usageToday: live?.usage?.today?.billable ?? null,
        usage: live?.usage ? { at: live.usage.at ?? live.at, since: live.usage.periods?.today?.since ?? null,
          timezone: live.usage.timezone ?? null, today: live.usage.today } : null };
    });
  }
  hostInfo() {
    const d = this.host.data ?? {}, counts = {};
    for (const c of this.status()) counts[c.status] = (counts[c.status] ?? 0) + 1;
    return { startedAt: new Date(this.startedAt).toISOString(), pid: process.pid, node: process.version, apiBase: d.api_base ?? 'http://localhost:8080',
      account: d.account?.username ?? null, llm: { provider: d.llm?.provider ?? null, model: d.llm?.model ?? null, effort: d.llm?.effort ?? null },
      planner: { model: d.planner?.model ?? null, effort: d.planner?.effort ?? null, enabled: d.planner?.enabled ?? null },
      stateDir: path.relative(this.host.root, this.host.stateDir) || '.', web: { host: this.host.web.host, port: this.host.web.port }, counts, channels: this.host.channels.length };
  }
  async start(entry) {
    if (this.closed || this.running.has(entry.id)) return;
    const rt = this.runtime(entry.id);
    let cfg;
    try { cfg = channelConfig(this.host, entry); }
    catch (error) { this.states.set(entry.id, 'failed'); this.fail(entry.id, `configuration: ${error.message}`); throw error; }
    const worker = this.makeWorker(cfg), record = { worker, locked: false, replies: new Map() };
    Object.assign(rt, { starts: rt.starts + 1, startedAt: this.now(), readyAt: null, stoppedAt: null, exitCode: null, lastError: null });
    this.note(entry.id, `[host] starting (start #${rt.starts})`);
    this.running.set(entry.id, record); this.states.set(entry.id, 'starting');
    // Raw output can include secrets: every line is redacted before it is kept for the UI.
    for (const stream of [worker.stdout, worker.stderr]) if (stream) readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => this.note(entry.id, line));
    record.exited = new Promise(resolve => worker.once('exit', code => {
      if (record.locked) {
        const file = lockPath(cfg.stateDir, entry.id);
        try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch {}
      }
      for (const reply of record.replies.values()) reply(null);
      this.running.delete(entry.id);
      rt.exitCode = code; rt.stoppedAt = this.now();
      if (!record.stopping && !rt.lastError) this.fail(entry.id, `worker exited unexpectedly (code ${code})`);
      this.note(entry.id, `[host] ${record.stopping ? 'stopped' : 'exited'} (code ${code})`);
      this.states.set(entry.id, record.stopping ? 'stopped' : 'failed');
      resolve(code);
    }));
    worker.on('error', error => { this.states.set(entry.id, 'failed'); this.fail(entry.id, error?.message ?? String(error)); });
    worker.on('message', msg => {
      if (msg === 'locked') record.locked = true;
      if (msg === 'ready' && !record.stopping) { this.states.set(entry.id, 'running'); rt.readyAt = this.now(); this.note(entry.id, '[host] running'); this.snapshot(entry.id).catch(() => {}); }
      if (msg === 'failed') this.states.set(entry.id, 'failed');
      if (msg?.type === 'failed') { this.states.set(entry.id, 'failed'); this.fail(entry.id, msg.error ?? 'failed'); }
      if (msg?.type === 'status') record.replies.get(msg.id)?.(msg);
    });
  }
  async stop(id) {
    const record = this.running.get(id); if (!record) return;
    record.stopping = true; this.states.set(id, 'stopping'); record.worker.postMessage('stop');
    const timer = setTimeout(() => record.worker.terminate(), this.stopTimeout);
    try { await record.exited; } finally { clearTimeout(timer); }
  }
  async startAll() {
    for (const entry of this.host.channels) if (entry.enabled) {
      try { await this.start(entry); } catch { this.states.set(entry.id, 'failed'); }
    }
  }
  // A fresh snapshot from a running worker; otherwise (or when it does not answer in time) the last one, marked stale.
  async snapshot(id) {
    const rt = this.runtime(id), record = this.running.get(id);
    const last = () => (rt.snapshot ? { ...rt.snapshot, stale: true } : null);
    if (!record || this.states.get(id) !== 'running') return last();
    const request = ++this.requests;
    const msg = await new Promise(resolve => {
      const timer = setTimeout(() => { record.replies.delete(request); resolve(null); }, this.statusTimeout);
      record.replies.set(request, value => { clearTimeout(timer); record.replies.delete(request); resolve(value); });
      record.worker.postMessage({ type: 'status', id: request });
    });
    if (!msg?.snapshot) return last();
    rt.snapshot = JSON.parse(redact(JSON.stringify(msg.snapshot), this.secrets));
    return rt.snapshot;
  }
  async detail(id) {
    const entry = this.entry(id), rt = this.runtime(id), iso = ms => (ms ? new Date(ms).toISOString() : null);
    return { id, enabled: entry.enabled, prepareOnStart: entry.prepareOnStart !== false, status: this.states.get(id) ?? 'stopped',
      config: path.relative(this.host.root, entry.config),
      runtime: { starts: rt.starts, startedAt: iso(rt.startedAt), readyAt: iso(rt.readyAt), stoppedAt: iso(rt.stoppedAt), exitCode: rt.exitCode, lastError: rt.lastError },
      live: await this.snapshot(id) };
  }
  logs(id, after = 0) { this.entry(id); const rt = this.runtime(id); return { lines: rt.logs.filter(l => l.seq > after), last: rt.seq }; }
  config(id) {
    const entry = this.entry(id), yaml = fs.readFileSync(entry.config, 'utf8');
    return { yaml, revision: digest(yaml), values: this.values(entry, yaml) };
  }
  values(entry, yaml) { return formValues(parseChannel(yaml) ?? {}, channelConfig(this.host, entry, yaml), data => channelConfig(this.host, entry, YAML.stringify(data))); }
  // The channel list shows names and usage from snapshots: refresh those older than `maxAge` in the background.
  warm(maxAge = 15000) {
    for (const [id, record] of this.running) {
      const at = Date.parse(this.runtime(id).snapshot?.at ?? '') || 0;
      if (this.states.get(id) === 'running' && !record.warming && this.now() - at > maxAge) { record.warming = true; this.snapshot(id).catch(() => {}).finally(() => { record.warming = false; }); }
    }
  }
  // A check without saving: the YAML is valid for this channel, and these are the values it would run with.
  validate(id, yaml) { return { values: this.values(this.entry(id), yaml) }; }
  action(id, action) { return this.serial(async () => {
    if (this.closed) throw Error('Host is shutting down');
    const entry = this.entry(id);
    if (!['start', 'stop', 'restart'].includes(action)) throw Error('Unknown action');
    if (action !== 'start') await this.stop(id);
    if (action !== 'stop') await this.start(entry);
  }); }
  write(id, revision, make) { return this.serial(async () => {
    if (this.closed) throw Error('Host is shutting down');
    const entry = this.entry(id), current = fs.readFileSync(entry.config, 'utf8');
    if (revision !== undefined && digest(current) !== revision) throw Object.assign(Error('Configuration changed; reload before saving'), { code: 'STALE_CONFIG' });
    const text = make(current);
    channelConfig(this.host, entry, text);
    atomicWrite(entry.config, text);
    this.note(id, '[host] configuration saved');
    const active = this.running.has(id);
    if (active) { await this.stop(id); await this.start(entry); }
    return { revision: digest(text), yaml: text, restarted: active };
  }); }
  save(id, text, revision) { return this.write(id, revision, () => text); }
  // Form edits: only the changed keys, written into the file in place (comments and other keys stay).
  saveForm(id, changes, revision) { return this.write(id, revision, current => applyChanges(current, changes)); }
  // ---- hosting tasks (the registry in the shared file)
  async signIn() { const { signIn } = await import('./cli.mjs'); const cfg = sharedConfig(this.host); return { cfg, api: await signIn(cfg) }; }
  channelDir() { return this.host.channels.length ? path.dirname(this.host.channels[0].config) : path.join(this.host.root, 'channels'); }
  // The values a new channel file starts from (nothing set).
  defaults() {
    const probe = { id: 'new-channel', config: path.join(this.channelDir(), 'new-channel.yml') };
    return formValues({}, channelConfig(this.host, probe, '{}'));
  }
  // What the shared account can host: the channels it is GM of (and whether this host keeps them already), and the
  // servers a new channel could go to.
  async platform() {
    const { cfg, api } = await this.signIn();
    const [channels, servers] = await Promise.all([keptChannels(api), api.servers().catch(() => [])]);
    const hosted = new Set(this.host.channels.map(e => e.id));
    return { account: cfg.username, defaults: this.defaults(),
      channels: channels.map(c => ({ id: c.id, name: c.name, server: c.server, serverId: c.serverId, knowledge: c.knowledge_mode ?? 'public', rule: c.rule_system ?? 'coc7e', hosted: hosted.has(c.id) })),
      servers: (servers ?? []).map(s => ({ id: s.id, name: s.name })) };
  }
  create(spec) { return this.serial(async () => {
    if (this.closed) throw Error('Host is shutting down');
    const task = checkTask(spec);
    const settings = { ...task.settings };
    if (task.source === 'new' && task.era) settings['channel.era'] = task.era;
    const text = applyChanges('', settings), dir = this.channelDir();
    // The channel file must be valid before anything is created on the platform.
    channelConfig(this.host, { id: 'new-channel', config: path.join(dir, 'new-channel.yml') }, text);
    if (task.source === 'existing' && this.host.channels.some(e => e.id === task.channelId)) conflict('这个频道已经在主持中');
    const { resolveChannel } = await import('./cli.mjs');
    const { cfg, api } = await this.signIn();
    const casual = [true, 'true'].includes(settings['modes.casual']);
    const target = task.source === 'existing'
      ? await resolveChannel(api, { ...cfg, channelId: task.channelId }, { create: false })
      : await resolveChannel(api, { ...cfg, channelId: '', create: true, serverId: task.serverId, serverName: task.serverName, channelName: task.channelName, ruleSystem: task.ruleSystem, era: task.era, casual }, { create: true });
    const id = target.channel.id;
    if (!validId(id)) throw Error('The platform returned an unusable channel id');
    if (this.host.channels.some(e => e.id === id)) conflict('这个频道已经在主持中');
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, `${id}.yml`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${id}-${n}.yml`);
    fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    const relative = path.relative(this.host.root, file);
    try {
      editRegistry(this.host, (doc, list) => list.add(doc.createNode({ id, config: relative, ...(task.enabled ? {} : { enabled: false }), ...(task.prepareOnStart ? {} : { prepare_on_start: false }) })));
    } catch (error) { fs.unlinkSync(file); throw error; }
    const entry = { id, config: fs.realpathSync(file), enabled: task.enabled, prepareOnStart: task.prepareOnStart };
    this.host.channels.push(entry);
    this.note(id, `[host] hosting task created for ${target.created ? 'a new' : 'an existing'} channel "${target.channel.name}" (${relative})`);
    if (task.start) { try { await this.start(entry); } catch {} }
    return { id, name: target.channel.name, rule: target.channel.rule_system ?? 'coc7e', created: Boolean(target.created), invite: target.invite?.code ?? null, config: relative };
  }); }
  // Auto-start and prepare-on-start: written to the shared file, applied at the next start.
  setRegistry(id, patch = {}) { return this.serial(async () => {
    const entry = this.entry(id);
    const next = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : entry.enabled, prepareOnStart: typeof patch.prepare_on_start === 'boolean' ? patch.prepare_on_start : entry.prepareOnStart !== false };
    editRegistry(this.host, (doc, list) => {
      const i = registryIndex(list, id);
      if (i < 0) throw Error('This channel is no longer in the shared configuration; restart the host');
      const item = list.items[i];
      for (const [key, value] of [['enabled', next.enabled], ['prepare_on_start', next.prepareOnStart]]) {
        if (item.has(key) || !value) item.set(key, value);
      }
    });
    entry.enabled = next.enabled; entry.prepareOnStart = next.prepareOnStart;
    return next;
  }); }
  // Stops the channel and takes it off the registry; its channel file and state stay, so it can be added back.
  remove(id) { return this.serial(async () => {
    const entry = this.entry(id);
    await this.stop(id);
    editRegistry(this.host, (doc, list) => { const i = registryIndex(list, id); if (i >= 0) list.items.splice(i, 1); });
    this.host.channels.splice(this.host.channels.indexOf(entry), 1);
    this.states.delete(id); this.runtimes.delete(id);
    return { config: path.relative(this.host.root, entry.config) };
  }); }
  async close() { this.closed = true; await this.queue; await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
