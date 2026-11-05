#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadEnvFile } from './config.mjs';
import { loadHost, channelConfig } from './host-config.mjs';
import { HostManager } from './host-manager.mjs';
import { startWeb } from './host-web.mjs';
import { acquireLock } from './state.mjs';

export async function serve(file) {
  const host = loadHost(file);
  // Reject credential-bearing channel files before the Web UI can read them.
  for (const entry of host.channels) channelConfig(host, entry);
  const release = acquireLock(host.stateDir, '.multi-host');
  if (!release) throw Error('Another host already owns this state directory');
  const manager = new HostManager(host);
  let web;
  try {
    if (host.web.enabled) {
      web = await startWeb(manager, host.web);
      console.log(`GM configuration UI: http://${host.web.host}:${web.address().port}`);
    }
    await manager.startAll();
  } catch (error) { web?.close(); await manager.close(); release(); throw error; }
  // Keep an explicitly all-disabled host alive for later starts through the UI.
  const keepAlive = setInterval(() => {}, 60000);
  return { manager, web, async close() {
    clearInterval(keepAlive);
    const closing = web && new Promise(resolve => { web.close(resolve); web.closeIdleConnections(); });
    try { await manager.close(); await closing; } finally { release(); }
  }};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env ?? path.join(process.cwd(), '.env'));
  serve(args.config ?? 'gm-host.yml').then(host => {
    let closing = false;
    const stop = () => { if (closing) return; closing = true; host.close().catch(() => { process.exitCode = 1; }); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    console.log('Multi-channel GM host started');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
