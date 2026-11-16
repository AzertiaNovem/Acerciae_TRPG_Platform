// gm-agent's interactive messages against the real platform: every card its builders make (gm-agent/src/hypertext.mjs)
// is accepted, model text at its worst included; a GM's request_roll for a person's character becomes a roll card,
// the player's tap posts the roll as their character, and the table closes the card on that roll or on the same roll
// typed by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../../gm-agent/src/api.mjs';
import { Table } from '../../gm-agent/src/loop.mjs';
import { Roster } from '../../gm-agent/src/roles/roster.mjs';
import { MockLlm } from '../../gm-agent/src/llm/mock.mjs';
import { buildConfig } from '../../gm-agent/src/config.mjs';
import { rollRequest, choice, checklist } from '../../gm-agent/src/hypertext.mjs';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';

test('gm-agent cards: every builder is accepted, and a roll card closes on its roll', async () => {
  const suffix = Date.now().toString(36);
  const [gm, ann] = await Promise.all(['gm', 'ann'].map(async (name) => { const api = new Api(base); await api.register(`gmhx_${name}_${suffix}`, 'password', name); return api; }));
  const server = await gm.createServer('gm-agent cards');
  const ch = await gm.createChannel(server.id, { name: 'Lighthouse', ai_enabled: false });
  await gm.post(`/api/channels/${ch.id}/members`, { user_id: ann.user.id, role: 'player' });
  const ada = await ann.createCharacter(ch.id, { name: 'Ada', kind: 'pc' });
  const main = (await gm.windows(ch.id)).find((w) => w.kind === 'main').id;
  const status = async (id) => (await ann.get(`/api/channels/${ch.id}/hypertext?ids=${id}`)).items[0];

  // Each builder, plainly and with the worst text a model could hand it.
  const nasty = `{{x}} \u202Eevil\u202C\u2066 {{ ${'🜲'.repeat(2500)}`;
  const bodies = {
    roll: rollRequest({ text: 'The lamp gutters.', command: '.ra Spot Hidden', pcId: ada.id, name: 'Ada', language: 'English' }),
    rollNasty: rollRequest({ text: nasty, command: `.ra ${'Spot Hidden '.repeat(10).trim()}`, pcId: ada.id, name: `A{{d}}a${'x'.repeat(200)}`, language: 'Simplified Chinese' }),
    choice: choice({ prompt: 'Where now?', options: ['the lighthouse', 'the harbour', 'the inn'], actorIds: [ada.id], language: 'English' }),
    choiceNasty: choice({ prompt: nasty, options: Array.from({ length: 30 }, (_, i) => `${i} ${nasty}`), language: 'Traditional Chinese', title: nasty }),
    checklist: checklist({ title: 'Before you descend', items: ['Lamp oil', 'Rope', "The surveyor's map"], language: 'English' }),
    checklistNasty: checklist({ title: nasty, items: Array.from({ length: 100 }, (_, i) => `${i} ${nasty}`) }),
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(body, `${name} built`);
    const m = await gm.postHypertext(ch.id, main, body).catch((e) => assert.fail(`${name}: ${e.message} ${JSON.stringify(e.data?.errors ?? [])}`));
    assert.equal(m.kind, 'hypertext', name);
    assert.ok(m.content, `${name} has a fallback`);
  }

  // The table: a request_roll for Ada is a card in her scene, for her only.
  const cfg = buildConfig({}, {}); cfg.planner.enabled = false; cfg.autonomy = false; cfg.postDelayMs = 0;
  const t = await new Table({ api: gm, channelId: ch.id, cfg, llm: new MockLlm(), roster: new Roster(), deferArrivals: true, sleep: async () => {} }).init();
  assert.equal(await t.requestRoll(main, { type: 'request_roll', who: 'Ada', command: '.ra Spot Hidden 50', text: 'Something glints under the desk.' }), 1);
  const card = (await gm.messages(ch.id, main, 5)).filter((m) => m.kind === 'hypertext').at(-1);
  assert.equal(card.content, 'Something glints under the desk.\n→ Ada: .ra Spot Hidden 50');
  assert.deepEqual(card.hypertext.actors, [ada.id]);
  assert.equal([...t.rollCards.values()][0].id, card.id);
  // Ada's player taps the button: the platform posts the roll as Ada, from the card.
  const button = card.hypertext.body.find((n) => n.type === 'button');
  const acted = await ann.post(`/api/channels/${ch.id}/messages/${card.id}/hypertext/act`, { interaction_id: crypto.randomUUID(), node: button.id, say: { text: button.act.say }, state: { done: true }, base_version: 0 });
  const roll = acted.results[0].message;
  assert.equal(roll.kind, 'roll'); assert.equal(roll.character_id, ada.id); assert.equal(roll.via_hypertext_id, card.id);
  await t.onEvent({ stream: 'chat', type: 'message.posted', channel_id: ch.id, message: roll });
  assert.equal((await status(card.id)).closed, true, 'closed on the roll it posted');
  assert.equal(t.rollCards.size, 0);
  // Asked again, and typed by hand (with another value): that roll closes the card too.
  await t.requestRoll(main, { type: 'request_roll', who: 'Ada', command: '.ra Listen', text: 'A sound below.' });
  const second = [...t.rollCards.values()][0];
  const typed = await ann.postMessage(ch.id, main, { content: '.ra Listen 40', kind: 'ic', character_id: ada.id });
  assert.equal(typed.kind, 'roll');
  await t.onEvent({ stream: 'chat', type: 'message.posted', channel_id: ch.id, message: typed });
  assert.equal((await status(second.id)).closed, true, 'closed on the typed roll');
  await t.memoryIdle(); t.store.close();
});
