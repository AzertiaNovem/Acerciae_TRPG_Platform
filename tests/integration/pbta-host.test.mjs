import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../../gm-agent/src/api.mjs';
import { preparePack, prepareActor } from '../../gm-agent/src/pbta.mjs';

const base = process.env.API_BASE || 'http://localhost:18081';
test('GM agent world review, sourced moves, player choices and atomic bookkeeping', async () => {
  const gm = new Api(base),
    pl = new Api(base),
    tag = Date.now().toString(36);
  await gm.register('host' + tag, 'password', 'MC');
  await pl.register('crew' + tag, 'password', 'Crew');
  const server = await gm.createServer('Station');
  const ch = (await gm.createChannel(server.id, { name: 'Orbital kitchen', rule_system: 'pbta' })).id;
  const win = (await gm.windows(ch))[0].id;
  const request = (api, path, body) => api.post('/api/channels/' + ch + path, body);
  await request(gm, '/members', { username: 'crew' + tag, role: 'player' });
  await assert.rejects(pl.pbtaDraft(ch), { status: 403 });
  const world =
    'Opening an orbital kitchen.\n' +
    'Ferries bring new customers.\n'.repeat(400) +
    'LAST: serve the night shift.';
  const rules = await gm.pbtaRules(ch);
  const llm = {
    async complete({ messages }) {
      const data = JSON.parse(messages[0].content);
      assert.equal(data.public_world, world);
      assert.deepEqual(Object.keys(data).sort(), ['public_world', 'template']);
      const pack = data.template;
      pack.name = 'Orbital kitchen';
      pack.books[0] = { id: 'chef', name: 'Night chef' };
      for (const move of pack.moves) if (move.book === 'scout') move.book = 'chef';
      pack.stats[0] = { id: 'tempo', name: 'Kitchen tempo' };
      for (const move of pack.moves) if (move.stat === 'sense') move.stat = 'tempo';
      pack.moves[0].trigger = 'When you carry a hot tray through a sudden docking rush.';
      for (const m of pack.moves) m.playerChoiceBands = [];
      // At tempo +1 the night shift always offers a costly choice. Real service dice can exercise
      // the mixed outcome deterministically while the GM remains free to set other thresholds.
      pack.bands[0].max = 2;
      pack.bands[1].min = 3;
      pack.bands[1].max = 13;
      pack.bands[2].min = 14;
      pack.moves[0].playerChoiceBands = ['mixed'];
      pack.moves[0].name = 'Serve under pressure';
      pack.moves[0].outcomes = {
        miss: 'The next ferry docks before this order is ready.',
        mixed: 'Choose: spend a supply or mark exposed.',
        strong: 'Every crew eats before the docking bell.',
      };
      return JSON.stringify({
        pack,
        reasons: ['Ferry arrivals change the dinner rush.', 'The night shift tests the crew.'],
      });
    },
  };
  let draft = await preparePack(gm, llm, ch, rules, world, 'English');
  assert.equal(draft.status, 'pending', draft.error);
  assert.equal((await gm.pbtaRules(ch)).pack.name, rules.pack.name);
  assert.deepEqual(await preparePack(gm, null, ch, rules, world, 'English'), draft);
  await assert.rejects(pl.reviewPbta(ch, { op: 'keep', version: draft.version }), { status: 403 });
  draft.pack.moves[0].name = 'Serve the rush';
  draft = await gm.reviewPbta(ch, { op: 'edit', version: draft.version, pack: draft.pack });
  await gm.put('/api/channels/' + ch + '/pbta', { ...rules, pack: { ...rules.pack, name: 'Other GM edit' } });
  await assert.rejects(
    gm.reviewPbta(ch, { op: 'activate', version: draft.version, pack: draft.pack, revision: 1 }),
    { status: 409 },
  );
  await gm.reviewPbta(ch, {
    op: 'activate',
    version: draft.version,
    pack: draft.pack,
    revision: 2,
    reviewed_changes: true,
  });
  const active = await gm.pbtaRules(ch);
  assert.equal(active.pack.moves[0].name, 'Serve the rush');
  const hero = await pl.createCharacter(ch, { name: 'Chef' });
  const sheet = { book: 'chef', resources: { supply: 3 }, stats: { tempo: 1 }, conditions: {} };
  await pl.putCard(ch, hero.id, { pack_revision: active.revision, role_card: { pbta: sheet } });
  const actor = await prepareActor(
    gm,
    {
      async complete({ messages }) {
        assert.ok(!messages[0].content.includes(active.pack.gmMoves[0].text));
        return JSON.stringify({ name: 'Pilot', role_card: { pbta: sheet } });
      },
    },
    ch,
    { rules: active, language: 'English', world },
  );
  assert.equal(actor.role_card.pbta.book, 'chef');
  const say = (content) => pl.postMessage(ch, win, { content, character_id: hero.id });
  const source = await say('I carry the hot tray through the crowd.');
  const move = {
    op: 'move',
    source_id: source.id,
    character_id: hero.id,
    move_id: 'search',
    revision: active.revision,
  };
  const ruling = (b) => gm.pbtaRuling(ch, win, b);
  await assert.rejects(pl.pbtaRuling(ch, win, move), { status: 403 });
  const [roll, duplicate] = await Promise.all([ruling(move), ruling(move)]);
  assert.equal(roll.id, duplicate.id);
  assert.deepEqual(roll.reference_ids, [source.id]);
  assert.equal(roll.dice.band.id, 'mixed');
  assert.equal(roll.dice.outcome, 'Choose: spend a supply or mark exposed.');
  assert.equal(roll.id, (await say('.move search')).id);
  const source2 = await say('I compare the orders.');
  const manual = await say('.move compare');
  assert.equal((await ruling({ ...move, source_id: source2.id, move_id: 'compare' })).id, manual.id);
  assert.equal(manual.dice.rolls, undefined);
  await assert.rejects(
    ruling({
      op: 'mark',
      character_id: hero.id,
      roll_id: roll.id,
      revision: active.revision,
      section: 'resources',
      field: 'supply',
      expected: 3,
      value: 2,
      basis: 'automatic',
    }),
    { status: 400 },
  );
  const question = {
    op: 'ask',
    character_id: hero.id,
    roll_id: roll.id,
    text: 'Spend a supply or mark exposed?',
  };
  const q = await ruling(question);
  assert.equal(q.id, (await ruling(question)).id);
  const mark = {
    op: 'mark',
    basis: 'choice',
    character_id: hero.id,
    roll_id: roll.id,
    revision: active.revision,
    section: 'resources',
    field: 'supply',
    expected: 3,
    value: 2,
  };
  await assert.rejects(ruling(mark), { status: 400 });
  assert.equal((await pl.characterSpace(ch, hero.id)).character.role_card.pbta.resources.supply, 3);
  const answer = await say('I spend a supply.');
  // Simulate the player marking it on the sheet before the agent processes the reply.
  await pl.putCard(ch, hero.id, {
    pack_revision: active.revision,
    role_card: { pbta: { ...sheet, resources: { supply: 2 } } },
  });
  const applied = await ruling({ ...mark, answer_id: answer.id });
  assert.ok(applied.content.includes('3 → 2'));
  assert.deepEqual(applied.reference_ids, [roll.id, answer.id]);
  const restored = (await gm.pbtaRulings(ch, win)).find((r) => r.roll_id === roll.id);
  assert.deepEqual(restored.dice, roll.dice);
  assert.equal(restored.question, q.content);
  assert.equal(restored.marks[0].answer, answer.content);
  assert.equal(restored.marks[0].change, applied.content);
  assert.ok((await gm.pbtaRulings(ch, win, manual.seq)).every((r) => r.seq < manual.seq));
  assert.equal(
    (await new Api(base, { token: gm.token }).pbtaRuling(ch, win, { ...mark, answer_id: answer.id })).id,
    applied.id,
  );
  assert.equal((await pl.characterSpace(ch, hero.id)).character.role_card.pbta.resources.supply, 2);
  const side = await request(gm, '/windows', { name: 'Private', kind: 'private' });
  await assert.rejects(gm.pbtaRuling(ch, side.id, move), { status: 400 });
  await assert.rejects(pl.pbtaRulings(ch, win), { status: 403 });
  const secret = await gm.postMessage(ch, side.id, {
    content: 'I test the side stove.',
    character_id: actor.id,
    visibility: 'gm_only',
  });
  const hidden = await gm.pbtaRuling(ch, side.id, { ...move, character_id: actor.id, source_id: secret.id });
  assert.equal(hidden.visibility, 'gm_only');
  assert.equal(hidden.chat_window_id, side.id);
  assert.equal(
    (await gm.pbtaRulings(ch, win)).some((r) => r.roll_id === hidden.id),
    false,
  );
  const declare = {
    op: 'declare',
    character_id: actor.id,
    source_id: answer.id,
    text: 'I check the written orders.',
    move_id: 'compare',
    modifier: 0,
    revision: active.revision,
  };
  const first = await ruling(declare);
  const replay = await ruling({ ...declare, text: 'I serve the table.', move_id: 'search' });
  assert.equal(replay.id, first.id);
  assert.deepEqual(replay.declared_move, { move_id: 'compare', modifier: 0, revision: active.revision });
  assert.equal((await gm.pbtaDraft(ch)).eligible, false);
});

test('the running MC reads real dice before asking; a co-player only receives its own moves', async () => {
  const { Table } = await import('../../gm-agent/src/loop.mjs');
  const { Roster } = await import('../../gm-agent/src/roles/roster.mjs');
  const { buildConfig } = await import('../../gm-agent/src/config.mjs');
  const { MockLlm } = await import('../../gm-agent/src/llm/mock.mjs');
  const { textOf } = await import('../../gm-agent/src/llm/parts.mjs');
  const tag = Date.now().toString(36),
    gm = new Api(base),
    pl = new Api(base);
  await gm.register('k' + tag, 'password', 'MC');
  await pl.register('h' + tag, 'password', 'Human');
  const server = await gm.createServer('Late ferry');
  const ch = (await gm.createChannel(server.id, { name: 'Crew galley', rule_system: 'pbta' })).id;
  const rules = await gm.pbtaRules(ch);
  for (const band of rules.pack.bands)
    rules.pack.moves[0].outcomes[band.id] = 'Choose: spend a supply or become exposed.';
  const { revision } = await gm.put('/api/channels/' + ch + '/pbta', rules);
  await gm.post('/api/channels/' + ch + '/members', { username: 'h' + tag, role: 'player' });
  const hero = await pl.createCharacter(ch, { name: 'Night cook' }),
    bot = await gm.createCharacter(ch, { name: 'Steward' });
  for (const [api, pc] of [
    [pl, hero],
    [gm, bot],
  ])
    await api.putCard(ch, pc.id, {
      pack_revision: revision,
      ...(pc.id === hero.id ? { bio: 'OTHER_CARD_ONLY' } : {}),
      role_card: { pbta: { book: 'scout', resources: { supply: 2 } } },
    });
  const win = (await gm.windows(ch))[0].id;
  const llm = new MockLlm(),
    original = llm.complete.bind(llm);
  let cue,
    reply,
    roll,
    asked = false,
    marked = false,
    botTurn = false;
  llm.complete = async (req) => {
    if (req.purpose === 'director') {
      const txt = req.messages.map((m) => textOf(m.content)).join('');
      assert.ok(req.system.includes('Powered by the Apocalypse'));
      assert.ok(!req.system.includes('.ra '));
      assert.ok(txt.includes(rules.pack.gmMoves[0].text));
      let actions = [];
      if (reply && !marked) {
        actions = [
          {
            type: 'mark',
            basis: 'choice',
            character_id: hero.id,
            roll_id: roll.id,
            answer_id: reply.id,
            section: 'resources',
            field: 'supply',
            expected: 2,
            value: 1,
          },
        ];
        marked = true;
      } else if (!asked && !roll && !txt.includes('"roll_id":"'))
        actions = [{ type: 'move', character_id: hero.id, source_id: cue.id, move_id: 'search' }];
      else if (!asked) {
        roll = (await gm.pbtaRulings(ch, win)).find((r) => r.character_id === hero.id);
        assert.ok(roll?.dice.text && txt.includes(roll.roll_id));
        roll.id = roll.roll_id;
        actions = [
          { type: 'ask', character_id: hero.id, roll_id: roll.id, text: 'Spend a supply or mark exposed?' },
        ];
        asked = true;
      }
      return JSON.stringify({ actions, coplayers_may_act: !!reply && !botTurn });
    }
    if (req.purpose === 'coplayer_turn') {
      const txt = req.messages.map((m) => textOf(m.content)).join('');
      assert.ok(!txt.includes('HIDDEN_KITCHEN') && !txt.includes(rules.pack.gmMoves[0].text));
      assert.ok(!txt.includes('OTHER_CARD_ONLY'));
      assert.ok(!txt.includes(rules.pack.moves.find((m) => m.book === 'scribe').trigger));
      assert.ok(txt.includes(rules.pack.moves.find((m) => m.id === 'compare').trigger));
      botTurn = true;
      return JSON.stringify({
        action: 'roll',
        command: '.move compare',
        text: 'I lay out both order slips.',
      });
    }
    return original(req);
  };
  const cfg = buildConfig({}, {});
  Object.assign(cfg, { debounceMs: 0, postDelayMs: 0, autonomy: false });
  cfg.planner.enabled = false;
  const make = () =>
    new Table({
      api: gm,
      llm,
      cfg,
      channelId: ch,
      roster: new Roster(),
      improv: { on: true, world: 'Orbital kitchen', secrets: 'HIDDEN_KITCHEN' },
      sleep: async () => {},
      log: process.env.TEST_LOG ? console.log : () => {},
    }).init();
  const table = await make();
  cue = await pl.postMessage(ch, win, {
    content: 'I brave the leaking pressure cooker.',
    character_id: hero.id,
  });
  await table.onMessage(cue);
  assert.ok(asked);
  assert.equal((await pl.characterSpace(ch, hero.id)).character.role_card.pbta.resources.supply, 2);
  await table.memoryIdle();
  const resumed = await make();
  reply = await pl.postMessage(ch, win, { content: 'I spend a supply.', character_id: hero.id });
  await resumed.onMessage(reply);
  assert.ok(marked && botTurn);
  assert.equal((await pl.characterSpace(ch, hero.id)).character.role_card.pbta.resources.supply, 1);
  const lines = await gm.pbtaRulings(ch, win);
  assert.equal(lines.find((r) => r.character_id === bot.id)?.dice.move_id, 'compare');
  assert.equal(lines.filter((r) => r.character_id === hero.id).length, 1);
  await resumed.memoryIdle();
  table.store.close();
  resumed.store.close();
});

test('failed world design can be retried or declined; established tables never redesign', async () => {
  const gm = new Api(base);
  await gm.register('retry' + Date.now().toString(36), 'password', 'Host');
  const srv = await gm.createServer('Ferries');
  const newTable = async (name) => (await gm.createChannel(srv.id, { name, rule_system: 'pbta' })).id;
  const ch = await newTable('Dock');
  const rules = await gm.pbtaRules(ch);
  assert.equal((await preparePack(gm, null, ch, rules, '', 'English')).status, 'none');
  const broken = {
    complete: async () => {
      throw Error('fixture model unavailable');
    },
  };
  let failed = await preparePack(gm, broken, ch, rules, 'A floating market', 'English');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /fixture model unavailable/);
  const retry = await gm.reviewPbta(ch, { op: 'retry', version: failed.version });
  assert.equal(retry.status, 'retry');
  failed = await preparePack(gm, broken, ch, rules, 'A floating market', 'English');
  await gm.reviewPbta(ch, { op: 'keep', version: failed.version });
  assert.equal((await preparePack(gm, null, ch, rules, 'New world text', 'English')).status, 'kept');
  const custom = await newTable('Established table');
  await gm.put('/api/channels/' + custom + '/pbta', {
    revision: 1,
    pack: { ...rules.pack, name: 'Existing rules' },
  });
  const result = await preparePack(
    gm,
    null,
    custom,
    await gm.pbtaRules(custom),
    'A different world',
    'English',
  );
  assert.equal(result.eligible, false);
  assert.equal((await gm.pbtaRules(custom)).pack.name, 'Existing rules');
});
