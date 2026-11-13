import test from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../src/loop.mjs';
import { Roster } from '../src/roles/roster.mjs';
import { MockLlm } from '../src/llm/mock.mjs';
import { buildConfig } from '../src/config.mjs';
import { FakeApi } from './fixtures/platform.mjs';
import { attentionCandidates, noteAttention } from '../src/table/attention.mjs';

async function setup({ extra = [], cfg: overrides = {} } = {}) {
  const api = new FakeApi(), llm = new MockLlm(), clock = { now: 1700000000000 };
  api.characters_.push(...extra);
  const add = api.add.bind(api); api.add = m => add({ created_at: new Date(clock.now).toISOString(), ...m });
  const cfg = Object.assign(buildConfig({}, {}, { data: {} }), { debounceMs: 0, postDelayMs: 0, ...overrides });
  cfg.planner.enabled = false; cfg.illustrations.enabled = false;
  const t = await new Table({ api, cfg, llm, roster: new Roster(), channelId: 'ch', now: () => clock.now,
    sleep: async () => {}, log: process.env.TEST_LOG ? console.log : () => {} }).init();
  const line = (content, extra = {}) => { const m = api.add({ chat_window_id: 'w-main', author_id: 'u-bot', author_role: 'gm', kind: 'narration', content, ...extra }); t.noteLine(m); return m; };
  const seed = (n = 12) => { for (let i = 0; i < n; i++) line(`Other people continue their conversation ${i}.`); };
  const human = content => t.onMessage(api.add({ chat_window_id: 'w-main', author_id: 'u-alice', author_role: 'player', character_id: 'c-alice', kind: 'ic', content }));
  llm.coplayer = () => ({ action: 'pass' });
  return { t, api, llm, cfg, clock, line, seed, human };
}
const settle = async t => { for (let i = 0; i < 30 && t.pending; i++) { await new Promise(r => setTimeout(r, 2)); await t.queue; } assert.equal(t.pending, 0); };

test('neglect counts public play in the current seat; own activity, private logs and another window do not inflate it', async () => {
  const { t, line, seed, clock } = await setup();
  seed(11); assert.equal(attentionCandidates(t, 'w-main').length, 0);
  line('secret', { visibility: 'gm_only' }); line('OOC', { kind: 'ooc' }); line('elsewhere', { chat_window_id: 'w-priv' });
  assert.equal(attentionCandidates(t, 'w-main').length, 0);
  line('The discussion moves on.'); assert.deepEqual(attentionCandidates(t, 'w-main').map(c => c.id), ['c-harriet']);
  line('I have an idea.', { character_id: 'c-harriet', kind: 'ic' });
  assert.equal(attentionCandidates(t, 'w-main').length, 0);
  clock.now += 21 * 60000;
  assert.equal(attentionCandidates(t, 'w-main').length, 0, 'elapsed time alone does not wake an idle table');
  line('The others start a new conversation.'); assert.equal(attentionCandidates(t, 'w-main').length, 0, 'one old opening does not establish sustained neglect');
  seed(3); assert.equal(attentionCandidates(t, 'w-main').length, 1);
  t.roster.coplayers[0].seats = [{ windowId: 'w-main', fromSeq: t.lastSeq + 1, toSeq: null }];
  assert.equal(attentionCandidates(t, 'w-main').length, 0, 'a new seat does not inherit an old absence');
});

test('a neglected co-player gets a real action slot and GM follow-up within a small budget', async () => {
  const { t, api, llm, seed, human } = await setup({ cfg: { maxActionsPerTurn: 3 }, extra: [{ id: 'c-jiang', name: 'Jiang', kind: 'pc', user_id: 'u-bot', role_card: {} }] });
  seed();
  llm.director = user => ({ actions: user.includes('MODE: followup') ? [{ type: 'narrate', text: 'Mr. Grimsby shows Harriet the family album.' }] :
    ['Harriet, Mr. Grimsby has an album you might enjoy.', 'Extra prose one', 'Extra prose two'].map(text => ({ type: 'narrate', text })), coplayers_may_act: false, spotlight: ['Jiang'] });
  llm.coplayer = () => ({ action: 'speak', text: 'I ask about the oldest photograph.' });
  await human('I carry on reading.');
  assert.equal(api.posts.length, 3);
  assert.deepEqual(api.posts.filter(p => p.character_id).map(p => p.character_id), ['c-harriet']);
  assert.match(api.posts.at(-1).content, /family album/);
  assert.match(llm.calls.find(c => c.purpose === 'director').messages.at(-1).content, /PARTICIPATION REVIEW/);
  assert.match(llm.calls.find(c => c.purpose === 'coplayer_turn').messages.at(-1).content, /dedicated opportunity/);
  assert.equal(t.roster.coplayers[0].attention.decision, 'invite');
});

test('a grounded rest decision is respected and its review cooldown survives roster persistence', async () => {
  const { t, llm, seed, human, clock, line } = await setup(); seed();
  llm.director = () => ({ actions: [], coplayers_may_act: true, attention_review: { decision: 'rest', reason: 'Harriet explicitly chose to nap until lunch.' } });
  await human('I read quietly.');
  assert.ok(!llm.calls.some(c => c.purpose === 'coplayer_turn'));
  t.roster = new Roster(JSON.parse(JSON.stringify(t.roster.toJSON())));
  seed(); assert.equal(attentionCandidates(t, 'w-main').length, 0);
  clock.now += 21 * 60000; line('Lunch is ready.');
  assert.equal(attentionCandidates(t, 'w-main').length, 1);
});

test('a pending player roll takes precedence over the participation review', async () => {
  const { t, api, llm, seed, human } = await setup({ cfg: { maxActionsPerTurn: 3 } }); seed();
  llm.director = () => ({ actions: [{ type: 'request_roll', who: 'Alice Hale', command: '.ra Library Use', text: 'Check the catalogue first.' }], coplayers_may_act: false });
  await human('I search for the missing book.');
  assert.ok(api.posts.some(p => p.content.includes('Check the catalogue first.')));
  assert.ok(!llm.calls.some(c => c.purpose === 'coplayer_turn'));
  assert.equal(t.roster.coplayers[0].attention, undefined, 'the delayed opportunity remains eligible after the roll');
});

test('an opportunity becomes an independent playable scene only after the co-player chooses it', async () => {
  const { t, api, llm, seed, human } = await setup(); seed();
  t.timelines.main().location = 'Library';
  llm.director = user => ({ actions: user.includes('MODE: arrival') ? [{ type: 'narrate', text: 'Your photographs are ready to develop.' }] : user.includes('MODE: followup') ? [] : [{ type: 'narrate', text: 'Harriet remembers her unfinished photographs.' }], coplayers_may_act: false });
  let acted = false;
  llm.coplayer = () => !acted && (acted = true) ? { action: 'speak', text: 'I go to Darkroom to develop my photographs.' } : { action: 'pass' };
  llm.movements = ({ actors, lines }) => ({ moves: actors.flatMap(a => {
    const own = lines.find(l => a.sources.includes(l.seq) && l.text.startsWith('I go to Darkroom'));
    return own ? [{ id: a.id, seq: own.seq, destination: 'NEW', own_scene: true, place: 'Darkroom', span: 'long' }] : [];
  }) });
  await human('I stay in the Library.'); await settle(t);
  const side = t.timelines.of('c-harriet');
  assert.equal(side.location, 'Darkroom'); assert.deepEqual(side.members, ['c-harriet']);
  assert.equal(t.timelines.of('c-alice').id, 'main');
  assert.ok(api.posts.some(p => p.window === side.windowId && /ready to develop/.test(p.content)));
});

test('autonomous reviews respect typing, pause, idle, hourly and token caps even after ordinary quiet turns are exhausted', async () => {
  const { t, llm, seed, clock } = await setup({ cfg: { autonomyQuietMs: 1000 } }); seed();
  t.lastHumanAt = clock.now; t.state('w-main').lastHumanAt = clock.now; t.state('w-main').quietTurns = t.cfg.autonomyQuietTurns;
  clock.now += 1001;
  const base = llm.calls.length;
  t.typing.set('c-alice', { windowId: 'w-main', since: clock.now }); await t.tick(); assert.equal(llm.calls.length, base); t.typing.clear();
  t.generation.pause(); await t.tick(); assert.equal(llm.calls.length, base); t.generation.resume();
  t.cfg.autonomy = false; await t.tick(); assert.equal(llm.calls.length, base); t.cfg.autonomy = true;
  t.cfg.dailyTokenBudget = 1; t.overBudget = () => true; await t.tick(); assert.equal(llm.calls.length, base); t.overBudget = () => false;
  t.autonomousTurns = Array(t.cfg.autonomyMaxTurnsPerHour).fill(clock.now); await t.tick(); assert.equal(llm.calls.length, base); t.autonomousTurns = [];
  const recent = t.lastHumanAt; t.lastHumanAt = clock.now - 31 * 60000; await t.tick(); assert.equal(llm.calls.length, base); t.lastHumanAt = recent;
  llm.director = () => ({ actions: [], attention_review: { decision: 'rest', reason: 'Waiting for lunch as agreed.' } });
  await t.tick(); await settle(t);
  assert.equal(t.autonomousTurns.length, 1);
  assert.ok(llm.calls.some(c => c.purpose === 'director' && c.messages.at(-1).content.includes('MODE: attention')));
});

test('a recalled turn restores the participation review state', async () => {
  const { t, api, seed, line } = await setup(); seed();
  const source = line('Please continue.', { author_id: 'u-alice', author_role: 'player', character_id: 'c-alice', kind: 'ic' });
  const cp = t.openCheckpoint('w-main', 'human');
  noteAttention(t, attentionCandidates(t, 'w-main')[0], { decision: 'rest', reason: 'Waiting.' });
  t.closeCheckpoint(cp);
  assert.ok(t.roster.coplayers[0].attention);
  await t.rollback(source, [cp]);
  assert.equal(t.roster.coplayers[0].attention, undefined);
});
