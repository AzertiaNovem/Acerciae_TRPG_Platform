import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { buildConfig } from './config.mjs';

export const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export function parseChannel(text) {
  let data;
  try { data = YAML.parse(text); } catch { throw Error("Invalid channel YAML"); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Channel configuration must be a YAML mapping');
  for (const key of ['account', 'llm', 'planner']) {
    for (const field of Object.keys(data[key] ?? {})) {
      if (['password', 'api_key', 'api_base', 'provider', 'username', 'register'].includes(field)) throw Error(`${key}.${field} belongs in the shared configuration`);
    }
  }
  const cfg = buildConfig({}, {}, { data });
  if (cfg.warnings.length) throw Error(cfg.warnings.join('; '));
  if (data.channel?.create) throw Error('The host attaches to existing channels; create channels with setup');
  return data;
}
export function loadHost(file) {
  file = path.resolve(file);
  const data = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || !Array.isArray(data.channels)) throw Error('Shared configuration needs a channels list');
  const root = path.dirname(file), ids = new Set(), files = new Set();
  const channels = data.channels.map(entry => {
    if (!validId(entry.id) || ids.has(entry.id)) throw Error('Invalid or duplicate channel id');
    ids.add(entry.id);
    if (typeof entry.config !== 'string') throw Error('Each channel needs a config file');
    const config = fs.realpathSync(path.resolve(root, entry.config));
    if (config === fs.realpathSync(file) || files.has(config)) throw Error('Each channel needs a distinct configuration file');
    files.add(config);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw Error('enabled must be boolean');
    if (entry.prepare_on_start !== undefined && typeof entry.prepare_on_start !== 'boolean') throw Error('prepare_on_start must be boolean');
    return { id: entry.id, config, enabled: entry.enabled !== false, prepareOnStart: entry.prepare_on_start !== false };
  });
  const web = data.webui ?? {};
  if (web.enabled !== undefined && typeof web.enabled !== 'boolean') throw Error('webui.enabled must be boolean');
  const host = web.host ?? '127.0.0.1', port = web.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid Web UI port');
  if (web.enabled && (!web.token || String(web.token).length < 24)) throw Error('Web UI requires a token of at least 24 characters');
  return { file, root, data, channels, stateDir: path.resolve(root, data.state_dir ?? '.state'), web: { enabled: web.enabled === true, host, port, token: String(web.token ?? '') } };
}
export function channelConfig(host, entry, text = fs.readFileSync(entry.config, 'utf8')) {
  const local = parseChannel(text), shared = host.data;
  const data = { ...local, account: { ...local.account, ...shared.account }, llm: { ...shared.llm, ...local.llm }, planner: { ...shared.planner, ...local.planner } };
  // Secrets and transport are shared even when a table selects a different model or effort.
  const env = { GM_PASSWORD: shared.account?.password ?? process.env.GM_PASSWORD,
    LLM_API_KEY: shared.llm?.api_key ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    PLANNER_API_KEY: shared.planner?.api_key ?? shared.llm?.api_key ?? process.env.PLANNER_API_KEY ?? process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY };
  delete data.account?.password; delete data.llm?.api_key; delete data.planner?.api_key;
  const cfg = buildConfig({ api: shared.api_base ?? 'http://localhost:8080', channel: entry.id, 'state-dir': host.stateDir }, env, { data, dir: path.dirname(entry.config) });
  if (cfg.warnings.length) throw Error(cfg.warnings.join('; '));
  cfg.prepareOnStart = entry.prepareOnStart !== false;
  return cfg;
}
export function atomicWrite(file, text) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

// The shared account and platform address alone, for the host's own platform calls (listing and creating channels).
export function sharedConfig(host) {
  const shared = host.data ?? {};
  const account = { ...(shared.account ?? {}) }; delete account.password;
  return buildConfig({ api: shared.api_base ?? 'http://localhost:8080', 'state-dir': host.stateDir },
    { GM_PASSWORD: shared.account?.password ?? process.env.GM_PASSWORD }, { data: { account } });
}

// The registry (`channels:` in the shared file) edited in place: the file is read again, so hand edits elsewhere and
// its comments survive, and written atomically (mode 600: it holds credentials). `edit(doc, list)` gets the YAML
// document and its channels sequence.
export function editRegistry(host, edit) {
  const file = fs.realpathSync(host.file);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors.length || !YAML.isMap(doc.contents)) throw Error('The shared configuration does not parse; fix it by hand first');
  if (!YAML.isSeq(doc.get('channels', true))) doc.set('channels', doc.createNode([]));
  const list = doc.get('channels', true);
  edit(doc, list);
  atomicWrite(file, String(doc));
}
export const registryIndex = (list, id) => list.items.findIndex(item => YAML.isMap(item) && String(item.get('id')) === id);
