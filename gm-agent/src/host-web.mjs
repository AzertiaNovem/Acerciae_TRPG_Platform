import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { schema } from './host-schema.mjs';
const asset = name => fs.readFileSync(new URL(`../web/${name}`, import.meta.url));
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const OPERATIONS = ['config', 'action', 'status', 'logs', 'form', 'validate'];
export async function startWeb(manager, options) {
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
      if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return send(401, { error: 'Authentication required' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return send(403, { error: 'Origin not allowed' });
      if (req.method === 'GET' && url.pathname === '/api/channels') { manager.warm(); return send(200, manager.status()); }
      if (req.method === 'GET' && url.pathname === '/api/host') return send(200, manager.hostInfo());
      if (req.method === 'GET' && url.pathname === '/api/schema') return send(200, schema());
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
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
      let text = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) { send(413, { error: 'Configuration too large' }); return; } text += chunk; }
      const body = JSON.parse(text);
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
    } catch (error) { send(error.code === 'STALE_CONFIG' ? 409 : 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  return server;
}
