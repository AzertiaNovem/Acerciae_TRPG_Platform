import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}
const exportJson = async (token, root, status = 200) => {
  const r = await fetch(base + root + '/log/export?format=json', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, status); return status === 200 ? r.json() : null;
};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('story end and Log Studio access: hidden or locked before the end, the whole story for everyone after it; Studio never shows what chat hides', async () => {
  const sfx = Date.now().toString(36);
  const [kp, p1, p2] = await Promise.all(['kp', 'p1', 'p2'].map(n => request(null, 'POST', '/api/auth/register', { username: `se_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(kp.token, 'POST', '/api/servers', { name: 'Story ' + sfx });
  // Shared knowledge mode: the old Studio treated every window line as public here.
  const ch = (await request(kp.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Innsmouth', knowledge_mode: 'public' })).id;
  const root = `/api/channels/${ch}/studio`;
  for (const p of [p1, p2]) await request(kp.token, 'POST', `/api/channels/${ch}/members`, { user_id: p.user.id, role: 'player' });
  const c1 = await request(p1.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ward' });
  const c2 = await request(p2.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Marsh' });
  const main = (await request(kp.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const side = (await request(kp.token, 'POST', `/api/channels/${ch}/windows`, { name: 'Keeper prep', kind: 'private', members: [] })).id;
  const post = (token, win, content, extra = {}) => request(token, 'POST', `/api/channels/${ch}/windows/${win}/messages`, { content, ...extra });

  // A scenario that is played, and one the Keeper only prepared.
  const played = await request(kp.token, 'POST', `/api/channels/${ch}/scenes`, { title: 'TITLE_The_Gilman_House', location: 'LOC_hotel' });
  await request(kp.token, 'POST', `/api/channels/${ch}/windows/${main}/scene`, { scene_id: played.id });
  await request(kp.token, 'POST', `/api/channels/${ch}/scenes`, { title: 'TITLE_Unplayed_Reef', location: 'LOC_reef' });
  await post(kp.token, main, 'The bus stops in a grey square.', { kind: 'narration' });
  await post(p1.token, main, 'Ward checks the hotel register.', { character_id: c1.id });
  await post(p2.token, main, '.rh 1d100', { character_id: c2.id });
  await post(kp.token, main, 'KP_ONLY_line', { kind: 'narration', visibility: 'gm_only' });
  await post(kp.token, side, 'SIDE_WINDOW_prep notes', { kind: 'narration' });

  // Before the end: players read only what chat lets them read, with masked scenario titles.
  const asP1 = JSON.stringify(await exportJson(p1.token, root));
  assert.ok(asP1.includes('Ward checks the hotel register.'));
  for (const hidden of ['KP_ONLY_line', 'SIDE_WINDOW_prep', 'TITLE_', 'LOC_']) assert.ok(!asP1.includes(hidden), 'player export leaks ' + hidden);
  assert.ok(!(await exportJson(p1.token, root)).messages.some(e => e.content.startsWith('.rh')), "another player's hidden roll stays theirs");
  assert.ok((await exportJson(p2.token, root)).messages.some(e => e.content.startsWith('.rh')));
  const plLog = await request(p1.token, 'GET', root + '/log');
  assert.ok(!plLog.windows.some(w => w.id === side), 'a window with nothing readable is not even named');
  assert.deepEqual(plLog.scenarios.map(s => s.title), ['Scenario 1']);
  assert.equal(plLog.story.status, 'ongoing');
  const snap = await request(kp.token, 'POST', root + `/projects/${plLog.project.id}/snapshots`, { scope: 'pl_public', title: 'For the table' });
  const snapAsP1 = JSON.stringify(await request(p1.token, 'GET', root + `/snapshots/${snap.id}`));
  for (const hidden of ['KP_ONLY_line', 'SIDE_WINDOW_prep', 'TITLE_', '.rh 1d100']) assert.ok(!snapAsP1.includes(hidden), 'players snapshot leaks ' + hidden);
  assert.ok(JSON.stringify(await exportJson(kp.token, root)).includes('TITLE_The_Gilman_House'));

  // The Keeper locks the Studio for players, then hides it altogether.
  await request(p1.token, 'PUT', `/api/channels/${ch}`, { studio_player_access: false }, 403);
  await request(kp.token, 'PUT', `/api/channels/${ch}`, { studio_player_access: false });
  assert.equal((await request(p1.token, 'GET', root + '/log', undefined, 403)).error, 'studio_locked');
  await request(kp.token, 'GET', root + '/log');
  await request(kp.token, 'PUT', `/api/channels/${ch}`, { studio_visible: false });
  assert.equal((await request(kp.token, 'GET', root + '/log', undefined, 403)).error, 'studio_hidden');

  // The end: every member reads the whole story (Keeper-only lines stay with the Keeper unless revealed).
  await request(p1.token, 'POST', `/api/channels/${ch}/story/end`, {}, 403);
  assert.equal((await request(kp.token, 'POST', `/api/channels/${ch}/story/end`, {})).story_status, 'ended');
  const ended = JSON.stringify(await exportJson(p1.token, root));
  for (const shown of ['SIDE_WINDOW_prep', '.rh 1d100', 'TITLE_The_Gilman_House']) assert.ok(ended.includes(shown), 'after the end players read ' + shown);
  assert.ok(!ended.includes('KP_ONLY_line'));
  assert.ok(!ended.includes('TITLE_Unplayed_Reef'), 'a scenario never played is not part of the story');
  assert.equal((await request(p2.token, 'GET', root + '/log')).story.status, 'ended');
  await request(kp.token, 'POST', `/api/channels/${ch}/story/end`, { reveal_keeper_lines: true });
  assert.ok(JSON.stringify(await exportJson(p2.token, root)).includes('KP_ONLY_line'));

  // Reopening restores the Keeper's rules.
  await request(kp.token, 'POST', `/api/channels/${ch}/story/reopen`);
  await request(p1.token, 'GET', root + '/log', undefined, 403);
  await request(kp.token, 'PUT', `/api/channels/${ch}`, { studio_visible: true, studio_player_access: true });
  assert.ok(!JSON.stringify(await exportJson(p1.token, root)).includes('SIDE_WINDOW_prep'));

  // An NPC's art never appears in a player's media library, and its appearance notes stay with the Keeper.
  const npc = await request(kp.token, 'POST', `/api/channels/${ch}/characters`, { name: 'NPC_Zadok', kind: 'npc' });
  const form = new FormData(); form.append('slot', 'portrait'); form.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'zadok.png');
  const up = await fetch(base + `/api/channels/${ch}/characters/${npc.id}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${kp.token}` }, body: form });
  assert.equal(up.status, 200);
  assert.ok((await request(kp.token, 'GET', `/api/channels/${ch}/media`)).some(m => m.character_id === npc.id));
  assert.ok(!JSON.stringify(await request(p1.token, 'GET', `/api/channels/${ch}/media`)).includes('NPC_Zadok'));
});
