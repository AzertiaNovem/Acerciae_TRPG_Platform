import test from 'node:test';
import assert from 'node:assert/strict';
import { branches, creationSettings, availableKeys } from '../web/create-wizard.js';
import { buildConfig } from '../src/config.mjs';
import { formValues, applyChanges } from '../src/host-schema.mjs';
import YAML from 'yaml';

const defaults = formValues({}, buildConfig({}, {}, { data: {} }));
const draft = (extra = {}) => ({ source: 'new', story: 'improv', world: 'forge', rule: 'coc7e', values: {}, ...extra });
test('creation branches require improvisation, casual mode, private phones and no module for daily life', () => {
  const d = draft({ source: 'existing', values: { 'modes.casual': true, 'daily.enabled': true } });
  const c = { knowledge: 'isolated' };
  assert.equal(branches(d, c, defaults).dailyReason, '');
  for (const [next, channel] of [[{ ...d, story: 'module' }, c], [{ ...d, values: {} }, c], [d, { knowledge: 'public' }], [d, { ...c, hasModule: true }]]) {
    assert.ok(branches(next, channel, defaults).dailyReason);
    assert.equal(creationSettings(next, channel, defaults)['daily.enabled'], false);
  }
  assert.ok(branches(d, { ...c, saved: { forgePhase: 'review' } }, defaults).pendingForge);
});
test('backtracking removes incompatible world, feature children and D&D values from the request', () => {
  const d = draft({ story: 'module', values: { 'modes.world_file': 'world.md', 'modes.secrets_file': 'secrets.md', 'table.level': '8', 'daily.enabled': 'true', 'daily.sparks_per_day': '4', 'planner.enabled': 'false', 'planner.final_review': 'true', 'illustrations.enabled': 'false', 'illustrations.allow_cloud': 'true', 'modes.casual_ai_chain': '3' } });
  const s = creationSettings(d, null, defaults);
  assert.equal(s['modes.improv'], false); assert.equal(s['forge.enabled'], false);
  assert.equal(s['daily.enabled'], false);
  for (const key of ['modes.world_file', 'modes.secrets_file', 'table.level', 'daily.sparks_per_day', 'planner.final_review', 'illustrations.allow_cloud', 'modes.casual_ai_chain']) assert.equal(key in s, false, key);
  assert.equal(s['planner.enabled'], 'false');
  const back = { ...d, story: 'improv', world: 'file', rule: 'dnd2024', values: { ...d.values, 'modes.casual': 'true' } };
  const restored = creationSettings(back, null, defaults);
  assert.equal(restored['modes.world_file'], 'world.md'); assert.equal(restored['table.level'], '8'); assert.equal(restored['daily.sparks_per_day'], '4');
});
test('existing mode defaults come from saved state and are not overwritten on attach', () => {
  const c = { knowledge: 'isolated', saved: { improv: true, casual: true, hasWorld: true } }, d = draft({ source: 'existing', story: 'inherit' });
  assert.deepEqual([branches(d, c, defaults).improv, branches(d, c, defaults).casual], [true, true]);
  const s = creationSettings(d, c, defaults);
  assert.equal('modes.improv' in s, false); assert.equal('modes.casual' in s, false); assert.equal('modes.world_file' in s, false);
  assert.ok(availableKeys(d, c, defaults).includes('daily.enabled'));
});
test('private forks make a new non-casual channel isolated and public existing channels cannot enable them', () => {
  const d = draft({ story: 'module', values: { 'modes.casual': false, 'timelines.scene_forks': 'true' } });
  assert.equal(branches(d, null, defaults).isolated, true);
  assert.equal(creationSettings(d, null, defaults)['modes.casual'], false);
  assert.equal(creationSettings({ ...d, source: 'existing' }, { knowledge: 'public' }, defaults)['timelines.scene_forks'], false);
});
test('wizard settings are accepted by the real schema and compile to the selected runtime modes', () => {
  const d = draft({ rule: 'dnd2024', values: { 'modes.casual': 'true', 'daily.enabled': 'true', 'daily.pc_sparks': 'false', 'daily.sparks_per_day': '0', 'context.daily_token_budget': '10000', 'table.level': '4' } });
  const settings = creationSettings(d, null, defaults);
  const cfg = buildConfig({}, {}, { data: YAML.parse(applyChanges('', settings)) });
  assert.equal(cfg.improv, true); assert.equal(cfg.forge.enabled, true); assert.equal(cfg.casual, true);
  assert.equal(cfg.daily.enabled, true); assert.equal(cfg.daily.sparks_per_day, 0); assert.equal(cfg.daily.pc_sparks, false);
  assert.equal(cfg.dailyTokenBudget, 10000); assert.equal(cfg.level, 4);
});
test('unfinished Forge resumes with improvisation even before a world exists; finished Forge keeps approved modes', () => {
  const pending = { knowledge: 'isolated', saved: { forgePhase: 'review', hasWorld: false } };
  const d = draft({ source: 'existing', story: 'inherit' });
  assert.equal(branches(d, pending, defaults).improv, true);
  assert.equal(creationSettings(d, pending, defaults)['modes.improv'], true);
  const played = { knowledge: 'isolated', saved: { forgePhase: 'playing', improv: true, casual: false, hasWorld: true } };
  const changed = draft({ source: 'existing', world: 'file', values: { 'modes.casual': true, 'modes.world_file': 'another-world.md' } });
  const s = creationSettings(changed, played, defaults);
  assert.equal(branches(changed, played, defaults).casual, false);
  assert.equal('modes.casual' in s, false); assert.equal('modes.world_file' in s, false);
});
test('only functioning planner-window, phone and calendar options are offered', () => {
  const d = draft({ story: 'module', values: { 'modes.casual': true, 'daily.enabled': true, 'planner.wish_window': true, 'illustrations.requests_per_hour': 4 } });
  const keys = availableKeys(d, null, defaults);
  assert.ok(!keys.includes('planner.wish_window')); assert.ok(!keys.includes('illustrations.requests_per_hour'));
  const daily = { ...d, story: 'improv' };
  assert.ok(!availableKeys(daily, null, defaults).includes('calendar.max_days'));
  assert.ok(!availableKeys({ ...daily, source: 'existing' }, { knowledge: 'public' }, defaults).includes('modes.casual_ai_chain'));
});
