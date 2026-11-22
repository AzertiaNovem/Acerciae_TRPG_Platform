import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.mjs';
import { parseChannel } from '../src/host-config.mjs';
import { applyChanges, formValues, FIELDS } from '../src/host-schema.mjs';
import { DEFAULT_WRITING, WRITING_MAX_LENGTH } from '../src/writing.mjs';
import { directorSystem } from '../src/director.mjs';
import { rulesProfile } from '../src/rules/index.mjs';

test('writing defaults are editable values and multiline guidance survives saving and resetting', () => {
  const cfg = buildConfig({}, {});
  const initial = formValues({}, cfg);
  assert.equal(initial['writing.gm'].effective, DEFAULT_WRITING.gm);
  assert.equal('writing.coplayer' in initial, false, 'the co-players\' guidance is retired');
  assert.equal(initial['writing.formatting'].effective, DEFAULT_WRITING.formatting);
  assert.notEqual(FIELDS.find(f => f.key === 'writing.formatting').group, FIELDS.find(f => f.key === 'writing.gm').group);
  const custom = '白描，不解释潜台词。\n\n保留犹豫、停顿与话外音。';
  const yaml = applyChanges('table:\n  language: zh-CN # keep\n', { 'writing.gm': custom });
  const data = parseChannel(yaml), loaded = buildConfig({}, {}, data);
  assert.equal(loaded.writing.gm, custom);
  assert.equal(loaded.writing.formatting, DEFAULT_WRITING.formatting);
  assert.match(yaml, /# keep/);
  const values = formValues(data, loaded, d => buildConfig({}, {}, d));
  assert.deepEqual(values['writing.gm'], { set: custom, effective: custom, default: DEFAULT_WRITING.gm });
  const restored = parseChannel(applyChanges(yaml, { 'writing.gm': null }));
  assert.equal(restored.writing, undefined);
  assert.deepEqual(buildConfig({}, {}, restored).writing, DEFAULT_WRITING);
  assert.deepEqual(buildConfig({}, {}, { writing: { gm: '', formatting: '  \n' } }).writing, DEFAULT_WRITING);
  assert.throws(() => applyChanges('', { 'writing.gm': 'x'.repeat(WRITING_MAX_LENGTH + 1) }), /不超过/);
  assert.throws(() => parseChannel('writing:\n  gm: [not, text]'), /must be text/);
});

test('presentation guidance saves and resets independently of prose guidance', () => {
  const custom = '每条最多两句话。\n\n长段拆成多条，保持节奏。';
  const yaml = applyChanges('', { 'writing.gm': '白描。', 'writing.formatting': custom });
  const data = parseChannel(yaml), cfg = buildConfig({}, {}, data);
  assert.equal(cfg.writing.gm, '白描。');
  assert.equal(cfg.writing.formatting, custom);
  assert.deepEqual(formValues(data, cfg, d => buildConfig({}, {}, d))['writing.formatting'], { set: custom, effective: custom, default: DEFAULT_WRITING.formatting });
  const reset = buildConfig({}, {}, parseChannel(applyChanges(yaml, { 'writing.formatting': '' })));
  assert.equal(reset.writing.gm, '白描。');
  assert.equal(reset.writing.formatting, DEFAULT_WRITING.formatting);
  assert.throws(() => applyChanges('', { 'writing.formatting': 'x'.repeat(WRITING_MAX_LENGTH + 1) }), /不超过/);
});

test('custom prose guidance replaces the original and leaves the rules in the prompt', () => {
  const custom = 'Use spare prose for investigators.\nKeep $& exactly.';
  const gm = directorSystem('Chinese', { profile: rulesProfile('dnd2024'), writing: custom });
  assert.ok(gm.includes(custom), 'profile adaptation must not rewrite user guidance');
  assert.ok(!gm.includes(DEFAULT_WRITING.gm));
  assert.match(gm, /Never write words, thoughts or decisions for player characters\./);
  assert.match(gm, /Write the turn as plain text/);
  assert.match(gm, /Players come and go/);
});
