import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}

test('investigator development: skills used successfully in a scenario are checked when it closes; a system tip shows the results', async () => {
  const sfx = Date.now().toString(36);
  const [gm, pl] = await Promise.all(['gm', 'pl'].map(n => request(null, 'POST', '/api/auth/register', { username: `grow_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'Growth ' + sfx });
  await request(gm.token, 'PUT', `/api/servers/${server.id}/settings`, { features: { coc7_points: true } });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Arkham' })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: pl.user.id, role: 'player' });
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const ada = await request(pl.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ada' });
  const npc = await request(gm.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Innkeeper', kind: 'npc' });
  // Point-buy card: Spot Hidden 25+40 = 65, Listen 20+10 = 30; Credit Rating 50 and Cthulhu Mythos 5 set as plain skills.
  await request(pl.token, 'PUT', `/api/channels/${ch}/characters/${ada.id}/card`, { role_card: { characteristics: { STR: 50, CON: 50, SIZ: 50, DEX: 60, APP: 50, INT: 70, POW: 50, EDU: 70, LUK: 50 }, skill_points: { 'Spot Hidden': { hobby: 40 }, Listen: { hobby: 10 } }, skills: { 'Credit Rating': 50, 'Cthulhu Mythos': 5 } } });
  await request(pl.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.st 理智 60', kind: 'ic', character_id: ada.id });
  const roll = (token, charId, content) => request(token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content, kind: 'ic', character_id: charId });
  const succeeded = new Set(), failed = new Set();
  // Roll until Spot Hidden (65) and Credit Rating (50) each succeeded at least once; Cthulhu Mythos and STR are rolled alongside.
  for (let i = 0; i < 40 && !(succeeded.has('Spot Hidden') && succeeded.has('Credit Rating')); i++) {
    for (const [skill, cmd] of [['Spot Hidden', '.ra 侦查'], ['Credit Rating', '.ra credit rating'], ['Cthulhu Mythos', '.ra cthulhu mythos'], ['STR', '.ra str']]) {
      const d = (await roll(pl.token, ada.id, cmd)).dice;
      (d.rolls[0].success ? succeeded : failed).add(skill);
    }
  }
  assert.ok(succeeded.has('Spot Hidden') && succeeded.has('Credit Rating'));
  await roll(gm.token, npc.id, '.ra listen 99');   // an NPC never develops; Ada never rolled Listen, so it is not marked
  const before = (await request(pl.token, 'GET', `/api/channels/${ch}/characters/${ada.id}/attributes`)).attrs;
  assert.equal(before['Spot Hidden'], 65);

  const moved = await request(gm.token, 'POST', `/api/channels/${ch}/scenarios/advance`, { title: 'The pier' });
  assert.ok(moved.previous);
  const messages = await request(pl.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`);
  const tip = messages.find(m => m.kind === 'system');
  assert.ok(tip, 'a system tip is posted in the Main Chat');
  assert.match(tip.content, /Investigator development/); assert.match(tip.content, /Spot Hidden growth check: D100=\d+\/65/);
  assert.ok(!/Credit Rating/.test(tip.content) && !/Cthulhu Mythos/.test(tip.content) && !/STR/.test(tip.content) && !/Listen/.test(tip.content) && !/Innkeeper/.test(tip.content), tip.content);
  assert.equal(tip.scene_id, moved.scene.id, 'the tip opens the new scenario, not the closed one');
  const after = (await request(pl.token, 'GET', `/api/channels/${ch}/characters/${ada.id}/attributes`)).attrs;
  const gained = after['Spot Hidden'] - 65;
  if (/improved by (\d+)/.test(tip.content)) {
    const g = Number(tip.content.match(/improved by (\d+)/)[1]);
    assert.equal(gained, g); assert.ok(g >= 1 && g <= 10);
    const card = (await request(pl.token, 'GET', `/api/channels/${ch}/characters/${ada.id}/space`)).character.role_card;
    assert.equal(card.skill_points['Spot Hidden'].growth, g); assert.equal(card.skills['Spot Hidden'], 65 + g);
    // A later save keeps the growth: the player cannot lose or change it.
    const saved = await request(pl.token, 'PUT', `/api/channels/${ch}/characters/${ada.id}/card`, { role_card: { ...card, skill_points: { ...card.skill_points, 'Spot Hidden': { hobby: 40, growth: 0 } } } });
    assert.equal(saved.character.role_card.skills['Spot Hidden'], 65 + g);
  } else { assert.match(tip.content, /no improvement/); assert.equal(gained, 0); }
  for (const k of ['Credit Rating', 'Cthulhu Mythos', 'STR', 'Listen']) assert.equal(after[k], before[k], k);
  // Nothing was rolled in the new scenario: closing it posts no tip.
  await request(gm.token, 'POST', `/api/channels/${ch}/scenarios/advance`, { title: 'The warehouse' });
  assert.equal((await request(pl.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`)).filter(m => m.kind === 'system').length, 1);
});
