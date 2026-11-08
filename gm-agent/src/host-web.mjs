import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { schema } from './host-schema.mjs';
import { providerNames } from './host-config.mjs';
import { HostSessions } from './host-sessions.mjs';
const asset = name => fs.readFileSync(new URL(`../web/${name}`, import.meta.url));
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/usage.js': ['usage.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const OPERATIONS = ['config', 'action', 'status', 'logs', 'form', 'validate', 'registry', 'remove'];
const originOf = value => { try { return new URL(value).origin; } catch { return null; } };
// Browsers send Origin on every POST. It must be this UI's own address: the Host the request arrived with, the host a
// reverse proxy forwarded (X-Forwarded-Host; a page on another site cannot set that header without a CORS preflight,
// which this server never grants), or an address listed in webui.allowed_origins. The bearer token is the real guard;
// this is a second one.
export function originAllowed(headers, allowed = []) {
  if (!headers.origin) return true;
  const origin = originOf(headers.origin);
  if (!origin) return false;
  const hosts = [headers.host, String(headers['x-forwarded-host'] ?? '').split(',')[0].trim()].filter(Boolean);
  const own = hosts.flatMap(h => [originOf(`http://${h}`), originOf(`https://${h}`)]);
  if ([...own, ...allowed].includes(origin)) return true;
  // A proxy that forwards the host name without its port (nginx's $host) still names this site.
  const name = new URL(origin).hostname;
  return hosts.some(h => !/:\d+$/.test(h) && originOf(`http://${h}`) && new URL(`http://${h}`).hostname === name);
}
export async function startWeb(manager, options) {
  const sessions = new HostSessions(manager.host.stateDir, options.token);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ASSETS[url.pathname]) {
        const [name, type] = ASSETS[url.pathname]; res.writeHead(200, { 'Content-Type': type }); res.end(asset(name)); return;
      }
      const supplied = digest(req.headers.authorization ?? ''), expected = digest(`Bearer ${options.token}`);
      const bearer = crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (req.method === 'POST' && url.pathname === '/api/session' && !bearer) return send(401, { error: 'Authentication required' });
      if (!bearer && !sessions.authenticate(req, res)) return send(401, { error: 'Authentication required' });
      if (!originAllowed(req.headers, options.allowedOrigins)) return send(403, { error: `Origin not allowed: this page was opened at ${req.headers.origin}, but the request reached the host as ${req.headers.host ?? '(no Host)'}. Behind a reverse proxy, forward the original Host header with its port (nginx: proxy_set_header Host $http_host;) or add ${req.headers.origin} to webui.allowed_origins in the shared configuration.` });
      if (url.pathname === '/api/session') {
        if (req.method === 'POST') { sessions.issue(req, res); return send(200, { ok: true }); }
        if (req.method === 'GET') return send(200, { authenticated: true });
        if (req.method === 'DELETE') { sessions.revoke(req, res); return send(200, { ok: true }); }
        return send(405, { error: 'Method not allowed' });
      }
      if (req.method === 'GET' && url.pathname === '/api/channels') { manager.warm(); return send(200, manager.status()); }
      if (req.method === 'GET' && url.pathname === '/api/host') return send(200, manager.hostInfo());
      if (req.method === 'GET' && url.pathname === '/api/schema') return send(200, schema(providerNames(manager.host)));
      if (req.method === 'GET' && url.pathname === '/api/platform') return send(200, await manager.platform());
      const readJson = async () => {
        if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(Error('Use application/json'), { code: 'HTTP', status: 415 });
        let text = '', bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) throw Object.assign(Error('Request too large'), { code: 'HTTP', status: 413 }); text += chunk; }
        return JSON.parse(text);
      };
      // A new hosting task: attach a kept channel or create one on the platform, then (by default) start it.
      if (req.method === 'POST' && url.pathname === '/api/channels') return send(200, { ok: true, ...(await manager.create(await readJson())) });
      const match = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]{1,128})\/([a-z]+)$/);
      if (!match || !OPERATIONS.includes(match[2])) return send(404, { error: 'Not found' });
      const [, id, operation] = match;
      try { manager.entry(id); } catch { return send(404, { error: 'Unknown channel' }); }
      if (req.method === 'GET') {
        if (operation === 'config') return send(200, manager.config(id));
        if (operation === 'status') return send(200, await manager.detail(id));
        if (operation === 'logs') return send(200, manager.logs(id, Math.max(0, Number(url.searchParams.get('after')) || 0)));
        return send(405, { error: 'Method not allowed' });
      }
      if (req.method !== 'POST' || ['status', 'logs'].includes(operation)) return send(405, { error: 'Method not allowed' });
      const body = await readJson();
      if (operation === 'registry') return send(200, { ok: true, ...(await manager.setRegistry(id, body)) });
      if (operation === 'remove') {
        if (body.confirm !== id) throw Error('Confirm with the channel id');
        return send(200, { ok: true, ...(await manager.remove(id)) });
      }
      if (operation === 'validate') {
        if (typeof body.yaml !== 'string') throw Error('yaml must be text');
        return send(200, { ok: true, ...manager.validate(id, body.yaml) });
      }
      if (operation === 'config' || operation === 'form') {
        // Compare inside the same queue as writes, so two editors cannot overwrite each other.
        if (typeof body.revision !== 'string') throw Error('Configuration revision required');
        let saved;
        if (operation === 'config') {
          if (typeof body.yaml !== 'string') throw Error('yaml must be text');
          saved = await manager.save(id, body.yaml, body.revision);
        } else saved = await manager.saveForm(id, body.changes, body.revision);
        return send(200, { ok: true, ...saved, values: manager.config(id).values });
      }
      await manager.action(id, body.action);
      send(200, { ok: true });
    } catch (error) { send(error.code === 'HTTP' ? error.status : error.code === 'STALE_CONFIG' || error.code === 'CONFLICT' ? 409 : 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  return server;
}
