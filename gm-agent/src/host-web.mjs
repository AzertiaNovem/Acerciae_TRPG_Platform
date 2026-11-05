import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseChannel } from './host-config.mjs';
const asset = name => fs.readFileSync(new URL(`../web/${name}`, import.meta.url));
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
export async function startWeb(manager, options) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': type }); res.end(asset(name)); return;
      }
      const supplied = digest(req.headers.authorization ?? ''), expected = digest(`Bearer ${options.token}`);
      if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return send(401, { error: 'Authentication required' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return send(403, { error: 'Origin not allowed' });
      if (req.method === 'GET' && url.pathname === '/api/channels') return send(200, manager.status());
      const match = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]{1,128})\/(config|action)$/);
      if (!match) return send(404, { error: 'Not found' });
      const [, id, operation] = match;
      let entry;
      try { entry = manager.entry(id); } catch { return send(404, { error: 'Unknown channel' }); }
      if (req.method === 'GET' && operation === 'config') {
        const yaml = fs.readFileSync(entry.config, 'utf8'); parseChannel(yaml);
        return send(200, { yaml, revision: digest(yaml) });
      }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
      let text = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) { send(413, { error: 'Configuration too large' }); return; } text += chunk; }
      const body = JSON.parse(text);
      if (operation === 'config') {
        if (typeof body.revision !== 'string') throw Error('Configuration revision required');
        if (typeof body.yaml !== 'string') throw Error('yaml must be text');
        // Compare inside the same queue as writes, so two editors cannot overwrite each other.
        await manager.save(id, body.yaml, body.revision);
      } else await manager.action(id, body.action);
      send(200, { ok: true });
    } catch (error) { send(error.code === 'STALE_CONFIG' ? 409 : 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  return server;
}
