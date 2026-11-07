import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { usageSnapshot, tableSnapshot } from '../src/host-status.mjs';
import { buildConfig } from '../src/config.mjs';
import { groupPurposes, partsOf } from '../web/usage.js';

test('usage charts retain all purposes, periods, models and uncertainty without counting cached input twice', () => {
  const store = new Store(), now = new Date(2026, 10, 7, 12).getTime();
  try {
    for (let i = 0; i < 12; i++) store.recordUsage({ at: now, purpose: 'task' + i, input: 100, cacheRead: 60, cacheWrite: 10, output: 20 });
    store.recordUsage({ at: now, purpose: 'planner', phase: 'draft', model: 'm1', input: 1000, cacheRead: 800, output: 100 });
    store.recordUsage({ at: now, purpose: 'planner', phase: 'revise', model: 'm2', input: 2000, output: 300, estimated: true });
    store.recordUsage({ at: now, purpose: 'director', usageKnown: false, status: 'failed' });
    store.recordUsage({ at: now - 86400000, purpose: 'yesterday', input: 500, output: 50 });
    store.recordUsage({ at: now - 8 * 86400000, purpose: 'old', input: 9_000_000 });
    const u = usageSnapshot(store, now);
    assert.equal(u.byPurpose.length, 15, 'no top-ten truncation');
    assert.equal(u.today.total, 4840); assert.equal(u.week.total, 5390);
    assert.equal(u.today.unknown, 1); assert.equal(u.today.estimated, 1); assert.equal(u.today.failed, 1);
    const groups = groupPurposes(u.byPurpose), planner = groups.find(r => r.id === 'planner');
    assert.equal(groups.length, 14); assert.equal(planner.total, 3400); assert.equal(planner.calls, 2);
    assert.deepEqual(partsOf(planner), { uncached: 2200, cacheRead: 800, cacheWrite: 0, output: 400 });
    assert.equal(Object.values(partsOf(planner)).reduce((a, b) => a + b), planner.total);
    assert.equal(groups.find(r => r.id === 'director').unknown, 1, 'a failed unreported call stays explicitly unknown');
    assert.ok(!u.periods.today.byPurpose.some(r => r.purpose === 'yesterday'));
    assert.ok(!u.periods.week.byPurpose.some(r => r.purpose === 'old'));
  } finally { store.close(); }
});

test('usage polling shares aggregates for 15 seconds and invalidates at midnight', () => {
  const store = new Store(), now = new Date(2026, 10, 7, 23, 59, 58).getTime();
  try {
    let reads = 0; const query = store.usageByPurpose.bind(store);
    store.usageByPurpose = since => { reads++; return query(since); };
    store.recordUsage({ at: now, purpose: 'director', input: 10, output: 5 });
    const initial = usageSnapshot(store, now);
    assert.equal(usageSnapshot(store, now + 1000), initial); assert.equal(reads, 2);
    assert.equal(usageSnapshot(store, now + 3000).today.total, 0, 'yesterday is not carried into the new day');
    assert.equal(reads, 4);
    store.recordUsage({ at: now + 4000, purpose: 'director', input: 20, output: 5 });
    assert.equal(usageSnapshot(store, now + 18000).today.total, 25); assert.equal(reads, 6);
  } finally { store.close(); }
});

test('a table snapshot includes the full adopted plan, including twists, exit conditions and pending version', () => {
  const store = new Store();
  try {
    const plan = { version: 3, throughline: 'Find the lost map', beat: { title: 'Harbour', exit: 'The captain shares a clue' },
      threads: [{ id: 'P1', twist: 'The captain is a rival' }], next: [{ what: 'A letter arrives', when: 'After dawn' }] };
    const cfg = buildConfig({}, {}, { data: { llm: { provider: 'mock' } } });
    const snapshot = tableSnapshot({ cfg, store, planner: { on: true, arc: plan, pending: { arc: { version: 4 } } },
      windows: [], characters: [], calendarOn: () => false });
    assert.deepEqual(snapshot.planner.plan, plan); assert.equal(snapshot.planner.pendingVersion, 4);
    assert.ok(!JSON.stringify(snapshot).includes('apiKey'));
  } finally { store.close(); }
});
