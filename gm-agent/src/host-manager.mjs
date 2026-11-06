import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import YAML from 'yaml';
import { channelConfig, atomicWrite, parseChannel } from './host-config.mjs';
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
        usageToday: live?.usage?.today?.billable ?? null };
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
      if (msg === 'ready' && !record.stopping) { this.states.set(entry.id, 'running'); rt.readyAt = this.now(); this.note(entry.id, '[host] running'); }
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
  async close() { this.closed = true; await this.queue; await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
