import fs from 'node:fs';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { channelConfig, atomicWrite } from './host-config.mjs';
import { lockPath } from './state.mjs';

export class HostManager {
  constructor(host, { makeWorker = cfg => new Worker(new URL('./host-worker.mjs', import.meta.url), { workerData: cfg, stdout: true, stderr: true }), stopTimeout = 15000 } = {}) {
    this.host = host; this.makeWorker = makeWorker; this.stopTimeout = stopTimeout;
    this.running = new Map(); this.states = new Map(); this.queue = Promise.resolve(); this.closed = false;
  }
  serial(fn) { const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job; }
  entry(id) { const entry = this.host.channels.find(c => c.id === id); if (!entry) throw Error('Unknown channel'); return entry; }
  status() { return this.host.channels.map(e => ({ id: e.id, enabled: e.enabled, status: this.states.get(e.id) ?? 'stopped' })); }
  async start(entry) {
    if (this.closed || this.running.has(entry.id)) return;
    const cfg = channelConfig(this.host, entry);
    const worker = this.makeWorker(cfg), record = { worker, locked: false };
    this.running.set(entry.id, record); this.states.set(entry.id, 'starting');
    // Provider errors can include secrets. Do not expose raw worker output through the UI or shared logs.
    worker.stdout?.resume(); worker.stderr?.resume();
    record.exited = new Promise(resolve => worker.once('exit', code => {
      if (record.locked) {
        const file = lockPath(cfg.stateDir, entry.id);
        try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch {}
      }
      this.running.delete(entry.id);
      this.states.set(entry.id, record.stopping ? 'stopped' : 'failed');
      resolve(code);
    }));
    worker.on('error', () => this.states.set(entry.id, 'failed'));
    worker.on('message', msg => {
      if (msg === 'locked') record.locked = true;
      if (msg === 'ready' && !record.stopping) this.states.set(entry.id, 'running');
      if (msg === 'failed') this.states.set(entry.id, 'failed');
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
  action(id, action) { return this.serial(async () => {
    if (this.closed) throw Error('Host is shutting down');
    const entry = this.entry(id);
    if (!['start', 'stop', 'restart'].includes(action)) throw Error('Unknown action');
    if (action !== 'start') await this.stop(id);
    if (action !== 'stop') await this.start(entry);
  }); }
  save(id, text, revision) { return this.serial(async () => {
    if (this.closed) throw Error('Host is shutting down');
    const entry = this.entry(id);
    if (revision !== undefined && crypto.createHash('sha256').update(fs.readFileSync(entry.config, 'utf8')).digest('hex') !== revision) throw Object.assign(Error('Configuration changed; reload before saving'), { code: 'STALE_CONFIG' });
    channelConfig(this.host, entry, text);
    atomicWrite(entry.config, text);
    const active = this.running.has(id);
    if (active) { await this.stop(id); await this.start(entry); }
  }); }
  async close() { this.closed = true; await this.queue; await Promise.all([...this.running.keys()].map(id => this.stop(id))); }
}
