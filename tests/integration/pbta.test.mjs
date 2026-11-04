import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.API_BASE ?? 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(Error(JSON.stringify(data)), { status: response.status });
  return data;
}
test('PbtA playbooks, private GM moves, auditable outcomes and portable packs', async (t) => {
  const tag = Date.now().toString(36);
  const signup = async (name) =>
    (
      await call('', 'POST', '/auth/register', {
        username: name + tag,
        display_name: name,
        password: 'password',
      })
    ).token;
  const gm = await signup('MC'),
    pl = await signup('Scout');
  const server = await call(gm, 'POST', '/servers', { name: 'Frontier' });
  const channel = async (name) =>
    '/channels/' +
    (
      await call(gm, 'POST', '/servers/' + server.id + '/channels', {
        name,
        rule_system: 'pbta',
        point_buy: true,
      })
    ).id;
  const a = await channel('Border'),
    b = await channel('Other table');
  await call(gm, 'POST', a + '/members', { username: 'Scout' + tag, role: 'player' });
  const win = (await call(gm, 'GET', a + '/windows'))[0].id;
  const hero = await call(pl, 'POST', a + '/characters', { name: 'Morgan' });
  const pc = a + '/characters/' + hero.id;
  const say = (command, actor = pl, id = hero.id) =>
    call(actor, 'POST', a + '/windows/' + win + '/messages', { content: command, character_id: id });
  const rules = await call(gm, 'GET', a + '/pbta'),
    pack = rules.pack;
  assert.equal(pack.moves.filter((m) => !m.book).length, 4);
  assert.equal(pack.books.length, 2);
  assert.equal(pack.stats.length, 3);
  assert.ok(pack.gmMoves.length);
  assert.equal((await call(pl, 'GET', a + '/pbta')).pack.gmMoves, undefined);
  await assert.rejects(call(pl, 'PUT', a + '/pbta', rules), { status: 403 });
  const sheet = { book: 'scout', stats: { sense: 2 }, resources: { xp: 1 }, conditions: { exposed: true } };
  const saved = await call(pl, 'PUT', pc + '/card', { pack_revision: 1, role_card: { pbta: sheet } });
  assert.equal(saved.points.enabled, false);
  assert.equal(saved.pbta_rules.pack.gmMoves, undefined);
  assert.equal(saved.character.role_card.pbta.resources.xp, 1);
  await assert.rejects(call(pl, 'PUT', pc + '/card', { role_card: { skills: { Test: 59 } } }), {
    status: 409,
  });
  const npc = await call(gm, 'POST', a + '/characters', { name: 'Guide', kind: 'npc' });
  await assert.rejects(say('.move search', pl, npc.id), { status: 403 });
  const privateWindow = await call(gm, 'POST', a + '/windows', { name: 'GM only', kind: 'private' });
  await assert.rejects(call(pl, 'POST', a + '/windows/' + privateWindow.id + '/messages', {
    content: '.move search', character_id: hero.id,
  }), { status: 403 });
  await assert.rejects(say('.move copy'), { status: 400 });
  for (const cmd of ['.ra search', '.st hp99', '.init', '.ss 1', '.move pressure', '.move search +100'])
    await assert.rejects(say(cmd), { status: 400 });
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const request = JSON.parse(data);
    requests.push(request);
    const output = request.instructions.includes('DRAFT message')
      ? { insufficient_evidence: true, rationale: 'fixture', conflicts: [] }
      : { draft: 'I will search the site.', used_fact_ids: [], notes: '' };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(output) }],
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    provider.closeAllConnections();
    provider.close();
  });
  await call(gm, 'PUT', '/servers/' + server.id + '/settings', {
    llm: {
      provider: 'openai_compatible',
      api_base: 'http://127.0.0.1:' + provider.address().port + '/v1',
      api_key: 'fixture',
      model: 'fixture',
    },
  });
  for (const task of ['inspiration', 'consistency']) {
    await call(pl, 'POST', a + '/' + task, {
      chat_window_id: win,
      character_id: hero.id,
      draft: 'I examine the tracks.',
    });
    const prompt = JSON.stringify(
      requests.findLast((r) =>
        r.instructions?.includes(task === 'inspiration' ? 'ONE possible' : 'DRAFT message'),
      ),
    );
    assert.ok(prompt.includes(pack.moves[0].trigger));
    assert.ok(!prompt.includes(pack.gmMoves[0].text));
    assert.ok(!prompt.includes(pack.moves.find((m) => m.book === 'scribe').trigger));
  }
  const rolled = await say('.move search -2');
  assert.equal(
    rolled.dice.total,
    rolled.dice.rolls.reduce((x, y) => x + y, 0),
  );
  assert.equal(rolled.dice.modifier, -2);
  assert.equal(rolled.dice.text.includes(rolled.dice.outcome), true);
  assert.equal(rolled.dice.revision, 1);
  const plus = await say('.move search +3');
  assert.equal(
    plus.dice.total,
    plus.dice.rolls.reduce((x, y) => x + y, 5),
  );
  assert.equal((await say('.move trail')).dice.rolls, undefined);
  // A new band needs an outcome for every rolled move.
  const next = structuredClone(pack);
  next.bands.at(-1).max = 11;
  next.bands.push({ id: 'exceptional', name: '特别收获', min: 12, max: null });
  for (const m of next.moves) if (m.stat) m.outcomes.exceptional = '再问一个问题。';
  next.moves[0].name = '循迹';
  const validate = (p) => call(gm, 'POST', a + '/pbta/preview', p);
  for (const mutate of [
    (p) => p.stats.push(p.stats[0]),
    (p) => (p.moves[0].stat = 'absent'),
    (p) => (p.bands[1].min = 8),
    (p) => (p.bands[1].min = 6),
  ]) {
    const invalid = structuredClone(next);
    mutate(invalid);
    await assert.rejects(validate(invalid), { status: 400 });
  }
  const removed = structuredClone(next);
  removed.conditions = [];
  await assert.rejects(call(gm, 'PUT', a + '/pbta', { revision: 1, pack: removed }), /Morgan/);
  assert.deepEqual(await validate(next), next);
  const race = await Promise.allSettled(
    [1, 2].map(() => call(gm, 'PUT', a + '/pbta', { revision: 1, pack: next })),
  );
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(race.find((r) => r.status === 'rejected').reason.status, 409);
  const exported = (await call(gm, 'GET', a + '/pbta')).pack;
  assert.deepEqual((await call(gm, 'PUT', b + '/pbta', { revision: 1, pack: exported })).pack, next);
  const secondHero = await call(gm, 'POST', b + '/characters', { name: 'Courier', kind: 'npc' });
  await call(gm, 'PUT', b + '/characters/' + secondHero.id + '/card', {
    pack_revision: 2,
    role_card: { pbta: { book: 'scribe' } },
  });
  const secondWindow = (await call(gm, 'GET', b + '/windows'))[0];
  const other = await call(gm, 'POST', b + '/windows/' + secondWindow.id + '/messages', {
    character_id: secondHero.id,
    content: '.move search +20',
  });
  assert.equal(other.dice.name, '循迹');
  assert.equal(other.dice.outcome, '再问一个问题。');
  assert.equal((await say('.move search +20')).dice.band.id, 'exceptional');
  assert.deepEqual((await call(pl, 'GET', a + '/messages/' + rolled.id)).dice, rolled.dice);
  const reference = await call(pl, 'POST', a + '/windows/' + win + '/messages', {
    content: 'I follow the earlier ruling.', reference_ids: [rolled.id],
  });
  const cited = await call(pl, 'GET', a + '/messages/' + reference.reference_ids[0]);
  assert.equal(cited.dice.text, rolled.dice.text);
  const studio = a + '/studio';
  const project = await call(gm, 'POST', studio + '/projects', { title: 'Frontier log' });
  await call(gm, 'POST', studio + '/projects/' + project.id + '/sync', {});
  const snapshot = await call(gm, 'POST', studio + '/projects/' + project.id + '/snapshots', {
    scope: 'gm_full',
  });
  const events = (await call(gm, 'GET', studio + '/snapshots/' + snapshot.id)).events;
  const old = events.find((e) => e.source_message_id === rolled.id);
  assert.deepEqual(old.metadata.dice_result, rolled.dice);
  assert.deepEqual(old.dice.rolls, rolled.dice.rolls);
  assert.equal(old.content, rolled.dice.text);
  for (const system of ['dnd2024', 'coc7e']) {
    await call(gm, 'PUT', a, { rule_system: system, point_buy: false });
    await assert.rejects(say('.move search'), { status: 400 });
    await call(pl, 'PUT', pc + '/card', {
      role_card: system === 'dnd2024' ? { dnd: { level: 2 } } : { characteristics: { STR: 55 } },
    });
  }
  // Back to PbtA: the card is new for PbtA (the story stays); the playbook and the D&D build wait read-only among the
  // former cards, and the playbook comes back when the player chooses it (see rule-transition.test.mjs).
  await call(gm, 'PUT', a, { rule_system: 'pbta' });
  const fresh = await call(pl, 'GET', pc + '/space');
  assert.equal(fresh.character.role_card.pbta, undefined); assert.equal(fresh.character.role_card.dnd, undefined);
  assert.equal(fresh.character.card_pending, true);
  const formerBook = fresh.card_archives.find((x) => x.rule_system === 'pbta');
  assert.deepEqual(formerBook.numbers.pbta, saved.character.role_card.pbta);
  assert.equal(fresh.card_archives.find((x) => x.rule_system === 'dnd2024').numbers.dnd.level, 2);
  const restored = await call(pl, 'POST', pc + `/card-archives/${formerBook.id}/restore`, {});
  assert.deepEqual(restored.character.role_card.pbta, saved.character.role_card.pbta);
  assert.equal(restored.character.card_pending, false);
  // Call of Cthulhu again: the dice values are not back by themselves, only with the former card.
  await call(gm, 'PUT', a, { rule_system: 'coc7e' });
  const coc = await call(pl, 'GET', pc + '/space');
  assert.deepEqual(coc.attrs, {});
  const formerCoc = coc.card_archives.find((x) => x.rule_system === 'coc7e');
  assert.equal(formerCoc.attrs.STR, 55);
  assert.equal((await call(pl, 'POST', pc + `/card-archives/${formerCoc.id}/restore`, {})).attrs.STR, 55);
  await call(gm, 'PUT', a, { rule_system: 'dnd2024' });
  assert.notEqual((await call(pl, 'GET', pc + '/space')).attrs.STR, 55);
});
