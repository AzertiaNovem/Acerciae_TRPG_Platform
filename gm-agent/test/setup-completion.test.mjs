import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.mjs';
import { MockLlm } from '../src/llm/mock.mjs';
import { normalizeCard, saveCharacter, putCardWithPoints } from '../src/roles/cardgen.mjs';
import { allocatePointBuy } from '../src/roles/pointbuy.mjs';

const rules = {
  skills: [{ name: 'Accounting', base: 5 }, { name: 'Law', base: 5 }, { name: 'Library Use', base: 20 }, { name: 'Listen', base: 20 }, { name: 'Persuade', base: 10 }, { name: 'Spot Hidden', base: 25 }, { name: 'Credit Rating', base: 0 }, { name: 'Dodge', base: 'DEX/2' }],
  families: [],
  careers: [{ id: 2, name: '会计师', names: { en: 'Accountant' }, points: [{ attrs: ['EDU'], mult: 4 }], formula: 'EDU×4', credit: [30, 70],
    fixed: ['Accounting', 'Law', 'Library Use', 'Listen', 'Persuade', 'Spot Hidden'].map((skill) => ({ skill })), choices: [], free: 2 }],
};
const opts = { rules, language: 'English', era: '1920s', pointsMode: false };
function character() {
  const generated = new MockLlm().card('', 'npc');
  return { id: 'existing', name: 'Original name', ...generated, asset_mode: 'uploaded', role_card: normalizeCard(generated.role_card, { rules }) };
}
class MemoryApi {
  constructor(c) { this.character = structuredClone(c); this.writes = []; }
  async characterSpace() { return { character: structuredClone(this.character), points: {} }; }
  async putCard(_channel, id, body) {
    assert.equal(id, this.character.id);
    this.writes.push({ kind: 'card', body: structuredClone(body) });
    Object.assign(this.character, structuredClone(body));
    return this.characterSpace();
  }
  async putAppearance(_channel, id, body) {
    assert.equal(id, this.character.id);
    this.writes.push({ kind: 'appearance', body: structuredClone(body) });
    Object.assign(this.character, body);
    return this.characterSpace();
  }
  async createCharacter() { throw new Error('Existing setup must never create another character'); }
}

test("point buy: a career's budget is spent in career and hobby increments, from the career's own formula", async () => {
  const c = character();
  c.role_card.career = { name: '会计师', choices: [], specialties: [] };
  const llm = new MockLlm();
  const card = await allocatePointBuy(llm, c.role_card, { ...opts, pointsMode: true });
  assert.equal(card.career.name, '会计师');
  assert.equal(Object.values(card.skill_points).reduce((n, p) => n + p.career, 0), card.characteristics.EDU * 4);
  assert.equal(Object.values(card.skill_points).reduce((n, p) => n + p.hobby, 0), card.characteristics.INT * 2);
  assert.deepEqual(llm.calls.map((r) => r.purpose), ['coplayer_points']);
  assert.match(llm.calls[0].messages[0].content, /"fixed":/);
  assert.match(llm.calls[0].messages[0].content, /"credit":\[30,70\]/);
});

test('saving a new character sends the appearance to the real appearance API without triggering images', async () => {
  const calls = [];
  const api = new Api('https://fixture.invalid', { fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ id: 'new' });
  } });
  const generated = new MockLlm().card('', 'npc');
  await saveCharacter(api, 'channel', generated, { kind: 'npc', rules });
  assert.deepEqual(calls.map((r) => r.path), ['/api/channels/channel/characters', '/api/channels/channel/characters/new/card', '/api/channels/channel/characters/new/appearance']);
  assert.deepEqual(calls[2].body, { appearance_prompt: generated.appearance_prompt });
});

test('allocation failures never silently drop a career or point data', async () => {
  const c = character();
  c.role_card.career = { name: '会计师', choices: [], specialties: [] };
  const card = await allocatePointBuy(new MockLlm(), c.role_card, opts);
  const saved = [];
  const api = { async putCard(_ch, _id, body) { saved.push(body.role_card); throw Object.assign(new Error('disallowed skill'), { code: 'points_rule' }); } };
  await assert.rejects(putCardWithPoints(api, 'ch', 'id', card, { ...opts, pointsMode: true, llm: new MockLlm() }), /disallowed skill/);
  assert.equal(saved.length, 3);
  assert.ok(saved.every((v) => v.career.name && Object.keys(v.skill_points).length));
});

test('point-only repairs cannot grant model-invented growth points', async () => {
  const c = character(); c.role_card.career = { name: '会计师' };
  const delegate = new MockLlm();
  const llm = { async complete(req) { const result = JSON.parse(await delegate.complete(req)); result.skill_points.Accounting.growth = 500; return JSON.stringify(result); } };
  const card = await allocatePointBuy(llm, c.role_card, opts);
  assert.equal(card.skill_points.Accounting.growth, 0);
});

