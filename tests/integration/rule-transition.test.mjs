import { test } from 'node:test';
import assert from 'node:assert/strict';
// Switching a channel's rule system: every character keeps its story (name, basic information, background, items, bio,
// look), the old system's numbers and dice values go to a read-only archive on the card, the card gets the new system's
// blank numbers, the players are asked (in the main window and on the cards) to rebuild, and a card of the system the
// channel returns to can be brought back.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(d)), { status: r.status, body: d });
  return d;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };

test('rule transition: the story stays, the numbers are archived read-only and rebuilt, an archived card can come back', async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const gm = (await call('', 'POST', '/api/auth/register', { username: `rt_gm_${sfx}`, password: 'password', display_name: 'Keeper' })).token;
  const pl = await call('', 'POST', '/api/auth/register', { username: `rt_pl_${sfx}`, password: 'password', display_name: 'Sam' });
  const other = (await call('', 'POST', '/api/auth/register', { username: `rt_ot_${sfx}`, password: 'password', display_name: 'Ola' })).token;
  const srv = await call(gm, 'POST', '/api/servers', { name: `Rules ${sfx}` });
  const ch = (await call(gm, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Arkham to Waterdeep', rule_system: 'coc7e' })).id;
  await call(gm, 'POST', `/api/channels/${ch}/members`, { username: `rt_pl_${sfx}`, role: 'player' });
  await call(gm, 'POST', `/api/channels/${ch}/members`, { username: `rt_ot_${sfx}`, role: 'player' });
  const main = (await call(gm, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const path = (id) => `/api/channels/${ch}/characters/${id}`;

  // A full Call of Cthulhu investigator, a blank PC, and an NPC with numbers.
  const ada = await call(pl.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ada Marsh', speaking_style: 'Clipped, dry' });
  await call(pl.token, 'PUT', path(ada.id) + '/appearance', { asset_mode: 'generated', appearance_prompt: 'A wiry woman with ink-stained fingers' });
  const cocCard = {
    basic: { player: 'Sam', occupation: 'Journalist', age: '34', sex: 'F', residence: 'Arkham', birthplace: 'Boston' },
    characteristics: { STR: 50, CON: 60, SIZ: 55, DEX: 70, APP: 60, INT: 75, POW: 65, EDU: 80, LUK: 45 },
    derived: { hp: 11, hp_max: 11, mp: 13, mp_max: 13, san: 65, san_max: 99, mov: 8, build: 0, db: '0' },
    skills: { 'Spot Hidden': 65, 'Library Use': 70 },
    background: { personal_description: 'Sharp-eyed', ideology: 'The truth will out', significant_people: '', meaningful_locations: '', treasured_possessions: 'Her father\'s pen', traits: 'Stubborn', injuries: '', phobias: '', arcane: '', encounters: '' },
    items: [{ name: 'Notebook', note: 'dog-eared', qty: 1 }],
    wealth: { cash: '$40', assets: '', spending_level: '$10' },
  };
  await call(pl.token, 'PUT', path(ada.id) + '/card', { name: 'Ada Marsh', bio: 'A reporter who asks one question too many.', role_card: cocCard });
  await call(pl.token, 'PUT', path(ada.id) + '/attributes', { set: { Credit: 30 } });   // a value typed with .st, not on the card
  const blank = await call(other, 'POST', `/api/channels/${ch}/characters`, { name: 'Bo Blank' });
  const npc = await call(gm, 'POST', `/api/channels/${ch}/characters`, { name: 'Old Tom', kind: 'npc' });
  await call(gm, 'PUT', path(npc.id) + '/card', { role_card: { characteristics: { STR: 40 } } });
  const before = await call(pl.token, 'GET', path(ada.id) + '/space');
  assert.equal(before.attrs.STR, 50); assert.equal(before.attrs['Credit Rating'], 30); assert.equal(before.character.card_pending, false);
  assert.deepEqual(before.card_archives, []);

  // Only the GM switches; the same system again is not a transition.
  await rejects(call(pl.token, 'PUT', `/api/channels/${ch}`, { rule_system: 'dnd2024' }), 403);
  const same = await call(gm, 'PUT', `/api/channels/${ch}`, { rule_system: 'coc7e' });
  assert.equal(same.rule_transition, undefined);

  // Call of Cthulhu → D&D 2024.
  const switched = await call(gm, 'PUT', `/api/channels/${ch}`, { rule_system: 'dnd2024' });
  assert.equal(switched.rule_system, 'dnd2024');
  assert.equal(switched.rule_transition.from, 'coc7e'); assert.equal(switched.rule_transition.to, 'dnd2024');
  assert.equal(switched.rule_transition.archived, 2, 'Ada and the NPC had numbers; the blank PC had none');
  assert.equal(switched.rule_transition.pending, 2);
  assert.deepEqual(switched.rule_transition.rebuild.map((r) => r.name), ['Ada Marsh'], 'only PCs are named');
  assert.equal(switched.rule_transition.rows, undefined);

  // The story part is untouched; the numbers start blank for D&D; the dice values are cleared.
  const after = await call(pl.token, 'GET', path(ada.id) + '/space');
  const c = after.character;
  assert.equal(after.rule_system, 'dnd2024'); assert.equal(c.card_pending, true);
  assert.equal(c.name, 'Ada Marsh'); assert.equal(c.bio, 'A reporter who asks one question too many.'); assert.equal(c.speaking_style, 'Clipped, dry');
  assert.equal(c.appearance_prompt, 'A wiry woman with ink-stained fingers'); assert.equal(c.asset_mode, 'generated');
  assert.deepEqual(c.role_card.basic, cocCard.basic); assert.deepEqual(c.role_card.background, cocCard.background); assert.deepEqual(c.role_card.items, cocCard.items);
  assert.deepEqual(c.role_card.characteristics, {}); assert.deepEqual(c.role_card.skills, {}); assert.equal(c.role_card.wealth.cash, '');
  assert.equal(c.role_card.dnd.class, ''); assert.equal(c.role_card.dnd.level, 1);
  assert.deepEqual(after.attrs, {});
  // The Call of Cthulhu numbers and dice values, read-only in the archive.
  assert.equal(after.card_archives.length, 1);
  const arch = after.card_archives[0];
  assert.equal(arch.rule_system, 'coc7e'); assert.equal(arch.reason, 'rule_change'); assert.equal(arch.archived_by_name, 'Keeper');
  assert.deepEqual(arch.numbers.characteristics, cocCard.characteristics); assert.deepEqual(arch.numbers.skills, cocCard.skills);
  assert.equal(arch.numbers.derived.san, 65); assert.equal(arch.numbers.wealth.cash, '$40');
  assert.equal(arch.numbers.background, undefined, 'the story is not in the archive: it stayed on the card');
  assert.equal(arch.attrs.STR, 50); assert.equal(arch.attrs['Credit Rating'], 30);
  // A character without numbers is not asked to rebuild; the NPC is the GM's, invisible to players.
  assert.equal((await call(other, 'GET', path(blank.id) + '/space')).character.card_pending, false);
  const npcSpace = await call(gm, 'GET', path(npc.id) + '/space');
  assert.equal(npcSpace.character.card_pending, true); assert.equal(npcSpace.card_archives[0].numbers.characteristics.STR, 40);
  await rejects(call(pl.token, 'GET', path(npc.id) + '/space'), 404);
  // The listing carries the flag for the sidebar.
  assert.equal((await call(pl.token, 'GET', `/api/channels/${ch}/characters`)).find((x) => x.id === ada.id).card_pending, true);

  // The players are asked in the main window, which names PCs only.
  const msgs = await call(pl.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`);
  const notice = (Array.isArray(msgs) ? msgs : msgs.messages).filter((m) => m.kind === 'system').at(-1);
  assert.match(notice.content, /Call of Cthulhu 7e/); assert.match(notice.content, /D&D 2024/); assert.match(notice.content, /Ada Marsh/);
  assert.doesNotMatch(notice.content, /Old Tom/);

  // An archived card of another system cannot come back; nor can a stranger's; nor a made-up one.
  await rejects(call(pl.token, 'POST', path(ada.id) + `/card-archives/${arch.id}/restore`, {}), 409);
  await rejects(call(other, 'POST', path(ada.id) + `/card-archives/${arch.id}/restore`, {}), 403);
  await rejects(call(pl.token, 'POST', path(ada.id) + '/card-archives/00000000-0000-0000-0000-000000000000/restore', {}), 404);

  // A stale client sending the old numbers back cannot put them next to the new ones; a half-built card stays flagged.
  let saved = await call(pl.token, 'PUT', path(ada.id) + '/card', { role_card: { ...cocCard, dnd: { level: 2 } } });
  assert.deepEqual(saved.character.role_card.characteristics, {}); assert.deepEqual(saved.character.role_card.skills, {});
  assert.deepEqual(saved.character.role_card.background, cocCard.background); assert.equal(saved.character.card_pending, true);
  // A player cannot waive the rebuild; the class does it.
  saved = await call(pl.token, 'PUT', path(ada.id) + '/card', { role_card: saved.character.role_card, card_rebuilt: true });
  assert.equal(saved.character.card_pending, true);
  await rejects(call(pl.token, 'PUT', path(ada.id) + '/card', { role_card: saved.character.role_card, card_rebuilt: 'yes' }), 400);
  const dndCard = { ...saved.character.role_card, dnd: { class: 'Rogue', species: 'Human', background: 'Sage', level: 2, method: 'manual', base: { STR: 10, DEX: 16, CON: 12, INT: 15, WIS: 13, CHA: 10 }, hp_max: 15, ac: 14 } };
  saved = await call(pl.token, 'PUT', path(ada.id) + '/card', { role_card: dndCard });
  assert.equal(saved.character.card_pending, false); assert.equal(saved.character.role_card.dnd.class, 'Rogue');
  assert.equal(saved.attrs.DEX, 16, 'the D&D build is what the dice read now');
  // The GM waives the NPC's rebuild.
  const waived = await call(gm, 'PUT', path(npc.id) + '/card', { role_card: npcSpace.character.role_card, card_rebuilt: true });
  assert.equal(waived.character.card_pending, false);

  // Back to Call of Cthulhu: the D&D build is archived in turn, and the old investigator can come back.
  const back = await call(gm, 'PUT', `/api/channels/${ch}`, { rule_system: 'coc7e' });
  assert.equal(back.rule_transition.archived, 1, 'only Ada has D&D numbers'); assert.equal(back.rule_transition.pending, 1);
  let space = await call(pl.token, 'GET', path(ada.id) + '/space');
  assert.equal(space.character.card_pending, true); assert.equal(space.character.role_card.dnd, undefined);
  assert.deepEqual(space.card_archives.map((x) => x.rule_system), ['dnd2024', 'coc7e']);
  assert.equal(space.card_archives[0].numbers.dnd.class, 'Rogue'); assert.equal(space.card_archives[0].attrs.DEX, 16);
  // She starts a new investigator, then changes her mind: what she typed is set aside, the old card comes back.
  await call(pl.token, 'PUT', path(ada.id) + '/card', { role_card: { ...space.character.role_card, characteristics: { STR: 35 } } });
  const restored = await call(pl.token, 'POST', path(ada.id) + `/card-archives/${arch.id}/restore`, {});
  assert.equal(restored.character.card_pending, false);
  assert.deepEqual(restored.character.role_card.characteristics, cocCard.characteristics); assert.deepEqual(restored.character.role_card.skills, cocCard.skills);
  assert.deepEqual(restored.character.role_card.background, cocCard.background);
  assert.equal(restored.attrs.STR, 50); assert.equal(restored.attrs['Credit Rating'], 30, 'the dice values came back too');
  assert.deepEqual(restored.card_archives.map((x) => [x.rule_system, x.reason]), [['coc7e', 'restore'], ['dnd2024', 'rule_change']]);
  assert.equal(restored.card_archives[0].numbers.characteristics.STR, 35);
  assert.ok(!restored.card_archives.some((x) => x.id === arch.id), 'the archive entry was used up');
  await rejects(call(pl.token, 'POST', path(ada.id) + `/card-archives/${arch.id}/restore`, {}), 404);
  // The dice read the restored investigator.
  const roll = await call(pl.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.ra Spot Hidden', character_id: ada.id });
  assert.match(JSON.stringify(roll), /65/);
});
