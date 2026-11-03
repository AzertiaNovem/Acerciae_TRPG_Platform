import { test } from 'node:test';
import assert from 'node:assert/strict';
// Who gets a picture's bytes, and what their browser may keep: players get every approved channel-scoped asset, an
// NPC's art included (shown in chat and in visual novels), but only non-NPC art is marked immutable for them.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(d)), { status: r.status, body: d });
  return d;
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('media bytes: players get NPC art (never marked for keeping), GM-only assets stay with the Keeper, every response varies by Origin', async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const gm = await call('', 'POST', '/api/auth/register', { username: `ma_gm_${sfx}`, password: 'password', display_name: 'Keeper' });
  const pl = await call('', 'POST', '/api/auth/register', { username: `ma_pl_${sfx}`, password: 'password', display_name: 'Player' });
  const srv = await call(gm.token, 'POST', '/api/servers', { name: `Access ${sfx}` });
  const ch = (await call(gm.token, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Vault' })).id;
  await call(gm.token, 'POST', `/api/channels/${ch}/members`, { username: `ma_pl_${sfx}`, role: 'player' });
  const npc = await call(gm.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Old Tom', kind: 'npc' });
  const pc = await call(gm.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ada', kind: 'pc', user_id: pl.user.id });
  const upload = async (fields) => { const form = new FormData(); for (const [k, v] of Object.entries(fields)) form.append(k, v); form.append('file', new Blob([png], { type: 'image/png' }), 'a.png'); const r = await fetch(base + `/api/channels/${ch}/media`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: form }); if (r.status !== 200) assert.fail(`upload: ${r.status} ${await r.text()}`); return r.json(); };
  const npcArt = await upload({ asset_type: 'portrait', character_id: npc.id });
  const pcArt = await upload({ asset_type: 'portrait', character_id: pc.id });
  const secret = await upload({ asset_type: 'illustration', gm_only: 'true' });
  const plToken = (await call(pl.token, 'POST', '/api/auth/file-token', {})).token;
  const gmToken = (await call(gm.token, 'POST', '/api/auth/file-token', {})).token;
  const get = (id, token, v = 1, headers = {}) => fetch(base + `/api/channels/${ch}/media/${id}?v=${v}&token=${token}`, { headers, redirect: 'manual' });

  // A player: the PC's portrait is kept for good, the NPC's is served but never marked, the GM-only picture is not theirs.
  let r = await get(pcArt.id, plToken);
  assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /immutable/);
  r = await get(npcArt.id, plToken);
  assert.equal(r.status, 200, 'an NPC\'s art shows to players'); assert.doesNotMatch(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('vary'), 'Origin');
  r = await get(secret.id, plToken);
  assert.equal(r.status, 404);
  // The Keeper gets everything, their own material without the keep mark.
  for (const id of [pcArt.id, npcArt.id, secret.id]) { r = await get(id, gmToken); assert.equal(r.status, 200); }
  assert.doesNotMatch((await get(secret.id, gmToken)).headers.get('cache-control'), /immutable/);
  // Without a version the current picture revalidates; with a wrong one there is nothing to serve.
  r = await get(pcArt.id, plToken, 0); assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /no-cache/);
  assert.equal((await get(pcArt.id, plToken, 7)).status, 404);
  // Vary: Origin on a response made for an <img> (no Origin header) as on one for a fetch(), so a browser keeps them apart.
  assert.equal((await fetch(base + '/api/health')).headers.get('vary'), 'Origin');
  assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'https://nobody.example' } })).headers.get('vary'), 'Origin');
});
