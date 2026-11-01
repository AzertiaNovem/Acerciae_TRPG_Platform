import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// D&D 2024 (SRD 5.2) as a channel's rule system: the GM's switch and point buy, the D&D card, D20 Tests, the Initiative
// order, and module import with creature stat blocks under prompts that name the game and the Dungeon Master.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(d)), { status: r.status, body: d });
  return d;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
async function until(fn) { for (let n = 0; n < 150; n++) { const r = await fn(); if (r) return r; await new Promise((r) => setTimeout(r, 100)); } throw Error('timed out'); }

test('D&D 2024 channel: GM options, the D&D card with point buy, D20 Tests, Initiative, stat blocks, D&D prompts', async (t) => {
  const requests = [];
  const fixture = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); requests.push(body);
    const sys = String(body.instructions ?? '');
    const content = sys.includes('knowledge graph')
      ? { nodes: [{ key: 'creature|goblin', node_type: 'creature', name: 'Goblin Warrior', description: 'A small, cunning raider.', citations: [{ page: 1, excerpt: 'Goblin Warrior' }],
          stat_block: { ac: 15, hp: 10, hp_formula: '3d6', speed: '30 ft.', cr: '1/4', abilities: { STR: 8, DEX: 15, CON: 10, INT: 10, WIS: 8, CHA: 8 },
            actions: [{ name: 'Scimitar', text: 'Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage.' }], bogus: 'dropped' } }], edges: [] }
      : { entries: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(content) }] }], usage: { input_tokens: 20, output_tokens: 30 } }));
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });

  const suffix = Math.random().toString(36).slice(2);
  const gm = (await call('', 'POST', '/api/auth/register', { username: 'dm' + suffix, password: 'password', display_name: 'DM' })).token;
  const pl = (await call('', 'POST', '/api/auth/register', { username: 'pl' + suffix, password: 'password', display_name: 'Pat' })).token;
  const srv = await call(gm, 'POST', '/api/servers', { name: 'Sword Coast' });
  const ch = (await call(gm, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Phandelver' })).id;
  await call(gm, 'POST', `/api/channels/${ch}/members`, { username: 'pl' + suffix, role: 'player' });
  const main = (await call(gm, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const say = (token, content, extra = {}) => call(token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content, ...extra });

  // The rule system and point buy are the channel GM's options (not the server's).
  assert.equal((await call(gm, 'GET', `/api/channels/${ch}`)).rule_system, 'coc7e');
  await rejects(call(pl, 'PUT', `/api/channels/${ch}`, { rule_system: 'dnd2024' }), 403);
  await rejects(call(gm, 'PUT', `/api/channels/${ch}`, { rule_system: 'dnd5e' }), 400);
  const switched = await call(gm, 'PUT', `/api/channels/${ch}`, { rule_system: 'dnd2024', point_buy: true });
  assert.equal(switched.rule_system, 'dnd2024'); assert.equal(switched.point_buy, true);
  assert.equal((await call(gm, 'GET', `/api/servers/${srv.id}/settings`)).features.coc7_points, undefined);

  // The SRD 5.2 rules the sheet builds from.
  const rules = await call(pl, 'GET', '/api/dnd/rules');
  assert.equal(rules.classes.length, 12); assert.equal(rules.point_buy.budget, 27); assert.match(rules.source, /5\.2/);

  // A card by point buy: scores 8-15 for 27 points, the background's +2/+1, skills from class, background and species.
  const hero = await call(pl, 'POST', `/api/channels/${ch}/characters`, { name: 'Lia Quickfoot' });
  const card = { dnd: { class: 'Rogue', species: 'Elf', background: 'Criminal', level: 3, method: 'point_buy',
    base: { STR: 8, DEX: 15, CON: 14, INT: 12, WIS: 12, CHA: 10 }, increases: { DEX: 2, INT: 1 }, improvements: { STR: 4 }, saves: ['DEX', 'INT'],
    skills: { Stealth: 2, 'Sleight of Hand': 1, Acrobatics: 1, Deception: 1, Investigation: 1, Perception: 1, Insight: 1 }, ac: 14, hp_max: 21, slots: {} } };
  const saveCard = (role_card) => call(pl, 'PUT', `/api/channels/${ch}/characters/${hero.id}/card`, { role_card });
  const over = await rejects(saveCard({ dnd: { ...card.dnd, base: { ...card.dnd.base, STR: 15 } } }), 400);
  assert.match(over.body.message ?? JSON.stringify(over.body), /27/);
  const space = await saveCard(card);
  assert.equal(space.rule_system, 'dnd2024'); assert.equal(space.points.enabled, true); assert.deepEqual(space.points.violations, []);
  assert.equal(space.character.role_card.dnd.improvements.STR, undefined, 'later improvements are the GM\'s to grant under point buy');
  assert.equal(space.attrs.DEX, 17); assert.equal(space.attrs.Stealth, 2); assert.equal(space.attrs['DEX Save'], 1); assert.equal(space.attrs.HP, 21);

  // D20 Tests read the sheet: Stealth with expertise is DEX +3 and twice the proficiency bonus of 2.
  const check = await say(pl, '.rc stealth dc 5', { character_id: hero.id });
  assert.equal(check.dice.type, 'd20'); assert.equal(check.dice.total, check.dice.roll + 7); assert.equal(check.dice.success, true);
  assert.match(check.dice.text, /Stealth \(DEX\) check/);
  const coc = await rejects(say(pl, '.sc 1/1d6', { character_id: hero.id }), 400);
  assert.match(JSON.stringify(coc.body), /Call of Cthulhu rules/);
  // Death Saving Throws and spell slots change the live values.
  await say(pl, '.st hp-21', { character_id: hero.id });
  const ds = await say(pl, '.ds', { character_id: hero.id });
  assert.equal(ds.dice.type, 'death_save');

  // Initiative: players join with .ri, the DM adds monsters and runs the turn; the order is per window.
  const mine = await say(pl, '.ri', { character_id: hero.id });
  assert.equal(mine.dice.type, 'initiative');
  await say(gm, '.ri +2 Goblin');
  let order = await call(pl, 'GET', `/api/channels/${ch}/windows/${main}/initiative`);
  assert.deepEqual(order.entries.map((e) => e.name).sort(), ['Goblin', 'Lia Quickfoot']);
  assert.ok(order.entries[0].total >= order.entries[1].total, 'highest first');
  await rejects(call(pl, 'POST', `/api/channels/${ch}/windows/${main}/initiative`, { action: 'next' }), 403);
  await rejects(say(pl, '.init next', { character_id: hero.id }), 400);
  order = await call(gm, 'POST', `/api/channels/${ch}/windows/${main}/initiative`, { action: 'next' });
  assert.equal(order.round, 1); assert.equal(order.turn, order.entries[0].id);
  const listed = await say(pl, '.init', { character_id: hero.id });
  assert.match(listed.dice.text, /▶ /); assert.match(listed.dice.text, /Goblin/);
  const turn = await say(gm, '.init next');
  assert.match(turn.dice.text, /Round 1: .*'s turn/);
  // A player removes their own entry; clearing is the DM's.
  const own = order.entries.find((e) => e.name === 'Lia Quickfoot');
  order = await call(pl, 'POST', `/api/channels/${ch}/windows/${main}/initiative`, { action: 'remove', entry_id: own.id });
  assert.deepEqual(order.entries.map((e) => e.name), ['Goblin']);
  await say(gm, '.init clr');
  assert.deepEqual((await call(pl, 'GET', `/api/channels/${ch}/windows/${main}/initiative`)).entries, []);

  // Module import in a D&D channel: the prompt names D&D and asks for stat blocks, which are kept with the creature.
  await call(gm, 'PUT', `/api/servers/${srv.id}/settings`, { llm: { provider: 'openai_compatible', api_base: `http://127.0.0.1:${fixture.address().port}/v1`, api_key: 'fixture', model: 'fixture' } });
  const mod = await call(gm, 'POST', `/api/channels/${ch}/modules/text`, { title: 'Goblin Arrows', text: 'Goblin Warrior\nArmor Class 15. Hit Points 10 (3d6). Speed 30 ft.', async: true });
  const ready = await until(async () => { const m = await call(gm, 'GET', `/api/channels/${ch}/modules/${mod.id}`); assert.notEqual(m.status, 'failed', m.error); return m.status === 'ready' && m; });
  const goblin = ready.nodes.find((n) => n.node_type === 'creature');
  assert.ok(goblin, 'a creature node');
  assert.equal(goblin.data.stat_block.ac, 15); assert.equal(goblin.data.stat_block.cr, '1/4'); assert.equal(goblin.data.stat_block.abilities.DEX, 15);
  assert.equal(goblin.data.stat_block.actions[0].name, 'Scimitar'); assert.equal(goblin.data.stat_block.bogus, undefined);
  const structuring = requests.find((b) => String(b.instructions).includes('knowledge graph'));
  assert.match(structuring.instructions, /D&D 2024/); assert.match(structuring.instructions, /stat_block/);
  assert.doesNotMatch(structuring.instructions, /Call of Cthulhu|Keeper/);

  // Back to Call of Cthulhu: the D&D commands are refused, the CoC ones work again.
  await call(gm, 'PUT', `/api/channels/${ch}`, { rule_system: 'coc7e' });
  const back = await rejects(say(gm, '.ri'), 400);
  assert.match(JSON.stringify(back.body), /D&D rules/);
  await say(gm, '.r 1d100');
});
