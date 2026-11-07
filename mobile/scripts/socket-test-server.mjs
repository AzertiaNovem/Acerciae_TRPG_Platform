// Isolated loopback peer for the native URLSession WebSocket integration test; no production credentials or writes.
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../../tests/integration/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const fixture = JSON.parse(fs.readFileSync(new URL('../contracts/fixtures/realtime-events.json', import.meta.url)));
let tokens = 0, connections = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/reset' && req.method === 'POST') {
    for (const ws of sockets.clients) ws.terminate();
    tokens = 0; connections = 0; res.end('{}');
  } else if (req.url === '/api/auth/file-token' && req.method === 'POST' && req.headers.authorization === 'Bearer socket-test-session') {
    res.end(JSON.stringify({token:'fixture-file-'+(++tokens), expires_at:Math.floor(Date.now()/1000)+3600}));
  } else if (req.url === '/checks') res.end(JSON.stringify({tokens,connections}));
  else { res.statusCode = 403; res.end('{"error":"forbidden"}'); }
});
const sockets = new WebSocketServer({noServer:true});
server.on('upgrade', (req, socket, head) => {
  if (!/^\/ws\/chat\?token=fixture-file-\d+$/.test(req.url)) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
});
sockets.on('connection', ws => {
  const connection = ++connections;
  ws.send('{"type":"hello","stream":"chat"}');
  ws.on('message', bytes => {
    const {type,channel_id} = JSON.parse(bytes);
    if (type !== 'subscribe') return;
    ws.send(JSON.stringify({type:'subscribed',channel_id}));
    const event = structuredClone(fixture.events[connection === 2 ? 3 : 2]);
    event.channel_id = channel_id;
    ws.send(JSON.stringify(event));
    if (connection === 1) setTimeout(() => ws.close(1001, 'test reconnect'), 100);
  });
});
server.listen(Number(process.env.SOCKET_TEST_PORT || 18090), '127.0.0.1', () => console.log('Native socket test peer ready'));
