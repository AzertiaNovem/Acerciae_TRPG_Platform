import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.mjs';
import { MockLlm } from '../src/llm/mock.mjs';
import { generateCoplayer, normalizeCard, saveCharacter, putCardWithPoints } from '../src/roles/cardgen.mjs';
import { completeExistingCharacter } from '../src/roles/complete.mjs';
import { allocatePointBuy } from '../src/roles/pointbuy.mjs';

const rules = {
  skills: [{ name: 'Accounting', base: 5 }, { name: 'Law', base: 5 }, { name: 'Library Use', base: 20 }, { name: 'Listen', base: 20 }, { name: 'Persuade', base: 10 }, { name: 'Spot Hidden', base: 25 }, { name: 'Credit Rating', base: 0 }, { name: 'Dodge', base: 'DEX/2' }],
  families: [],
  careers: [{ id: 2, name: '会计师', names: { en: 'Accountant' }, points: [{ attrs: ['EDU'], mult: 4 }], formula: 'EDU×4', credit: [30, 70],
    fixed: ['Accounting', 'Law', 'Library Use', 'Listen', 'Persuade', 'Spot Hidden'].map((skill) => ({ skill })), choices: [], free: 2 }],
};
const opts = { rules, language: 'English', era: '1920s', pointsMode: false };
function character() {
  const generated = new MockLlm().card('', 'coplayer');
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

test('new co-players generate an appearance plus a career and budgeted skill increments', async () => {
  const llm = new MockLlm();
  const result = await generateCoplayer(llm, { ...opts, pointsMode: true, takenNames: [], partyNotes: '', index: 0, total: 1 });
  assert.ok(result.appearance_prompt);
  assert.equal(result.role_card.career.name, '会计师');
  assert.equal(Object.values(result.role_card.skill_points).reduce((n, p) => n + p.career, 0), result.role_card.characteristics.EDU * 4);
  assert.equal(Object.values(result.role_card.skill_points).reduce((n, p) => n + p.hobby, 0), result.role_card.characteristics.INT * 2);
  assert.deepEqual(llm.calls.map((r) => r.purpose), ['coplayer_card', 'coplayer_points']);
  assert.match(llm.calls[1].messages[0].content, /"fixed":/);
  assert.match(llm.calls[1].messages[0].content, /"credit":\[30,70\]/);
});

test('saving a new character sends the appearance to the real appearance API without triggering images', async () => {
  const calls = [];
  const api = new Api('https://fixture.invalid', { fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ id: 'new' });
  } });
  const generated = new MockLlm().card('', 'coplayer');
  await saveCharacter(api, 'channel', generated, { kind: 'coplayer', rules });
  assert.deepEqual(calls.map((r) => r.path), ['/api/channels/channel/characters', '/api/channels/channel/characters/new/card', '/api/channels/channel/characters/new/appearance']);
  assert.deepEqual(calls[2].body, { appearance_prompt: generated.appearance_prompt });
});

test('setup fills missing details while preserving filled fields, current HP and uploaded-image mode', async () => {
  const c = character();
  c.appearance_prompt = '';
  c.role_card.characteristics.STR = 81;
  delete c.role_card.characteristics.POW;
  c.role_card.background.ideology = '';
  c.role_card.background.traits = 'Human-written trait';
  c.role_card.derived.hp = 2;
  const api = new MemoryApi(c), llm = new MockLlm();
  assert.equal(await completeExistingCharacter(api, llm, 'channel', c.id, opts), true);
  assert.ok(api.character.appearance_prompt);
  assert.ok(api.character.role_card.characteristics.POW);
  assert.ok(api.character.role_card.background.ideology);
  assert.equal(api.character.role_card.characteristics.STR, 81);
  assert.equal(api.character.role_card.background.traits, 'Human-written trait');
  assert.equal(api.character.role_card.derived.hp, 2);
  assert.equal(api.character.asset_mode, 'uploaded');
  assert.equal(await completeExistingCharacter(api, llm, 'channel', c.id, opts), false);
  assert.equal(llm.calls.length, 1, 'a complete rerun makes no model call');
});

test('setup retrofits career and point allocation for an existing investigator, without losing growth', async () => {
  const c = character();
  c.role_card.career = { name: 'Accountant', choices: [], specialties: [] };
  c.role_card.skill_points = { Accounting: { career: 0, hobby: 0, growth: 7 } };
  const before = structuredClone(c.role_card.characteristics);
  const api = new MemoryApi(c), llm = new MockLlm();
  await completeExistingCharacter(api, llm, 'channel', c.id, { ...opts, pointsMode: true });
  assert.equal(api.character.role_card.career.name, '会计师');
  assert.equal(api.character.role_card.skill_points.Accounting.growth, 7);
  assert.ok(Object.values(api.character.role_card.skill_points).some((p) => p.career > 0));
  assert.deepEqual(api.character.role_card.characteristics, before);
  assert.equal(await completeExistingCharacter(api, llm, 'channel', c.id, { ...opts, pointsMode: true }), false);
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

test('a human edit during generation wins over the model patch', async () => {
  const c = character(); c.appearance_prompt = '';
  const api = new MemoryApi(c);
  const llm = { async complete() { api.character.appearance_prompt = 'Human appearance'; return '{"appearance_prompt":"Model appearance"}'; } };
  assert.equal(await completeExistingCharacter(api, llm, 'ch', c.id, opts), false);
  assert.equal(api.character.appearance_prompt, 'Human appearance');
  assert.deepEqual(api.writes, []);
});

test('point-only repairs cannot grant model-invented growth points', async () => {
  const c = character(); c.role_card.career = { name: '会计师' };
  const delegate = new MockLlm();
  const llm = { async complete(req) { const result = JSON.parse(await delegate.complete(req)); result.skill_points.Accounting.growth = 500; return JSON.stringify(result); } };
  const card = await allocatePointBuy(llm, c.role_card, opts);
  assert.equal(card.skill_points.Accounting.growth, 0);
});

test('setup resolves a model-selected career id to its canonical name before point allocation', async () => {
  const c = character(), api = new MemoryApi(c), delegate = new MockLlm();
  const llm = { async complete(req) {
    const response = JSON.parse(await delegate.complete(req));
    if (req.purpose === 'coplayer_repair') response.role_card.career = { id: 2, name: 'an invented career synonym' };
    return JSON.stringify(response);
  } };
  await completeExistingCharacter(api, llm, 'ch', c.id, { ...opts, pointsMode: true });
  assert.equal(api.character.role_card.career.name, '会计师');
  assert.ok(Object.keys(api.character.role_card.skill_points).length);
});
