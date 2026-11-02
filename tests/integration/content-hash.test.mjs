import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// Content hashes: the SHA-256 of every stored picture travels with every reference to it (media rows, the character
// space, chat messages, the profile), so clients cache by content and refetch only when the hash changes.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(d)), { status: r.status, body: d });
  return d;
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwnwEKGBkYGAA1AwIBqk4TOwAAAABJRU5ErkJggg==', 'base64');
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('content hashes: on uploads and their versions, user avatars, chat messages and the character space', async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const gm = await call('', 'POST', '/api/auth/register', { username: `hs_${sfx}`, password: 'password', display_name: 'Hasher' });
  const srv = await call(gm.token, 'POST', '/api/servers', { name: `Hash ${sfx}` });
  const ch = (await call(gm.token, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Vault' })).id;

  // Uploaded media: the hash is the SHA-256 of the bytes; a new version has its own; the same bytes give the same hash.
  const upload = async (bytes, name) => { const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), name); const r = await fetch(base + `/api/channels/${ch}/media`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: form }); assert.equal(r.status, 200); return r.json(); };
  const a = await upload(png, 'one.png');
  assert.equal(a.content_hash, sha(png));
  const again = await upload(png, 'same-bytes.png');
  assert.equal(again.content_hash, a.content_hash, 'identical bytes hash alike, whatever the asset');
  const listed = (await call(gm.token, 'GET', `/api/channels/${ch}/media`)).find((m) => m.id === a.id);
  assert.equal(listed.content_hash, sha(png));
  const vform = new FormData(); vform.append('file', new Blob([png2], { type: 'image/png' }), 'two.png');
  const v2 = await (await fetch(base + `/api/channels/${ch}/media/${a.id}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: vform })).json();
  assert.equal(v2.version, 2); assert.equal(v2.content_hash, sha(png2));

  // The signed-in user's avatar: the profile carries its hash; so do the messages they post.
  const me0 = await call(gm.token, 'GET', '/api/auth/me');
  assert.equal(me0.avatar_hash ?? null, null);
  await call(gm.token, 'PUT', '/api/auth/me', { avatar_data: 'data:image/png;base64,' + png2.toString('base64') });
  const me = await call(gm.token, 'GET', '/api/auth/me');
  assert.match(me.avatar_hash, /^[0-9a-f]{64}$/);
  const main = (await call(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const posted = await call(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'Hello', kind: 'ooc' });
  assert.equal(posted.author_avatar_hash, me.avatar_hash);
  const page = await call(gm.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`);
  assert.equal(page.find((m) => m.id === posted.id).author_avatar_hash, me.avatar_hash);
  // Removing the avatar clears the hash.
  await call(gm.token, 'PUT', '/api/auth/me', { avatar_data: '' });
  assert.equal((await call(gm.token, 'GET', '/api/auth/me')).avatar_hash ?? null, null);

  // A character's portrait in the character space, and its avatar in the channel's character list.
  const hero = await call(gm.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Lia' });
  const pform = new FormData(); pform.append('slot', 'portrait'); pform.append('file', new Blob([png], { type: 'image/png' }), 'portrait.png');
  const up = await fetch(base + `/api/channels/${ch}/characters/${hero.id}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: pform });
  assert.equal(up.status, 200, await up.text());
  const space = await call(gm.token, 'GET', `/api/channels/${ch}/characters/${hero.id}/space`);
  assert.equal(space.portrait.hash, sha(png));
  const aform = new FormData(); aform.append('slot', 'avatar'); aform.append('file', new Blob([png2], { type: 'image/png' }), 'avatar.png');
  const upA = await fetch(base + `/api/channels/${ch}/characters/${hero.id}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: aform });
  assert.equal(upA.status, 200, await upA.text());
  const chars = await call(gm.token, 'GET', `/api/channels/${ch}/characters`);
  const row = chars.find((c) => c.id === hero.id);
  assert.equal(row.avatar_asset_hash, sha(png2)); assert.equal(row.avatar_asset_version, 1);
  const withChar = await call(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'In character', kind: 'ic', character_id: hero.id });
  assert.equal(withChar.character_avatar_hash, sha(png2));
});
