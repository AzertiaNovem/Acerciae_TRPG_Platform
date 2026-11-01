const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
// Open Log Studio's AI task manager (src/openstudio/tasks.ts) and project store (projects.ts): tasks outlive the UI,
// run side by side, and every request takes a slot in one pool.
function load() {
  const out = esbuild.buildSync({
    stdin: { contents: "export * from './tasks'; export * from './projects'; export { applyBackground, applyCharacterArt, applyVoice, openNeeds, voiceJobs } from './actions';", resolveDir: path.join(__dirname, '../src/openstudio'), loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}
const S = load();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(5); } assert.fail('timed out'); };

// Projects in memory; saves are recorded instead of written.
const disk = new Map();
const saved = [];
S.persistence.load = async (id) => structuredClone(disk.get(id));
S.persistence.save = async (p) => { saved.push(structuredClone(p)); disk.set(p.id, structuredClone(p)); };
function project(id) {
  return { id, title: 'Harbour ' + id, created_at: '', updated_at: '', background: { title: '', era: '', setting: '', summary: '' }, sources: [], speakers: [], issues: [],
    events: [1, 2, 3].map((seq) => ({ seq, type: 'narration', content: 'line ' + seq, speaker_key: 'kp', speaker_name: 'KP', role: 'gm', time: null, time_text: '', scene_title: '', window: '', dice: null, media: null, raw: '', unrecognised: false, source: { file: 'a', adapter: 'sealdice_text', line: seq } })),
    characters: [{ name: 'Ada', speakers: ['ada'], kind: 'pc', player: '', appearance: 'red hair', role_card: null, avatar: null, portrait: null, poses: {}, voice: 'v1' }, { name: 'Mo', speakers: ['mo'], kind: 'pc', player: '', appearance: 'tall', role_card: null, avatar: null, portrait: null, poses: {}, voice: '' }],
    vn: { script: { scenes: [{ key: 'harbour', title: 'Harbour', summary: '', background_brief: '', background: null, environment: 'none', lines: [1, 2, 3].map((seq) => ({ seq, hidden: false })) }], asset_needs: [{ kind: 'background', brief: 'a harbour', scene_key: 'harbour' }, { kind: 'standee', brief: 'x', character: 'Ada', subtitle: 'SAY' }], notes: [], provider: 'mock', stats: { scenes: 1, shown: 3, hidden: 0 } },
      template: {}, audio: {}, narrator_voice: 'nar', language: 'en', instructions: '', composed_at: '' } };
}
// A piece of AI work: holds a pool slot for `ms`, and records how many were in flight at once.
let inFlight = 0, peak = 0;
const work = (ctx, ms, value) => ctx.inSlot(async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(ms); inFlight--; return value; });

test('the pool runs at most `limit` requests across tasks; paint and voice run side by side and land in the project with no view open', async () => {
  disk.set('p1', project('p1'));
  S.pool.limit = () => 2;
  inFlight = 0; peak = 0;
  const voice = S.startTask({ projectId: 'p1', kind: 'voice', key: 'voice:p1', run: async (ctx) => {
    ctx.progress(0, 3);
    await S.eachInPool([1, 2, 3], ctx.signal, async (seq) => { const v = await work(ctx, 20, { path: `v${seq}.wav`, ms: 900 }); ctx.update((d) => S.applyVoice(d, seq, v)); ctx.step(); });
  } });
  const paint = S.startTask({ projectId: 'p1', kind: 'paint', key: 'paint:p1', run: async (ctx) => {
    const path = await work(ctx, 30, 'bg.png'); ctx.update((d) => S.applyBackground(d, 'harbour', path));
    const pose = await work(ctx, 10, 'ada-say.png'); ctx.update((d) => S.applyCharacterArt(d, 'Ada', { kind: 'pose', subtitle: 'SAY' }, pose));
  } });
  // Two characters' portraits at the same time, alongside.
  const ada = S.startTask({ projectId: 'p1', kind: 'art', key: S.artKey('p1', 'Ada', { kind: 'portrait' }), run: async (ctx) => { const p = await work(ctx, 10, 'ada.png'); ctx.update((d) => S.applyCharacterArt(d, 'Ada', { kind: 'portrait' }, p)); } });
  const mo = S.startTask({ projectId: 'p1', kind: 'art', key: S.artKey('p1', 'Mo', { kind: 'portrait' }), run: async (ctx) => { const p = await work(ctx, 10, 'mo.png'); ctx.update((d) => S.applyCharacterArt(d, 'Mo', { kind: 'portrait' }, p)); } });
  assert.equal(S.useTasks.getState().tasks.filter((t) => t.status === 'running').length, 4);
  await until(() => S.useTasks.getState().tasks.every((t) => t.status !== 'running'));
  assert.equal(peak, 2, 'never more than the limit in flight');
  for (const t of [voice, paint, ada, mo]) assert.equal(S.useTasks.getState().tasks.find((x) => x.id === t.id).status, 'done');
  assert.equal(S.useTasks.getState().tasks.find((x) => x.id === voice.id).done, 3);
  // Every result is in the project and saved to disk, though no view ever opened it; then it leaves memory.
  await until(() => !S.getProject('p1'));
  const p = disk.get('p1');
  assert.deepEqual(Object.keys(p.vn.audio).sort(), ['1', '2', '3']);
  assert.equal(p.vn.script.scenes[0].background, 'bg.png');
  assert.equal(p.characters[0].portrait, 'ada.png'); assert.equal(p.characters[0].poses.SAY, 'ada-say.png'); assert.equal(p.characters[1].portrait, 'mo.png');
  assert.equal(S.useTasks.getState().active, 0); assert.equal(S.useTasks.getState().waiting, 0);
});

test('what may run together: one script task, none while art or voices for it are made; the same task never twice', async () => {
  disk.set('p2', project('p2'));
  let release;
  const gate = new Promise((r) => { release = r; });
  S.startTask({ projectId: 'p2', kind: 'voice', key: 'voice:p2', run: () => gate });
  assert.equal(S.conflictFor('p2', 'voice', 'voice:p2'), 'same');
  assert.equal(S.conflictFor('p2', 'compose', 'compose:p2'), 'script-in-use');
  assert.equal(S.conflictFor('p2', 'paint', 'paint:p2'), null, 'painting while voicing');
  assert.equal(S.conflictFor('p2', 'art', S.artKey('p2', 'Ada', { kind: 'avatar' })), null);
  assert.equal(S.conflictFor('p3', 'compose', 'compose:p3'), null, 'another project is not affected');
  assert.throws(() => S.startTask({ projectId: 'p2', kind: 'compose', key: 'compose:p2', run: async () => {} }), /script-in-use/);
  release();
  await until(() => S.useTasks.getState().tasks.every((t) => t.status !== 'running'));
  let releaseScript;
  const writing = new Promise((r) => { releaseScript = r; });
  S.startTask({ projectId: 'p2', kind: 'compose', key: 'compose:p2', run: () => writing });
  assert.equal(S.conflictFor('p2', 'continue', 'compose:p2'), 'same');
  assert.equal(S.conflictFor('p2', 'paint', 'paint:p2'), 'script-running');
  assert.equal(S.conflictFor('p2', 'art', S.artKey('p2', 'Ada', { kind: 'avatar' })), null, 'character art does not depend on the script');
  releaseScript();
  await until(() => S.useTasks.getState().tasks.every((t) => t.status !== 'running'));
});

test('Stop: waiting requests never start, the task ends as stopped, finished work stays; a failed piece does not stop the rest', async () => {
  disk.set('p4', project('p4'));
  S.pool.limit = () => 1;
  let started = 0;
  const t = S.startTask({ projectId: 'p4', kind: 'voice', key: 'voice:p4', run: async (ctx) => {
    await S.eachInPool([1, 2, 3], ctx.signal, async (seq) => {
      try { const v = await ctx.inSlot(async () => { started++; await sleep(30); return { path: `v${seq}`, ms: 1 }; }); ctx.update((d) => S.applyVoice(d, seq, v)); }
      catch (e) { if (!ctx.signal.aborted) ctx.fail(String(e)); }
    });
  } });
  await until(() => started === 1);
  S.cancelTask(t.id);
  await until(() => S.useTasks.getState().tasks.find((x) => x.id === t.id).status !== 'running');
  assert.equal(S.useTasks.getState().tasks.find((x) => x.id === t.id).status, 'cancelled');
  await sleep(60);
  assert.equal(started, 1, 'nothing after Stop');
  const f = S.startTask({ projectId: 'p4', kind: 'paint', key: 'paint:p4', run: async (ctx) => {
    await S.eachInPool(['a', 'b', 'c'], ctx.signal, async (x) => { try { await ctx.inSlot(async () => { if (x === 'b') throw new Error('HTTP 500'); }); ctx.step(); } catch (e) { ctx.fail(`${x}: ${e.message}`); ctx.step(); } });
  } });
  await until(() => S.useTasks.getState().tasks.find((x) => x.id === f.id).status !== 'running');
  const done = S.useTasks.getState().tasks.find((x) => x.id === f.id);
  assert.equal(done.status, 'done'); assert.deepEqual(done.failures, ['b: HTTP 500']); assert.equal(done.done, 3);
  const failed = S.startTask({ projectId: 'p4', kind: 'compose', key: 'compose:p4', run: async () => { throw new Error('no key'); } });
  await until(() => S.useTasks.getState().tasks.find((x) => x.id === failed.id).status !== 'running');
  assert.equal(S.useTasks.getState().tasks.find((x) => x.id === failed.id).error, 'no key');
  S.clearFinishedTasks();
  assert.equal(S.useTasks.getState().tasks.length, 0);
});

test('a shown project is kept while a view shows it; changes are saved after the last one', async () => {
  disk.set('p5', project('p5'));
  const release = S.viewProject('p5');
  await S.openProject('p5');
  saved.length = 0;
  S.updateProject('p5', (d) => { d.title = 'A'; });
  S.updateProject('p5', (d) => { d.title = 'B'; });
  await sleep(700);
  assert.deepEqual(saved.map((p) => p.title), ['B'], 'one save, with the last change');
  release();
  await until(() => !S.getProject('p5'));
});

test('the patches: art for a scene that has a picture by now, a renamed character, a line no longer in the script', () => {
  const p = project('p6');
  p.vn.script.scenes[0].background = 'mine.png';
  S.applyBackground(p, 'harbour', 'late.png');
  assert.equal(p.vn.script.scenes[0].background, 'mine.png');
  S.applyCharacterArt(p, 'Nobody', { kind: 'portrait' }, 'x.png');
  assert.ok(p.characters.every((c) => c.portrait === null));
  S.applyVoice(p, 99, { path: 'v.wav', ms: 1 });
  assert.deepEqual(p.vn.audio, {});
  // What a script still asks for: Ada's SAY pose, the harbour; voices only for lines whose speaker has one.
  const q = project('p7');
  assert.deepEqual(S.openNeeds(q).map((n) => n.kind), ['background', 'standee']);
  assert.deepEqual(S.voiceJobs(q).map((j) => [j.seq, j.voice]), [[1, 'nar'], [2, 'nar'], [3, 'nar']]);
});
