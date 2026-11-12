import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP438AARwzEcQB+ohfxXaFgBQAAAABJRU5ErkJggg==';

test('dice persona: a text group names the dice, gives them an avatar and several templates to pick from', async () => {
  const sfx = Date.now().toString(36);
  const [gm, ann, eve] = await Promise.all(['gm', 'ann', 'eve'].map((n) => request(null, 'POST', '/api/auth/register', { username: `dicep_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'Dice persona ' + sfx });
  await request(gm.token, 'POST', `/api/servers/${server.id}/members`, { user_id: ann.user.id, role: 'member' });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Casino' })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: ann.user.id, role: 'player' });
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;

  // Without a group the dice are plain "Dice" with no avatar.
  const plain = await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.r 1d6', kind: 'ooc' });
  assert.deepEqual(plain.dice.bot, { name: 'Dice', avatar_version: 0 });

  // Templates: a list is accepted (empty entries dropped, one left becomes a string); bad shapes are refused.
  await request(gm.token, 'POST', `/api/servers/${server.id}/dice-texts`, { name: 'Bad', texts: { 'roll.result': [1, 2] } }, 400);
  await request(gm.token, 'POST', `/api/servers/${server.id}/dice-texts`, { name: 'Bad', texts: { 'roll.result': Array(21).fill('x') } }, 400);
  await request(gm.token, 'POST', `/api/servers/${server.id}/dice-texts`, { name: 'Bad', dice_name: 'two\nlines' }, 400);
  await request(gm.token, 'POST', `/api/servers/${server.id}/dice-texts`, { name: 'Bad', avatar_data: 'data:image/gif;base64,R0lGOD' }, 400);
  const variants = ['A: {result}', 'B: {result}', 'C: {result}'];
  const group = await request(gm.token, 'POST', `/api/servers/${server.id}/dice-texts`, {
    name: 'Croupier', dice_name: 'Madame Fortune', avatar_data: PNG,
    texts: { 'roll.result': [...variants, ''], 'level.hard': ['', 'HARD'] } });
  assert.equal(group.dice_name, 'Madame Fortune'); assert.equal(group.avatar_version, 1);
  assert.deepEqual(group.texts['roll.result'], variants); assert.equal(group.texts['level.hard'], 'HARD');
  assert.equal(group.avatar_data, undefined, 'the picture is served by its own URL, not in the list');
  await request(gm.token, 'PUT', `/api/channels/${ch}`, { dice_text_group: group.id });

  // Every roll records who spoke; the reply uses one of the templates, and over many rolls more than one.
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const m = await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.r 1d6', kind: 'ooc' });
    assert.deepEqual(m.dice.bot, { name: 'Madame Fortune', group_id: group.id, avatar_version: 1 });
    assert.match(m.dice.text, /^[ABC]: /); seen.add(m.dice.text[0]);
  }
  assert.ok(seen.size > 1, `templates vary (saw ${[...seen]})`);
  // A hidden roll's public notice comes from the same persona.
  const ada = await request(ann.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ada' });
  await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.rh 1d6', kind: 'ic', character_id: ada.id });
  const history = await request(gm.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`);
  const notice = history.find((m) => m.dice?.type === 'hidden_notice');
  assert.equal(notice.dice.bot.name, 'Madame Fortune');

  // The avatar: for members of the server only; a new picture bumps the version, removing it leaves rolls avatarless.
  const avatar = await fetch(`${base}/api/dice-avatars/${group.id}?v=1`, { headers: { Authorization: `Bearer ${ann.token}` } });
  assert.equal(avatar.status, 200); assert.equal(avatar.headers.get('content-type'), 'image/png');
  assert.equal((await avatar.arrayBuffer()).byteLength > 20, true);
  assert.equal((await fetch(`${base}/api/dice-avatars/${group.id}`, { headers: { Authorization: `Bearer ${eve.token}` } })).status, 404);
  await request(ann.token, 'PUT', `/api/servers/${server.id}/dice-texts/${group.id}`, { dice_name: 'Me' }, 403);
  assert.equal((await request(gm.token, 'PUT', `/api/servers/${server.id}/dice-texts/${group.id}`, { avatar_data: PNG })).avatar_version, 2);
  const renamed = await request(gm.token, 'PUT', `/api/servers/${server.id}/dice-texts/${group.id}`, { dice_name: '' , avatar_data: '' });
  assert.equal(renamed.texts['roll.result'].length, 3, 'texts are kept when only the persona changes');
  assert.equal((await fetch(`${base}/api/dice-avatars/${group.id}`, { headers: { Authorization: `Bearer ${ann.token}` } })).status, 404);
  const after = await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.r 1d6', kind: 'ooc' });
  assert.deepEqual(after.dice.bot, { name: 'Dice', group_id: group.id, avatar_version: 0 });
  // Removing the dice removes their avatar with them; channels fall back to the plain dice.
  assert.equal((await request(gm.token, 'PUT', `/api/servers/${server.id}/dice-texts/${group.id}`, { avatar_data: PNG })).avatar_version, 4);
  await request(gm.token, 'DELETE', `/api/servers/${server.id}/dice-texts/${group.id}`);
  assert.equal((await fetch(`${base}/api/dice-avatars/${group.id}?v=4`, { headers: { Authorization: `Bearer ${gm.token}` } })).status, 404);
  assert.deepEqual((await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.r 1d6', kind: 'ooc' })).dice.bot, { name: 'Dice', avatar_version: 0 });
});

test('dice display is a personal setting: separate by default, or under the command', async () => {
  const sfx = Date.now().toString(36);
  const u = await request(null, 'POST', '/api/auth/register', { username: `dicedisp_${sfx}`, display_name: 'D', password: 'password' });
  assert.equal(u.user.dice_display, 'separate');
  assert.equal((await request(u.token, 'PUT', '/api/auth/me', { dice_display: 'inline' })).dice_display, 'inline');
  assert.equal((await request(u.token, 'GET', '/api/auth/me')).dice_display, 'inline');
  await request(u.token, 'PUT', '/api/auth/me', { dice_display: 'loud' }, 400);
});
