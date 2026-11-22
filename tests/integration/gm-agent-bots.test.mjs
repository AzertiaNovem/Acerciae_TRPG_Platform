// The GM agent paces the platform's bots (docs/BOTS.md) against the real platform, with the mock model (scripts/test.sh
// runs the server with BOT_TICK_MS=300 BOT_SETTLE_MS=300 BOT_GM_WAIT_MS=2500): once it runs the table, a player's
// line owes the bots nothing of the platform's own; the agent answers the player, then asks the bot for its turn; the
// bot's line is a player's line the agent answers, and that answer asks the bot nothing more. The agent's notes for
// bots carry the public world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../../gm-agent/src/api.mjs';
import { Table } from '../../gm-agent/src/loop.mjs';
import { Roster } from '../../gm-agent/src/roles/roster.mjs';
import { MockLlm } from '../../gm-agent/src/llm/mock.mjs';
import { buildConfig } from '../../gm-agent/src/config.mjs';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) assert.fail('timed out'); await sleep(200); } }

test('gm-agent paces the platform bots: it answers the player, asks the bot, answers the bot, and asks no more', { timeout: 120000 }, async () => {
  const suffix = Date.now().toString(36);
  const [gm, ann] = await Promise.all(['gm', 'ann'].map(async (name) => { const api = new Api(base); await api.register(`gmb_${name}_${suffix}`, 'password', name); return api; }));
  const server = await gm.createServer('gm-agent bots');
  await gm.put(`/api/servers/${server.id}/settings`, { features: { bots: true } });
  const ch = await gm.createChannel(server.id, { name: 'Fog harbour' });
  await gm.post(`/api/channels/${ch.id}/members`, { user_id: ann.user.id, role: 'player' });
  const ada = await ann.createCharacter(ch.id, { name: 'Ada', kind: 'pc' });
  const main = (await gm.windows(ch.id)).find((w) => w.kind === 'main').id;
  const wren = await gm.post(`/api/servers/${server.id}/bots`, { name: 'Wren', persona: 'A retired sailor.' });
  await ann.post(`/api/channels/${ch.id}/bots`, { bot_id: wren.id });
  await sleep(800);
  const harriet = await gm.createCharacter(ch.id, { name: 'Harriet', kind: 'pc', user_id: wren.user_id });
  const byWren = async () => (await gm.messages(ch.id, main, 60)).filter((m) => m.author_id === wren.user_id);
  await until(async () => (await byWren()).length === 1);   // it takes up the part
  const triggers = async () => (await gm.get(`/api/servers/${server.id}/bots/${wren.id}/activity`)).map((t) => t.trigger).reverse();

  const llm = new MockLlm();
  let answers = 0;
  llm.director = () => ({ actions: [{ type: 'narrate', text: `The fog thickens (${++answers}).` }], coplayers_may_act: true });
  const cfg = buildConfig({}, {}); cfg.planner.enabled = false; cfg.autonomy = false; cfg.postDelayMs = 0; cfg.debounceMs = 0; cfg.sceneForks = false;
  const t = await new Table({ api: gm, channelId: ch.id, cfg, llm, roster: new Roster(), deferArrivals: true, improv: { on: true, world: 'A harbour town where the fog never lifts.' }, sleep: async () => {} }).init();
  assert.ok((await gm.channel(ch.id)).bot_pacing_until, 'the agent paces the bots from the start');
  const feed = async (m) => { await t.onEvent({ stream: 'chat', type: 'message.posted', channel_id: ch.id, message: m }); for (let i = 0; i < 10; i++) { await sleep(5); await t.queue; } };

  // The player speaks: the agent answers, then asks Wren; the platform gives Wren no turn of its own for the line.
  await feed(await ann.postMessage(ch.id, main, { content: 'I walk down to the pier.', kind: 'ic', character_id: ada.id }));
  assert.equal(answers, 1);
  const line = await until(async () => (await byWren())[1]);
  assert.equal(line.character_id, harriet.id); assert.equal(line.author_is_bot, true);
  assert.deepEqual(await triggers(), ['adopt', 'called']);
  assert.match((await gm.channel(ch.id)).bot_brief ?? '', /fog never lifts/, 'the notes for bots carry the public world');
  // Wren's line is a player's line: the agent answers it, and asks Wren nothing more.
  await feed(line);
  assert.equal(answers, 2);
  await sleep(2500);
  assert.equal((await byWren()).length, 2);
  assert.deepEqual(await triggers(), ['adopt', 'called']);
  assert.equal(t.lastHumanAt > 0, true);
  await t.memoryIdle(); t.store.close();
});

test('bots handoff: a character of the GM account goes to a bot, with its memories as the briefing', { timeout: 60000 }, async () => {
  const { handoffToBot } = await import('../../gm-agent/src/handoff.mjs');
  const suffix = Date.now().toString(36);
  const gm = new Api(base); await gm.register(`gmh_gm_${suffix}`, 'password', 'gm');
  const server = await gm.createServer('handoff');
  await gm.put(`/api/servers/${server.id}/settings`, { features: { bots: true } });
  const ch = await gm.createChannel(server.id, { name: 'Old house' });
  const main = (await gm.windows(ch.id)).find((w) => w.kind === 'main').id;
  const harriet = await gm.createCharacter(ch.id, { name: 'Harriet Vance', kind: 'pc', bio: 'A sharp antiquarian.' });
  const wren = await gm.post(`/api/servers/${server.id}/bots`, { name: 'Wren' });
  const done = await handoffToBot(gm, { channelId: ch.id, characterName: 'Harriet Vance', botName: 'Wren', chapters: () => [{ fromSeq: 1, toSeq: 9, text: 'The key was in the clock.' }] });
  assert.equal(done.bot, 'Wren');
  assert.equal((await gm.characters(ch.id)).find((c) => c.id === harriet.id).user_id, wren.user_id);
  const memory = await gm.get(`/api/channels/${ch.id}/bots/${wren.id}/memory`);
  assert.match(memory.briefing.text, /You now play Harriet Vance[\s\S]*The key was in the clock/);
  // The bot takes the part up: one line in character.
  const line = await until(async () => (await gm.messages(ch.id, main, 20)).find((m) => m.author_id === wren.user_id));
  assert.equal(line.character_id, harriet.id);
});
