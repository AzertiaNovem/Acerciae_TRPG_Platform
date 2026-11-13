import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_DEFAULTS as cfg, dailyState, modeOf, timetableAt, isNight, nightEnd, parseClock, formatClock, sparkDue, nextSparkAt, pickSpark, awayCommand, threadPermission } from '../src/daily.mjs';
const hour = 3600000;
test('daily clock: a story day every 17 hours, covering all 24 real hours', () => {
  const anchor = { realAt: 0, date: '1923-10-02', minute: 860 };
  assert.deepEqual(timetableAt(anchor, 17 * hour), { date: '1923-10-03', minute: 860, daysPassed: 1 });
  assert.equal(new Set(Array.from({length: 24}, (_, i) => i * 17 % 24)).size, 24);
  assert.equal(timetableAt(anchor, -1).minute, 860);
});
test('daily modes use two independent persisted timestamps and inclusive boundaries', () => {
  const s = dailyState(null, 0);
  assert.equal(modeOf(s, 2 * hour - 1, cfg), 'attended');
  assert.equal(modeOf(s, 2 * hour, cfg), 'unattended');
  s.lastHumanAt = hour;
  assert.equal(modeOf(s, 2 * hour, cfg), 'unattended');
  assert.equal(modeOf(JSON.parse(JSON.stringify(s)), 169 * hour, cfg), 'paused');
});
test('night joins go to the correct morning; full-width clock parsing', () => {
  assert.equal(parseClock('14：20 放学'), 860); assert.equal(formatClock(860), '14:20');
  assert.equal(parseClock('24:00'), null); assert.equal(parseClock('14:60'), null);
  assert.ok(isNight(23 * 60, cfg)); assert.ok(isNight(0, cfg)); assert.ok(!isNight(420, cfg));
  assert.deepEqual(nightEnd({ date: '1923-10-02', minute: 1400 }, cfg), { date: '1923-10-03', minute: 420 });
  assert.deepEqual(nightEnd({ date: '1923-10-02', minute: 30 }, cfg), { date: '1923-10-02', minute: 420 });
});
test('spark rate: rolling cap, night, pause, budget and tight interval', () => {
  const s = dailyState(null, 0); s.anchor = { realAt: 2 * hour, date: '1923-10-02', minute: 600 };
  assert.ok(!sparkDue(s, 2 * hour - 1, cfg)); assert.ok(sparkDue(s, 2 * hour, cfg));
  assert.ok(!sparkDue(s, 2 * hour, cfg, 'spent'));
  s.sparks = Array(8).fill(hour); assert.ok(!sparkDue(s, 2 * hour, cfg));
  assert.equal(nextSparkAt(0, cfg, 'tight', () => .5), 2 * nextSparkAt(0, cfg, 'none', () => .5));
  assert.equal(pickSpark([{ id: 'a', windowId: 'w' }], 'a', () => 0), null);
});
test('away aliases and thread owners', () => {
  assert.deepEqual(awayCommand('/离开 不要答应邀约'), { action: 'away', text: '不要答应邀约' });
  assert.equal(awayCommand('/away clear').action, 'clear'); assert.equal(awayCommand('/回来').action, 'back');
  const owners = [{name:'Alice', passive:true}, {name:'Bob', passive:false}];
  assert.ok(threadPermission({needs:'one'}, owners).mayAdvance);
  assert.ok(!threadPermission({needs:'all'}, owners).mayAdvance);
  owners[0].expired = true; assert.ok(threadPermission({needs:'all'}, owners).mayAdvance);
});
