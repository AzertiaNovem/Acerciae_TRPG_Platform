import test from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../src/loop.mjs';
import { Roster } from '../src/roles/roster.mjs';
import { MockLlm } from '../src/llm/mock.mjs';
import { buildConfig } from '../src/config.mjs';
import { FakeApi } from './fixtures/platform.mjs';

async function setup({ extra = [], cfg: overrides = {} } = {}) {
  const api = new FakeApi(), llm = new MockLlm(), clock = { now: 1700000000000 };
  api.characters_.push(...extra);
  const cfg = Object.assign(buildConfig({}, {}, { data: {} }), {
    debounceMs: 0, postDelayMs: 0, sceneForks: false, autonomy: true,
    autonomySideIntervalMs: 90000, autonomyQuietMs: 600000, ...overrides,
  });
  cfg.planner.enabled = false; cfg.illustrations.enabled = false;
  const t = await new Table({ api, cfg, llm, roster: new Roster(), channelId: 'ch',
    now: () => clock.now, sleep: async () => {}, log: process.env.TEST_LOG ? console.log : () => {},
  }).init();
  const human = content => t.onMessage(api.add({ chat_window_id: 'w-main', author_id: 'u-alice', author_role: 'player', character_id: 'c-alice', kind: 'ic', content, created_at: new Date(clock.now).toISOString() }));
  return { t, api, llm, clock, human };
}

for (const sceneForks of [false, true]) test(`a confirmed visit repairs a rejected split and receives autonomous turns (scene forks: ${sceneForks})`, async () => {
  const { t, api, llm, clock, human } = await setup({ cfg: { sceneForks }, extra: [{ id: 'c-jiang', name: 'Jiang', kind: 'pc', user_id: 'u-bot', role_card: {} }] });
  t.timelines.main().location = 'Bookshop';
  const own = await t.post('w-main', { kind: 'ic', character_id: 'c-harriet', content: 'I went home after lunch; I am staying with Mr. Grimsby for tea.' });
  assert.equal(own, 1);
  const source = api.lines.at(-1);
  const confirmation = 'Harriet is at Hale house with Mr. Grimsby, not in the Bookshop. He has just asked about her weekend.';
  llm.movements = () => ({ moves: [] }); // Reproduce a rejected whereabouts proposal from the supplied log.
  llm.presence = ({ current, threads }) => {
    const here = threads.find(th => th.key === current);
    const seen = here.lines.find(l => l.text === confirmation);
    return { placements: [], departures: here.key === 'T0' && here.members.some(m => m.id === 'c-harriet') && seen
      ? [{ id: 'c-harriet', actor_seq: source.seq, confirmation_seq: seen.seq, place: 'Hale house', span: 'long' }] : [] };
  };
  llm.director = () => ({ actions: [{ type: 'narrate', text: confirmation }], coplayers_may_act: false,
    whereabouts: [{ who: ['Harriet Vance'], thread: 'new', place: 'Hale house', own_scene: true }] });
  await human('I keep reading in the Bookshop.');
  const home = t.timelines.of('c-harriet');
  assert.notEqual(home.id, 'main'); assert.equal(home.location, 'Hale house'); assert.equal(home.span, 'long');
  assert.equal(t.timelines.of('c-alice').id, 'main'); assert.equal(t.timelines.main().location, 'Bookshop');
  assert.equal(t.timelines.of('c-jiang').id, 'main', 'unrelated companions stay where they are');
  assert.match(home.notes, /He has just asked about her weekend/);
  assert.deepEqual(t.roster.coplayerByName('Harriet Vance').seats.filter(s => s.toSeq === null).map(s => s.windowId), [home.windowId]);
  assert.ok(!llm.calls.some(c => c.purpose === 'director' && c.messages[0].content.includes('MODE: arrival')), 'repair does not replay a fictional journey');

  const before = api.posts.length;
  clock.now += 90001;
  llm.director = () => ({ actions: [], coplayers_may_act: true });
  llm.coplayer = () => ({ action: 'speak', text: 'I was hoping to hear about your week.' });
  await t.tick();
  assert.ok(api.posts.slice(before).some(p => p.window === home.windowId && p.character_id === 'c-harriet'));
  assert.ok(api.posts.slice(before).every(p => p.window === home.windowId), 'the independent visit does not continue in the human scene');
  const prompt = llm.calls.findLast(c => c.purpose === 'coplayer_turn').messages[0].content;
  assert.match(prompt, /ELSEWHERE.*\n.*Alice Hale/s);
  assert.match(prompt, /WITH YOU HERE[^\n]*:\n\(none\)/);
});

test('a co-player-only primary scene is eligible for side turns while a human plays elsewhere', async () => {
  const { t, api, llm, clock } = await setup();
  const w = await api.createWindow('ch', { kind: 'group', name: 'Alice at the library', members: [{ user_id: 'u-alice', character_id: 'c-alice' }] });
  t.timelines.split({ name: 'Library', location: 'Library', members: ['c-alice'], windowId: w.id, span: 'long', fromSeq: api.seq + 1 });
  await t.refresh(); t.lastHumanAt = clock.now;
  clock.now += 90001;
  llm.director = () => ({ actions: [], coplayers_may_act: true });
  llm.coplayer = () => ({ action: 'speak', text: 'I ask Mr. Grimsby about his own plans.' });
  await t.tick();
  assert.ok(api.posts.some(p => p.window === 'w-main' && p.character_id === 'c-harriet'));
  assert.ok(llm.calls.some(c => c.purpose === 'director' && c.messages[0].content.includes('MODE: side')));
  const calls = llm.calls.length;
  t.generation.pause(); clock.now += 90001; await t.tick();
  assert.equal(llm.calls.length, calls);
  t.generation.resume(); t.cfg.dailyTokenBudget = 1;
  await t.tick(); assert.equal(llm.calls.length, calls, 'the same token cap still stops autonomous turns');
});

test('a small turn budget rotates speaking opportunities instead of always stopping at the first co-player', async () => {
  const extra = ['Jiang', 'Xie', 'Zhou'].map((name, i) => ({ id: `c-peer${i}`, name, kind: 'pc', user_id: 'u-bot', role_card: {} }));
  const { t, api, llm, human } = await setup({ extra, cfg: { maxActionsPerTurn: 2 } });
  llm.director = () => ({ actions: [{ type: 'narrate', text: 'The conversation continues.' }], coplayers_may_act: true });
  llm.coplayer = () => ({ action: 'speak', text: 'I have something to add.' });
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const before = api.posts.length;
    await human(`My next thought ${i}.`);
    const posts = api.posts.slice(before);
    assert.ok(posts.length <= t.cfg.maxActionsPerTurn);
    turns.push(...posts.filter(p => p.character_id).map(p => p.character_id));
  }
  assert.deepEqual(turns, ['c-harriet', 'c-peer0', 'c-peer1', 'c-peer2']);
});

const settle = async t => {
  for (let i = 0; i < 30 && t.pending; i++) { await new Promise(resolve => setTimeout(resolve, 2)); await t.queue; }
  assert.equal(t.pending, 0, 'all scheduled arrival turns finished');
};

for (const sceneForks of [false, true]) test(`own departures split in the same turn despite omitted GM whereabouts and a recent move (scene forks: ${sceneForks})`, async () => {
  const extra = ['Jiang', 'Xie', 'Zhou'].map(name => ({ id: `c-${name.toLowerCase()}`, name, kind: 'pc', user_id: 'u-bot', role_card: {} }));
  const { t, api, llm, clock, human } = await setup({ extra, cfg: { sceneForks } });
  t.timelines.main().location = 'Cafeteria';
  t.guard.commit(['c-harriet', 'c-jiang', 'c-xie'], { turn: 0, now: clock.now, seq: 0, prevOf: () => 'earlier-scene' });
  const choices = {
    'Harriet Vance': 'I go to Hale house now. Jiang, join me?',
    Jiang: 'Yes, I go with you, Harriet.',
    Xie: 'I go to Classroom Four now.',
    Zhou: 'Maybe I will visit the bookshop tomorrow.',
  };
  const acted = new Set();
  llm.coplayer = user => {
    const name = user.match(/^YOU ARE: (.+)$/m)?.[1];
    if (!choices[name] || acted.has(name)) return { action: 'pass' };
    acted.add(name);
    return { action: 'speak', text: choices[name] };
  };
  llm.director = user => ({ actions: user.includes('MODE: arrival') ? [{ type: 'narrate', text: 'The new scene begins.' }] : [], coplayers_may_act: !/^MODE:/m.test(user) });
  llm.movements = ({ actors, lines, discover }) => {
    assert.equal(discover, true);
    const home = lines.find(l => l.text === choices['Harriet Vance']);
    return { moves: actors.flatMap(a => {
      const own = lines.find(l => a.sources.includes(l.seq) && l.text === choices[a.name]);
      if (!own || a.id === 'c-zhou') return [];
      return [{ id: a.id, seq: own.seq, destination: 'NEW', own_scene: true,
        place: a.id === 'c-xie' ? 'Classroom Four' : 'Hale house', place_seq: a.id === 'c-xie' ? own.seq : home.seq, span: 'long' }];
    }) };
  };
  await human('I stay with Zhou in the Cafeteria.');
  const home = t.timelines.of('c-harriet'), classroom = t.timelines.of('c-xie');
  assert.equal(home.location, 'Hale house'); assert.deepEqual(new Set(home.members), new Set(['c-harriet', 'c-jiang']));
  assert.equal(classroom.location, 'Classroom Four'); assert.deepEqual(classroom.members, ['c-xie']);
  assert.equal(home.span, 'long'); assert.equal(classroom.span, 'long');
  assert.deepEqual(new Set(t.timelines.main().members), new Set(['c-alice', 'c-zhou']));
  assert.equal(t.timelines.main().location, 'Cafeteria');
  await settle(t);
  for (const scene of [home, classroom]) {
    assert.equal(api.posts.filter(p => p.window === scene.windowId && p.content === 'The new scene begins.').length, 1, 'each independent thread actually opens once');
    for (const id of scene.members) assert.deepEqual(t.roster.coplayers.find(c => c.characterId === id).seats.filter(s => s.toSeq === null).map(s => s.windowId), [scene.windowId]);
  }
  assert.ok(!api.posts.some(p => /deferred: it moved a moment ago/.test(p.content)));
});

test('a wrong group proposal cannot drag an undecided companion or the human into a clear solo departure', async () => {
  const { t, api, llm, human } = await setup({ extra: [{ id: 'c-jiang', name: 'Jiang', kind: 'pc', user_id: 'u-bot', role_card: {} }] });
  t.timelines.main().location = 'Cafeteria';
  await t.post('w-main', { kind: 'ic', character_id: 'c-harriet', content: 'I go to Hale house. Jiang, would you like to come?' });
  const departure = api.lines.at(-1).seq;
  await t.post('w-main', { kind: 'ic', character_id: 'c-jiang', content: 'Maybe tomorrow. I am staying here today.' });
  const staying = api.lines.at(-1).seq;
  llm.coplayer = () => ({ action: 'pass' });
  llm.director = user => ({ actions: user.includes('MODE: arrival') ? [{ type: 'narrate', text: 'Harriet arrives alone.' }] : [], coplayers_may_act: false,
    whereabouts: [{ who: ['Alice Hale', 'Harriet Vance', 'Jiang'], thread: 'new', place: 'Hale house', own_scene: true }] });
  llm.movements = ({ destinations }) => ({ moves: [
    { id: 'c-harriet', seq: departure, destination: destinations.find(d => d.place === 'Hale house').key },
    { id: 'c-jiang', seq: departure, destination: destinations.find(d => d.place === 'Hale house').key }, // borrowed evidence is invalid
    { id: 'c-jiang', seq: staying, destination: null },
  ] });
  await human('I stay in the Cafeteria.'); await settle(t);
  assert.deepEqual(t.timelines.of('c-harriet').members, ['c-harriet']);
  assert.deepEqual(new Set(t.timelines.main().members), new Set(['c-alice', 'c-jiang']));
  assert.equal(t.timelines.active().length, 2);
});

test('an omitted return joins the existing thread without opening a duplicate window', async () => {
  const { t, api, llm } = await setup();
  const window = await api.createWindow('ch', { kind: 'group', name: 'Hale house', members: [{ user_id: 'u-bot' }] });
  t.timelines.split({ name: 'Hale house', location: 'Hale house', members: ['c-harriet'], windowId: window.id, span: 'long', fromSeq: api.seq + 1 });
  t.roster.moveSeats([t.roster.coplayerByName('Harriet Vance')], [window.id], api.seq);
  await t.refresh();
  await t.post(window.id, { kind: 'ic', character_id: 'c-harriet', content: 'I go back to the Cafeteria now.' });
  const source = api.lines.at(-1).seq;
  t.timelines.main().location = 'Cafeteria';
  llm.director = () => ({ actions: [], coplayers_may_act: false });
  llm.movements = ({ actors, destinations }) => ({ moves: actors.some(a => a.id === 'c-harriet' && a.sources.includes(source))
    ? [{ id: 'c-harriet', seq: source, destination: destinations.find(d => d.place === 'Cafeteria').key }] : [] });
  const windowsBefore = api.createdWindows.length;
  // A fresh own action in the side turn is enough to run discovery without any human line there.
  let spoken = false;
  llm.coplayer = () => !spoken && (spoken = true) ? { action: 'speak', text: 'I am going back now.' } : { action: 'pass' };
  await t.turn(window.id, { mode: 'side' }); await settle(t);
  assert.equal(t.timelines.of('c-harriet').id, 'main');
  assert.equal(api.createdWindows.length, windowsBefore);
  assert.equal(t.timelines.active().length, 1);
});
