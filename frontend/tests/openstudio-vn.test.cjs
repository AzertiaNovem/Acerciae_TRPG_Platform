const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
// Open Log Studio's visual-novel pipeline (src/openstudio/vn): the composer ported from the server's VnScriptService
// (these tests mirror its unit tests), the in-app presentation, and the standalone bundle.
function load() {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/openstudio/vn/index.ts')], bundle: true, format: 'cjs', platform: 'node', write: false });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}
const vn = load();

// ---- fixtures ---------------------------------------------------------------------------------------
function ev(seq, o) {
  return {
    seq, type: o.type ?? 'dialogue', content: o.text ?? '', speaker_key: o.key ?? '', speaker_name: o.name ?? o.key ?? '', role: o.role ?? 'pc',
    time: o.time ?? null, time_text: '', scene_title: o.scene ?? '', window: o.win ?? '', dice: o.dice ?? null, media: null, raw: o.text ?? '',
    unrecognised: false, source: { file: 'log.txt', adapter: 'sealdice_text', line: seq },
  };
}
function sheet(name, o = {}) {
  return { name, speakers: o.speakers ?? [name.toLowerCase()], kind: o.kind ?? 'pc', player: '', appearance: o.appearance ?? '', role_card: null, avatar: null, portrait: o.portrait ?? null, poses: o.poses ?? {}, voice: '' };
}
function project(events, characters, extra = {}) {
  return {
    id: 'p1', title: extra.title ?? 'Harbour Nights', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    background: { title: '', era: extra.era ?? '', setting: '', summary: '' }, sources: [], events: events.map((e, i) => ({ ...e, seq: i + 1 })),
    speakers: [], characters, issues: [],
  };
}
const allLines = (script) => script.scenes.flatMap((s) => s.lines);

// The server's first composer test: two chat windows, two scenes.
function libraryProject() {
  const L = (win, scene, type, key, text) => ev(0, { win, scene: scene === 's1' ? 'Library' : 'Docks', type, key, text });
  return project([
    L('Library window', 's1', 'dialogue', 'ada', 'The ledger is missing.'), L('Harbour window', 's2', 'dialogue', 'mo', 'Fog on the water.'),
    L('Library window', 's1', 'ooc', '', 'brb'), L('Harbour window', 's2', 'action', 'mo', 'She lowers the lamp.'), L('Library window', 's1', 'dialogue', 'ada', 'Check the shelves.'),
  ], [sheet('Ada', { portrait: 'assets/ada.png' }), sheet('Mo')]);
}
const libraryBackgrounds = [{ name: 'Library at night', path: 'assets/bg-lib.png' }];

// The server's transcript test: one window, a gap of more than an hour, generated and uploaded art.
const T = 1700000000;   // 2023-11-14 22:13 UTC
function harbourProject() {
  const H = (type, key, name, role, text, time) => ev(0, { win: 'Main table', scene: 'Harbour', type, key, name, role, text, time });
  return project([
    H('narration', 'kp', 'Keeper', 'gm', 'Fog rolls over the harbour.', T), H('dialogue', 'mo', 'Mo', 'pc', 'I keep watch.', T + 60),
    H('ooc', 'mo', 'Mo', 'pc', 'brb', T + 90), H('dialogue', 'tom', 'Old Tom', 'npc', "Storm's coming.", T + 120),
    H('action', 'ada', 'Ada', 'pc', 'She lights the lamp.', T + 4000), H('dialogue', 'ada', 'Ada', 'pc', "Who's there?", T + 4100),
  ], [
    sheet('Ada', { appearance: 'red-haired librarian in a grey coat', portrait: 'assets/ada.png', poses: { IDLE: 'assets/ada-idle.png' } }),
    sheet('Mo', { portrait: 'assets/mo.png', poses: { IDLE: 'assets/mo-idle.png' } }),
    sheet('Old Tom', { kind: 'npc', speakers: ['tom'] }),
  ], { era: '1920s Arkham' });
}

// The server's wording test: narration to reword, a short question and answer to fold.
function cellarProject() {
  const C = (win, type, key, role, text) => ev(0, { win, scene: 'Cellar', type, key, name: key ? 'Ada' : 'Keeper', role, text, time: T });
  return project([
    C('Main', 'narration', '', 'gm', 'the cellar is dark. smells of damp. a door at the end'), C('Main', 'dialogue', 'ada', 'pc', 'is door locked?'),
    C('Main', 'narration', '', 'gm', 'yes'), C('Main', 'dice_roll', 'ada', 'pc', "Ada's Spot Hidden check: D100=12/60 — Hard Success"),
    C('Side', 'narration', '', 'gm', 'no'), C('Main', 'secret', '', 'gm', 'only you notice the key'), C('Main', 'dialogue', 'ada', 'pc', "Who's there?"),
  ], [sheet('Ada', { poses: { IDLE: 'assets/ada-idle.png' } })]);
}
const cellarAnswer = {
  script: [
    { ref: 'L1', background: 'Cellar', text: 'The cellar is dark and smells of damp; a door waits at the far end.' },
    { ref: 'L2', background: 'Cellar', kind: 'narration', fold: ['L3', 'L5', 'L6'], text: 'The door is locked.' },
    { ref: 'L4', speaker: 'C1', background: 'Cellar', text: 'Ada finds nothing.' },
    { ref: 'L7', speaker: 'C1', background: 'Cellar', portrait: 'IDLE' },
  ],
};

// ---- the composer (mirrors backend/tests/unit/unit_tests.cpp) ---------------------------------------------
test('visual-novel script keeps every canonical line and only hides lines excluded with a reason', () => {
  const p = libraryProject();
  const inp = vn.buildInputs(p, libraryBackgrounds);
  assert.deepEqual(inp.cast.map((c) => [c.ref, c.name]), [['C1', 'Ada'], ['C2', 'Mo']]);
  // Two model parts: the second continues scene "library" and references things that do not exist.
  const part1 = {
    scenes: [
      { key: 'Library', title: 'The Library', background: { ref: 'B1' }, lines: [{ ref: 'L1', stage: [{ who: 'C1', pos: 'left', expr: 'calm' }] }] },
      { key: 'docks', title: 'Docks', background: { ref: 'B9', brief: 'foggy pier' }, environment: 'fog', lines: [{ ref: 'L2', delivery: 'hushed', stage: [{ who: 'C2', pos: 'right', expr: 'afraid' }, { who: 'C9', pos: 'left' }] }] },
    ],
    excluded: [{ ref: 'L3', reason: 'out-of-character' }, { ref: 'L4' }],
  };
  const part2 = { scenes: [{ key: 'library', lines: [{ ref: 'L5', kind: 'bogus' }, { ref: 'L1' }, { ref: 'L77' }] }] };
  const script = vn.normalize(inp, [part1, part2], 'llm');
  assert.equal(script.scenes.length, 2);
  const [lib, dock] = script.scenes;
  assert.equal(lib.key, 'library'); assert.equal(lib.background, 'assets/bg-lib.png');
  // Library holds L1, the excluded OOC line L3 (hidden) and L5, in canonical order.
  assert.deepEqual(lib.lines.map((l) => l.seq), [1, 3, 5]);
  assert.equal(lib.lines[1].hidden, true); assert.equal(lib.lines[1].exclusion_reason, 'out-of-character');
  assert.equal(lib.lines[2].hidden, false); assert.equal(lib.lines[2].display_kind, undefined);
  assert.equal(lib.lines[2].stage[0].character, 'Ada');   // stage carries forward
  assert.equal(lib.lines[0].stage[0].expression, 'calm'); assert.equal(lib.lines[0].stage[0].position, 'left');
  // L4 was excluded without a reason, so it stays visible next to its neighbour.
  assert.deepEqual(dock.lines.map((l) => l.seq), [2, 4]); assert.equal(dock.lines[1].hidden, false);
  assert.equal(dock.background, null); assert.equal(dock.background_brief, 'foggy pier'); assert.equal(dock.environment, 'fog');
  assert.equal(dock.lines[0].stage.length, 1); assert.equal(dock.lines[0].stage[0].expression, 'afraid'); assert.equal(dock.lines[0].delivery, 'hushed');
  assert.deepEqual(script.stats, { scenes: 2, shown: 4, hidden: 1 });
  // Mock: parallel windows become separate scenes; OOC is excluded with a reason.
  const mock = vn.normalize(inp, [vn.mockPlan(inp)], 'mock');
  assert.equal(mock.scenes.length, 2); assert.equal(mock.scenes[0].title, 'Library · Library window');
  assert.equal(mock.scenes[0].lines.length, 3); assert.equal(mock.scenes[0].lines[1].hidden, true);
  assert.equal(mock.scenes[0].background, 'assets/bg-lib.png'); assert.equal(mock.notes.length, 1);
  const chunks = vn.chunk(inp.events, 2, 100000); assert.equal(chunks.length, 3); assert.deepEqual(chunks[2], [4, 5]);
  // A scene marker has no chat window: it opens the scene that follows it rather than closing the previous one.
  const marked = libraryProject();
  marked.events.splice(1, 0, ev(0, { type: 'scene_change', scene: 'Docks', role: 'gm', text: 'Docks' }));
  marked.events = marked.events.map((e, i) => ({ ...e, seq: i + 1 }));
  const mi = vn.buildInputs(marked, libraryBackgrounds);
  const withMarker = vn.normalize(mi, [vn.mockPlan(mi)], 'mock');
  assert.equal(withMarker.scenes.length, 2); assert.equal(withMarker.scenes[1].lines[0].seq, 2);
  // Non-ASCII keys continue across parts instead of collapsing to numbered fallbacks.
  const zh1 = { scenes: [{ key: '码头', title: '码头', lines: [{ ref: 'L3' }] }, { key: '图书馆', lines: [{ ref: 'L1' }] }] };
  const zh2 = { scenes: [{ key: '码头', lines: [{ ref: 'L5' }] }] };
  const zh = vn.normalize(mi, [zh1, zh2], 'llm');
  assert.ok(zh.scenes.some((s) => s.key === '码头' && s.lines.length >= 2));
  for (const s of [script, mock, withMarker, zh]) assert.equal(allLines(s).length, s === script || s === mock ? 5 : 6);
});

test('visual-novel transcript: time blocks, speaker labels, flat answers become scenes and art requests', () => {
  const inp = vn.buildInputs(harbourProject());
  assert.deepEqual(inp.cast.map((c) => [c.ref, c.name, c.asset_mode, c.subtitles]), [['C1', 'Ada', 'generated', ['IDLE']], ['C2', 'Mo', 'uploaded', ['IDLE']], ['C3', 'Old Tom', 'uploaded', []]]);
  // A gap longer than an hour between L4 and L5 opens the second block.
  const blocks = vn.blocks(inp.events); assert.equal(blocks.length, 2); assert.equal(blocks[1][0], 4);
  assert.equal(vn.blocks(inp.events, 10000).length, 1);
  assert.equal(vn.speakerLabel(inp.events[0]), 'KP(Narrative)'); assert.equal(vn.speakerLabel(inp.events[2]), 'Mo(OOC)');
  assert.equal(vn.speakerLabel(inp.events[3]), 'KP(as Old Tom)'); assert.equal(vn.speakerLabel(inp.events[1]), 'Mo');
  const t = vn.transcript(inp, 0, 4, []);
  assert.ok(t.includes('Era: 1920s Arkham'));
  assert.ok(t.includes('C1 "Ada" mode=generated subtitles=[IDLE] prompt="red-haired'));
  assert.ok(t.includes('C2 "Mo" mode=uploaded subtitles=[IDLE] (uploaded: only these subtitles may be used)'));
  assert.ok(t.includes('## Window: Main table')); assert.ok(t.includes('[L1] KP(Narrative)(22:13): Fog rolls over the harbour.'));
  assert.ok(t.includes('[L3] Mo(OOC)(22:14): brb')); assert.ok(!t.includes('[L5]'));
  assert.ok(t.includes('# Block (2023-11-14 22:13 – 2023-11-14 22:15)'));
  // Mock answer: SAY/IDLE portraits, a background to generate, OOC left out.
  const flat = vn.mockFlat(inp, 0, inp.events.length);
  assert.equal(flat.script.length, 5); assert.equal(flat.generate_backgrounds.length, 1); assert.equal(flat.generate_backgrounds[0].name, 'Harbour');
  assert.equal(flat.generate_portraits.length, 1); assert.equal(flat.generate_portraits[0].char, 'C1'); assert.equal(flat.generate_portraits[0].subtitle, 'SAY');
  assert.ok(flat.generate_portraits[0].prompt.startsWith('1920s Arkham'));
  assert.equal(flat.script[1].portrait, 'IDLE');   // Mo is uploaded-mode: SAY is not in the list, so the first listed subtitle is used
  const script = vn.normalize(inp, [vn.fromFlat(inp, [flat])], 'mock');
  assert.equal(script.scenes.length, 1); assert.equal(script.scenes[0].title, 'Harbour'); assert.equal(script.scenes[0].background, null);
  const lines = script.scenes[0].lines;
  assert.equal(lines.length, 6); assert.equal(lines[2].hidden, true); assert.equal(lines[2].exclusion_reason, 'out-of-character chatter');
  assert.equal(lines[4].stage.length, 2);
  assert.equal(lines[4].stage[1].expression, 'IDLE');   // Ada's IDLE art is already there
  assert.equal(lines[5].stage[1].expression, 'SAY');    // the default shows until SAY art lands
  assert.equal(script.asset_needs.length, 2);
  assert.deepEqual(script.asset_needs[0].kind, 'standee'); assert.equal(script.asset_needs[0].subtitle, 'SAY'); assert.equal(script.asset_needs[0].character, 'Ada');
  assert.equal(script.asset_needs[1].kind, 'background'); assert.equal(script.asset_needs[1].name, 'Harbour'); assert.equal(script.asset_needs[1].scene_key, 'harbour');
  // A model answer: a background change opens a new scene; an uploaded-mode portrait request is refused; copied text resolves to its line.
  const llm = {
    generate_backgrounds: [{ name: 'Lighthouse', prompt: '1920s lighthouse at night' }],
    generate_portraits: [{ char: 'C2', subtitle: 'FIGHT', prompt: 'x' }, { char: 'C1', subtitle: 'FIGHT', prompt: 'Ada ready to fight' }, { char: 'C1', subtitle: 'idle', prompt: 'Ada again' }],
    script: [
      { ref: 'L1', background: 'Harbour' }, { ref: 'L2', speaker: 'C2', background: 'Harbour', portrait: 'FIGHT' },
      { text: 'She lights the lamp.', speaker: 'C1', background: 'Lighthouse', portrait: 'FIGHT' }, { ref: 'L6', speaker: 'C1', portrait: 'SAY' },
    ],
  };
  const plan = vn.fromFlat(inp, [llm]);
  assert.equal(plan.scenes.length, 2); assert.equal(plan.scenes[1].title, 'Lighthouse'); assert.equal(plan.scenes[1].background.brief, '1920s lighthouse at night');
  assert.equal(plan.scenes[1].lines.length, 2); assert.equal(plan.scenes[1].lines[0].ref, 'L5');
  assert.equal(plan.scenes[0].lines[1].stage[0].expr, 'default');   // FIGHT is not in Mo's uploaded list
  assert.equal(plan.asset_needs.length, 3);   // Ada's FIGHT portrait (not IDLE, which she has), the harbour and the lighthouse, not Mo's
  assert.equal(plan.excluded.length, 1); assert.equal(plan.excluded[0].ref, 'L3');
  assert.equal(plan.scenes[1].lines[0].text, undefined);   // a line matched by its copied text keeps its words
});

test('visual-novel wording: narration is reworded, short questions and answers fold into narration, the log stays', () => {
  const p = cellarProject();
  const inp = vn.buildInputs(p);
  const plan = vn.fromFlat(inp, [cellarAnswer]);
  const lines = plan.scenes[0].lines;
  assert.equal(lines.length, 4);
  assert.equal(lines[0].text, 'The cellar is dark and smells of damp; a door waits at the far end.');
  assert.equal(lines[1].ref, 'L2'); assert.equal(lines[1].text, 'The door is locked.'); assert.equal(lines[1].kind, 'narration'); assert.equal(lines[1].speaker, undefined);
  assert.equal(lines[2].text, undefined);   // dice lines are never reworded
  assert.equal(lines[3].text, undefined);
  // L3 folds in; L5 (another window) and L6 (other readers) do not, and stay in the script.
  assert.deepEqual(plan.excluded, [{ ref: 'L3', reason: 'folded into narration (L2)' }]);
  const script = vn.normalize(inp, [plan], 'llm');
  const all = allLines(script);
  assert.equal(new Set(all.map((l) => l.seq)).size, 7);   // every log line is still in the script
  assert.equal(all.filter((l) => l.hidden).length, 1);
  const l2 = all.find((l) => l.seq === 2);
  assert.equal(l2.text, 'The door is locked.'); assert.equal(l2.display_kind, 'narration');
  assert.equal(p.events[0].content, 'the cellar is dark. smells of damp. a door at the end');   // the log keeps its words
});

// ---- composeScript ---------------------------------------------------------------------------------------
test('composeScript sends the server prompts and turns a canned answer into the script', async () => {
  const calls = [];
  const llm = async (req) => { calls.push(req); return 'Here is the script:\n```json\n' + JSON.stringify(cellarAnswer) + '\n```'; };
  const progress = [];
  const script = await vn.composeScript(cellarProject(), { llm, language: 'zh', instructions: 'Keep it moody.', onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(calls.length, 1);
  const { system, user, json } = calls[0];
  assert.equal(json, true);
  assert.ok(system.startsWith('You are the script editor turning a tabletop RPG chat log into a visual-novel script.'));
  assert.ok(system.includes('Fold short question-and-answer exchanges into plain narration'));
  assert.ok(system.includes("prose in the log's own language"));
  assert.ok(system.includes('list each subtitle you use that is not yet listed under generate_portraits'));
  assert.ok(system.endsWith('in Simplified Chinese. Keep JSON keys, enum values, status values and ids exactly as specified.'));
  assert.ok(user.startsWith('Part 1 of 1\nGM direction (data): Keep it moody.\n# Assets\n'));
  assert.ok(user.includes('## Window: Main') && user.includes('## Window: Side'));
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  assert.equal(script.provider, 'llm'); assert.deepEqual(script.notes, []);
  const all = allLines(script);
  assert.deepEqual(all.map((l) => l.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(all.filter((l) => l.hidden).map((l) => [l.seq, l.exclusion_reason]), [[3, 'folded into narration (L2)']]);
  assert.equal(all.find((l) => l.seq === 2).text, 'The door is locked.');
  // English adds no language rule.
  await vn.composeScript(cellarProject(), { llm, language: 'en' });
  assert.equal(calls[1].system, vn.SYSTEM_PROMPT);
});

test('composeScript falls back to the rule-based plan for a malformed answer and keeps every line', async () => {
  for (const garbage of ['Sorry, I cannot help with that.', '{"script": "nope"}', '[1, 2, 3]', '{"script": [{"ref": "L99"}]}']) {
    const script = await vn.composeScript(harbourProject(), { llm: async () => garbage, language: 'en' });
    assert.equal(script.provider, 'llm');
    assert.equal(script.notes.length, 2, garbage);   // two time blocks, two parts
    assert.ok(script.notes.every((n) => n.includes('planned by rules')));
    const all = allLines(script);
    assert.equal(all.length, 6);
    assert.deepEqual(all.filter((l) => l.hidden).map((l) => [l.seq, l.exclusion_reason]), [[3, 'out-of-character chatter']]);
    // The fallback's staging and art requests are the mock planner's.
    assert.ok(script.asset_needs.some((n) => n.kind === 'standee' && n.character === 'Ada' && n.subtitle === 'SAY'));
  }
});

test('composeScript chunks long logs, carries new backgrounds forward, and mixes model and fallback parts', async () => {
  const events = [];
  for (let i = 0; i < 130; i++) events.push(ev(0, { win: 'Main', scene: 'Road', type: i % 2 ? 'dialogue' : 'narration', key: i % 2 ? 'ada' : 'kp', name: i % 2 ? 'Ada' : 'Keeper', role: i % 2 ? 'pc' : 'gm', text: `line ${i + 1}`, time: T + i }));
  const p = project(events, [sheet('Ada', { portrait: 'assets/ada.png' })]);
  const users = [];
  const llm = async ({ user }) => {
    users.push(user);
    const [, part] = /^Part (\d+) of (\d+)/.exec(user);
    if (part === '1') return JSON.stringify({ generate_backgrounds: [{ name: 'Old Road', prompt: 'a muddy road at dusk' }], script: [...user.matchAll(/\[L(\d+)\]/g)].map((m) => ({ ref: `L${m[1]}`, background: 'Old Road' })) });
    return 'not json at all';
  };
  const progress = [];
  const script = await vn.composeScript(p, { llm, language: 'en', onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(users.length, 2);
  assert.ok(users[0].includes('[L120]') && !users[0].includes('[L121]'));
  assert.ok(users[1].includes('- "Old Road" prompt="a muddy road at dusk"'));   // the second part knows the first part's backgrounds
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
  assert.equal(script.notes.length, 1); assert.ok(script.notes[0].startsWith('Part 2/2 (L121–L130)'));
  assert.equal(allLines(script).length, 130);
  assert.equal(allLines(script).filter((l) => l.hidden).length, 0);
  assert.equal(script.scenes[0].title, 'Old Road'); assert.equal(script.scenes[0].lines.length, 120);
});

test('composeScript without a model is the rule-based planner; an aborted signal stops it', async () => {
  const script = await vn.composeScript(harbourProject(), { llm: null, language: 'en' });
  assert.equal(script.provider, 'mock'); assert.deepEqual(script.notes, [vn.MOCK_NOTE]);
  assert.equal(allLines(script).length, 6); assert.deepEqual(script.stats, { scenes: 1, shown: 5, hidden: 1 });
  const ac = new AbortController();
  let calls = 0;
  const llm = async () => { calls++; ac.abort(); return JSON.stringify(cellarAnswer); };
  await assert.rejects(vn.composeScript(harbourProject(), { llm, language: 'en', signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(calls, 1);
  // Asset needs are capped at 24.
  const many = { generate_portraits: Array.from({ length: 30 }, (_, i) => ({ char: 'C1', subtitle: `POSE${i}`, prompt: 'p' })), script: [] };
  const inp = vn.buildInputs(harbourProject());
  assert.equal(vn.normalize(inp, [vn.fromFlat(inp, [many])], 'llm').asset_needs.length, 24);
});

// ---- toPresentation -------------------------------------------------------------------------------------
test('toPresentation resolves each placement to the pose for its subtitle, then the main portrait', async () => {
  const p = harbourProject();
  const script = await vn.composeScript(p, { llm: null, language: 'en' });
  // A stage that names a subtitle in another case, and a narration line that keeps no standees.
  script.scenes[0].lines[5].stage = [{ character: 'Mo', position: 'left', expression: 'idle' }, { character: 'Ada', position: 'right', expression: 'SAY' }];
  const pres = vn.toPresentation(p, script, { base: 'nvl', accent_color: '#112233', font: 'Arial; } body {', portrait_framing: 'full' });
  assert.equal(pres.settings.template.base, 'nvl'); assert.equal(pres.settings.template.accent_color, '#112233');
  assert.equal(pres.settings.template.font, undefined); assert.equal(pres.settings.template.portrait_framing, 'full');
  assert.equal(pres.scenes.length, 1); assert.equal(pres.scenes[0].title, 'Harbour'); assert.equal(pres.scenes[0].background_asset_id, null);
  assert.equal(pres.events.length, 6);
  const bySeq = Object.fromEntries(pres.events.map((e) => [e.sequence_number, e]));
  assert.equal(bySeq[1].display_kind, 'narration'); assert.deepEqual(bySeq[1].character_asset_ids, []);
  assert.equal(bySeq[3].hidden, true); assert.equal(pres.line_count, 5);
  // L2: Mo speaks, his uploaded IDLE pose.
  assert.deepEqual(bySeq[2].character_asset_ids.map((c) => [c.character_id, c.expression, c.asset_id, c.active]), [['Mo', 'IDLE', 'assets/mo-idle.png', true]]);
  assert.equal(bySeq[2].character_name, 'Mo'); assert.equal(bySeq[2].speaker_display_name, 'Mo');
  // L4: Old Tom has no art at all.
  const tom = bySeq[4].character_asset_ids.find((c) => c.character_id === 'Old Tom');
  assert.equal(tom.asset_id, null);
  // L5: Ada's IDLE pose; L6: "idle" finds Mo's IDLE pose, and Ada's SAY (no such pose) falls back to her portrait.
  assert.equal(bySeq[5].character_asset_ids.find((c) => c.character_id === 'Ada').asset_id, 'assets/ada-idle.png');
  assert.deepEqual(bySeq[6].character_asset_ids.map((c) => [c.character_id, c.asset_id, c.asset_version, c.active]), [['Mo', 'assets/mo-idle.png', 1, false], ['Ada', 'assets/ada.png', 1, true]]);
  assert.deepEqual(pres.character_images, { Ada: ['default', 'IDLE'], Mo: ['default', 'IDLE'] });
  assert.deepEqual(vn.characterNames(p), { Ada: 'Ada', Mo: 'Mo', 'Old Tom': 'Old Tom' });
  // Reworded lines show the script's words; the log's content stays.
  const cellar = cellarProject();
  const cs = await vn.composeScript(cellar, { llm: async () => JSON.stringify(cellarAnswer), language: 'en' });
  const cp = vn.toPresentation(cellar, cs, {});
  const l2 = cp.events.find((e) => e.sequence_number === 2);
  assert.equal(l2.display_text, 'The door is locked.'); assert.equal(l2.content, 'is door locked?'); assert.equal(l2.script_text, 'The door is locked.');
  assert.deepEqual(l2.character_asset_ids, []);   // narration keeps the stage empty
  assert.equal(cp.events.find((e) => e.sequence_number === 4).display_kind, 'dice');
  assert.equal(cp.settings.template.base, 'adv');
  // Lines the script does not mention land in a final scene.
  const partial = { ...cs, scenes: [{ ...cs.scenes[0], lines: cs.scenes[0].lines.slice(0, 2) }] };
  const pp = vn.toPresentation(cellar, partial, {});
  assert.equal(pp.scenes.at(-1).title, 'Unplaced lines'); assert.equal(pp.events.length, 7);
});

// ---- the standalone bundle --------------------------------------------------------------------------------
test('standaloneHtml embeds the data so that no log text can leave the JSON script block', async () => {
  const evil = '</script><script>alert(1)</script> <!-- <script> & "quotes"  ';
  const p = harbourProject();
  p.title = 'Night <b>&</b> "Fog"';
  p.events[1].content = evil;
  p.characters[0].poses.SAY = '../../etc/passwd';                     // outside the project: never copied
  p.characters[1].portrait = 'https://example.com/mo full.png';      // a remote URL with a space: not used
  const script = await vn.composeScript(p, { llm: null, language: 'en' });
  const audio = { 2: { path: 'audio/line-2.mp3', ms: 2345.4 }, 6: { path: 'tts/x/line-2.mp3', ms: 1000 } };
  const data = vn.standaloneData(p, script, { base: 'dossier', accent_color: '#8B1E1E' }, audio);
  assert.equal(data.title, p.title); assert.equal(data.template.base, 'dossier');
  assert.deepEqual(Object.keys(data.scenes[0]), ['id', 'title', 'background']);
  assert.equal(data.events.length, 5);   // the OOC line is hidden
  const e2 = data.events.find((e) => e.text === evil);
  assert.ok(e2); assert.equal(e2.audio, 'audio/line-2.mp3'); assert.equal(e2.audio_ms, 2345);
  assert.deepEqual(Object.keys(e2).slice(0, 6), ['id', 'scene_id', 'kind', 'text', 'speaker', 'stage']);
  const e6 = data.events.find((e) => e.text === "Who's there?");
  assert.equal(e6.audio, 'audio/line-2-2.mp3');   // two voice files with one name stay apart
  for (const e of data.events) for (const s of e.stage) if (s.image) assert.match(s.image, /^assets\/[A-Za-z0-9._-]+$/);
  assert.ok(data.events.every((e) => e.stage.every((s) => s.image !== '../../etc/passwd')));
  const html = vn.standaloneHtml(data);
  assert.ok(html.includes('<title>Night &lt;b&gt;&amp;&lt;/b&gt; &quot;Fog&quot;</title>'));
  assert.ok(html.includes('--accent: #8B1E1E;'));
  assert.ok(!html.includes('alert(1)</script>') && !html.includes('<!-- <script>'));
  assert.equal(html.split('</script>').length - 1, 2);   // only the template's own two script elements close
  const open = '<script id="vn-data" type="application/json">';
  const start = html.indexOf(open) + open.length;
  const block = html.slice(start, html.indexOf('</script>', start));
  assert.ok(!/[<>&]/.test(block));
  assert.deepEqual(JSON.parse(block), JSON.parse(JSON.stringify(data)));
  assert.ok(html.includes("document.body.classList.add('frame-' + (tpl.portrait_framing === 'full' ? 'full' : 'upper'));"));
  // A colour that is not a CSS literal never reaches the stylesheet.
  assert.ok(vn.standaloneHtml({ ...data, template: { accent: 'red; } body { display:none' } }).includes('--accent: #c9a35c;'));
});

test('bundleFiles lists index.html, script.json and every image and voice line to copy', async () => {
  const p = harbourProject();
  const script = await vn.composeScript(p, { llm: null, language: 'en' });
  script.scenes[0].background = 'assets/bg/harbour.webp';
  const files = vn.bundleFiles(p, script, {}, { 2: { path: 'audio/l2.wav', ms: 900 } });
  assert.deepEqual(files.slice(0, 2).map((f) => f.path), ['index.html', 'script.json']);
  const data = JSON.parse(files[1].content);
  assert.equal(data.scenes[0].background, 'assets/harbour.webp');
  const copies = Object.fromEntries(files.slice(2).map((f) => [f.path, f.asset]));
  assert.deepEqual(copies, {
    'assets/harbour.webp': 'assets/bg/harbour.webp', 'assets/mo-idle.png': 'assets/mo-idle.png', 'assets/ada-idle.png': 'assets/ada-idle.png',
    'assets/ada.png': 'assets/ada.png', 'audio/l2.wav': 'audio/l2.wav',
  });
  // Every path the data names is a file of the bundle.
  const listed = new Set(files.map((f) => f.path));
  for (const s of data.scenes) if (s.background) assert.ok(listed.has(s.background));
  for (const e of data.events) { for (const s of e.stage) if (s.image) assert.ok(listed.has(s.image)); if (e.audio) assert.ok(listed.has(e.audio)); }
  assert.ok(files[0].content.includes(vn.embedJson(data)));
  assert.equal(vn.bundleFolderName('Harbour Nights: 码头'), 'Harbour_Nights__码头');
  assert.equal(vn.bundleFolderName('???'), '___'); assert.equal(vn.bundleFolderName(''), 'visual-novel');
});

test('continueScript: only the lines after the ending, the story so far, reused backgrounds, new scenes appended', async () => {
  const H = (type, key, name, role, text, time) => ev(0, { win: 'Main table', scene: 'Harbour', type, key, name, role, text, time });
  const p = project([
    H('narration', 'kp', 'Keeper', 'gm', 'Fog rolls over the harbour.', T), H('dialogue', 'ada', 'Ada', 'pc', "Who's there?", T + 60),
  ], [sheet('Ada', { appearance: 'red-haired librarian', portrait: 'assets/ada.png', poses: { SAY: 'assets/ada-say.png' } })], { era: '1920s Arkham' });
  // The first visual novel, with its scene painted and a voice line.
  const first = await vn.composeScript(p, { llm: null, language: 'en' });
  first.scenes[0].background = 'assets/bg-harbour.png';
  p.vn = { script: first, template: {}, audio: { 2: { path: 'assets/v2.wav', ms: 900 } }, narrator_voice: '', language: 'en', instructions: '', composed_at: '' };
  assert.equal(vn.unscriptedCount(p), 0);
  await assert.rejects(vn.continueScript(p, { llm: null, language: 'en' }), /no new lines/);
  // The supplement: the harbour goes on, then a new place.
  p.events.push({ ...H('narration', 'kp', 'Keeper', 'gm', 'The fog lifts.', T + 120), seq: 3 }, { ...H('dialogue', 'ada', 'Ada', 'pc', 'Look, the lighthouse!', T + 180), seq: 4 }, { ...H('narration', 'kp', 'Keeper', 'gm', 'They climb the stairs.', T + 240), seq: 5 });
  assert.equal(vn.unscriptedCount(p), 3);
  assert.equal(vn.lastScriptedSeq(first), 2);
  const calls = [];
  const llm = async (req) => { calls.push(req); return JSON.stringify({ generate_backgrounds: [{ name: 'Lighthouse stairs', prompt: 'spiral stairs' }], generate_portraits: [{ char: 'C1', subtitle: 'SAY', prompt: 'again' }],
    script: [{ ref: 'L1', background: 'Harbour' }, { ref: 'L2', speaker: 'C1', background: 'Harbour', portrait: 'SAY' }, { ref: 'L3', background: 'Lighthouse stairs' }] }); };
  const script = await vn.continueScript(p, { llm, language: 'en' });
  assert.equal(calls.length, 1);
  const { system, user } = calls[0];
  assert.ok(system.startsWith(vn.SYSTEM_PROMPT) && system.includes('Continuation: this visual novel already exists'));
  assert.ok(user.includes('# Story so far (context only, already in the visual novel)\nLast scene: "Harbour"\nIts background: "Harbour"\n'));
  assert.ok(user.includes("- Ada: Who's there?"));
  assert.ok(user.includes('- "Harbour" (existing)'));
  const lines = user.slice(user.indexOf('# Block'));
  assert.ok(lines.includes('[L1] KP(Narrative)(22:15): The fog lifts.') && !lines.includes('Fog rolls over') && !lines.includes('[L4]'), 'only the new lines are planned');
  assert.ok(user.indexOf('# Story so far') < user.indexOf('# Assets'));
  assert.ok(user.includes('subtitles=[SAY]'));
  // The old scene is kept and goes on; the new place is a new scene that asks for its picture; Ada's SAY is not redrawn.
  assert.equal(script.scenes.length, 2);
  assert.deepEqual(script.scenes[0].lines.map((l) => l.seq), [1, 2, 3, 4]);
  assert.equal(script.scenes[0].background, 'assets/bg-harbour.png');
  assert.equal(script.scenes[1].title, 'Lighthouse stairs'); assert.deepEqual(script.scenes[1].lines.map((l) => l.seq), [5]);
  assert.notEqual(script.scenes[1].key, script.scenes[0].key);
  assert.deepEqual(script.asset_needs.filter((n) => n.kind === 'background').map((n) => n.scene_key), [script.scenes[1].key]);
  assert.ok(!script.asset_needs.some((n) => n.kind === 'standee'));
  assert.deepEqual(script.stats, { scenes: 2, shown: 5, hidden: 0 });
  assert.ok(script.notes.some((n) => n.startsWith('Continued after line #2: 3 new lines from #3.')));
  assert.equal(first.scenes[0].lines.length, 2, 'the old script is not changed in place');

  // Without a model: the rule-based planner places the new lines and the harbour scene still goes on.
  const ruled = await vn.continueScript(p, { llm: null, language: 'en' });
  assert.equal(ruled.scenes.length, 1);
  assert.deepEqual(ruled.scenes[0].lines.map((l) => l.seq), [1, 2, 3, 4, 5]);
  assert.equal(ruled.asset_needs.filter((n) => n.kind === 'background').length, 0);
});

test('appendScript: a later scene named like an old pictured one takes its picture; keys stay unique', () => {
  const old = { scenes: [{ key: 'cellar', title: 'Cellar', summary: '', background_brief: '', background: 'assets/cellar.png', environment: 'none', lines: [{ seq: 1, hidden: false }] },
    { key: 'docks', title: 'Docks', summary: '', background_brief: 'docks', background: null, environment: 'none', lines: [{ seq: 2, hidden: false }] }],
    asset_needs: [{ kind: 'background', brief: 'docks', scene_key: 'docks' }], notes: [], provider: 'mock', stats: { scenes: 2, shown: 2, hidden: 0 } };
  const add = { scenes: [{ key: 'pier', title: 'Pier', summary: '', background_brief: '', background: null, environment: 'none', lines: [{ seq: 3, hidden: false }] },
    { key: 'cellar', title: 'Cellar', summary: '', background_brief: '', background: null, environment: 'none', lines: [{ seq: 4, hidden: true, exclusion_reason: 'x' }] }],
    asset_needs: [{ kind: 'background', brief: 'a pier', scene_key: 'pier' }, { kind: 'background', brief: 'again', scene_key: 'cellar' }], notes: [], provider: 'llm', stats: { scenes: 2, shown: 1, hidden: 1 } };
  const out = vn.appendScript(old, add, 'note');
  assert.deepEqual(out.scenes.map((s) => s.key), ['cellar', 'docks', 'pier', 'cellar-2']);
  assert.equal(out.scenes[3].background, 'assets/cellar.png');
  assert.deepEqual(out.asset_needs.map((n) => n.scene_key), ['docks', 'pier']);
  assert.deepEqual(out.stats, { scenes: 4, shown: 3, hidden: 1 });
  assert.deepEqual(out.notes, ['note']);
});

// ---- editing, exclusions and questions (mirrors the server's editing and replay tests) --------------------
test('the prompt carries the editing rules; exclusions are hidden with their reason, dice results stay', () => {
  assert.ok(vn.SYSTEM_PROMPT.includes(vn.EDITING_RULES));
  assert.ok(!vn.SYSTEM_PROMPT.includes('Leave out only Name(OOC)'));
  for (const s of ['edit boldly', 'whether or not it is labelled OOC', "posted by a bot's program", 'except dice results, which stay', '"MISSPELL"', 'do not guess', 'at most five', '"exclude":[{"ref":"L5"', '"questions":[{"id":"q1"']) assert.ok(vn.SYSTEM_PROMPT.includes(s), s);
  const B = (type, key, name, role, text) => ev(0, { win: 'Main', scene: 'Harbour', type, key, name, role, text, time: T });
  const p = project([
    B('narration', '', 'Keeper', 'gm', 'Log start: session 3'), B('dialogue', 'ada', 'Ada', 'pc', 'I open the door'), B('dialogue', 'ada', 'Ada', 'pc', 'MISSPELL'),
    B('dice_roll', 'ada', 'Ada', 'pc', '1d100=37 success'), B('dialogue', 'ada', 'Ada', 'pc', 'so are we playing thursday?'), B('narration', '', 'Keeper', 'gm', 'The door creaks open.'),
  ], [sheet('Ada')]);
  const inp = vn.buildInputs(p, []);
  const flat = {
    generate_backgrounds: [{ name: 'Harbour', prompt: 'p' }],
    script: [{ ref: 'L2', speaker: 'C1', background: 'Harbour', text: 'I open the door.' }, { ref: 'L4', speaker: 'C1', background: 'Harbour' }, { ref: 'L6', background: 'Harbour' }],
    exclude: [{ ref: 'L1', reason: 'bot log banner' }, { ref: 'L3', reason: 'placeholder left by an edit' }, { ref: 'L5', reason: 'scheduling talk' }, { ref: 'L2', reason: 'placed lines stay placed' }, { ref: 'L99' }, { ref: 'L6' }],
  };
  const plan = vn.fromFlat(inp, [flat]);
  assert.deepEqual(plan.excluded, [{ ref: 'L1', reason: 'bot log banner' }, { ref: 'L3', reason: 'placeholder left by an edit' }, { ref: 'L5', reason: 'scheduling talk' }]);
  const script = vn.normalize(inp, [plan], 'llm');
  const all = allLines(script);
  assert.equal(all.length, 6);
  assert.deepEqual(all.filter((l) => l.hidden).map((l) => [l.seq, l.exclusion_reason]), [[1, 'bot log banner'], [3, 'placeholder left by an edit'], [5, 'scheduling talk']]);
  assert.equal(all.find((l) => l.seq === 4).hidden, false);   // the dice result stays
  assert.deepEqual(script.stats, { scenes: 1, shown: 3, hidden: 3 });
  assert.equal(vn.fromFlat(inp, [{ script: [{ ref: 'L2', background: 'Harbour' }], exclude: [{ ref: 'L1' }] }]).excluded[0].reason, 'left out by the script editor');
  // The answers prompt lists the answers against the questions; unanswered ones are the editor's call.
  const qs = [{ id: 'q1', question: 'Is "Tom" the same person as "Old Tom"?', refs: ['L4'], options: [] }, { id: 'q2', question: 'Was L5 in character?', refs: ['L5'], options: [] }];
  const a = vn.answersPrompt(qs, { q1: 'Yes, one person.' });
  assert.ok(a.startsWith("# Answers to your questions about this part\n- q1 (\"Is 'Tom' the same person as 'Old Tom'?\"): Yes, one person.\n- q2 (\"Was L5 in character?\"): (no answer; decide yourself)\n"));
  assert.ok(a.includes('return the complete JSON for this part again'));
  assert.deepEqual(vn.questionsOf({ questions: [{ id: 'q1', question: 'A?', refs: ['L1'], options: ['yes', 'no'] }, { question: '' }, 'junk', { question: 'B?' }] }), [{ id: 'q1', question: 'A?', refs: ['L1'], options: ['yes', 'no'] }, { id: 'q2', question: 'B?', refs: [], options: [] }]);
  assert.equal(vn.questionsOf({ questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: `Q${i}` })) }).length, 5);
});

test('composeDraft pauses on questions; resumeDraft replays the turn with the answers, skips keep the draft, a part asks twice at most', async () => {
  const events = [];
  for (let i = 0; i < 130; i++) events.push(ev(0, { win: 'Main', scene: 'Road', type: i % 2 ? 'dialogue' : 'narration', key: i % 2 ? 'ada' : 'kp', name: i % 2 ? 'Ada' : 'Keeper', role: i % 2 ? 'pc' : 'gm', text: `line ${i + 1}`, time: T + i }));
  const p = project(events, [sheet('Ada', { portrait: 'assets/ada.png' })]);
  const calls = [];
  const turnOf = (text, n) => ({ provider: 'anthropic', model: 'm1', text, blocks: [{ type: 'thinking', thinking: `t${n}`, signature: `sig${n}` }, { type: 'text', text }] });
  let askAgain = false;
  const llm = async (req) => {
    calls.push(req);
    const [, part] = /^Part (\d+) of (\d+)/.exec(req.user);
    const refs = [...req.user.matchAll(/\[L(\d+)\]/g)].map((m) => `L${m[1]}`);
    const answer = { generate_backgrounds: [{ name: part === '1' ? 'Old Road' : 'Inn', prompt: 'x' }], script: refs.slice(1).map((ref) => ({ ref, background: part === '1' ? 'Old Road' : 'Inn' })), exclude: [{ ref: refs[0], reason: req.replay ? 'bot banner (confirmed)' : 'bot banner' }] };
    if (part === '1' && (!req.replay || askAgain)) answer.questions = [{ id: 'q1', question: `Is ${refs[0]} a bot banner?`, refs: [refs[0]], options: ['yes', 'no'] }];
    const text = JSON.stringify(answer);
    return { text, turn: turnOf(text, calls.length) };
  };
  const progress = [];
  const r = await vn.composeDraft(p, { llm, language: 'en', onProgress: (d, t) => progress.push([d, t]) });
  assert.ok('draft' in r);
  const { draft } = r;
  assert.equal(calls.length, 2); assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
  assert.deepEqual(draft.parts, [[0, 120], [120, 130]]); assert.equal(draft.flats[0], null); assert.ok(draft.flats[1]);
  assert.equal(draft.events, 130); assert.equal(draft.mode, 'compose');
  assert.equal(draft.pending.length, 1);
  const pend = draft.pending[0];
  assert.equal(pend.index, 0); assert.equal(pend.first_line, 1); assert.equal(pend.last_line, 120); assert.equal(pend.rounds, 1);
  assert.deepEqual(pend.questions, [{ id: 'q1', question: 'Is L1 a bot banner?', refs: ['L1'], options: ['yes', 'no'] }]);
  assert.equal(pend.turn.blocks[0].signature, 'sig1'); assert.equal(pend.user, calls[0].user); assert.ok(!('questions' in pend.draft));
  assert.ok(!calls[1].user.includes('Old Road'), 'the second part was planned without the pending part\'s backgrounds');
  // Unanswered: resuming is refused; a changed log invalidates the draft.
  await assert.rejects(vn.resumeDraft(p, { llm, language: 'en' }, draft), /unanswered/);
  const answered = { ...draft, pending: [{ ...pend, answers: { q1: 'yes' } }] };
  await assert.rejects(vn.resumeDraft({ ...p, events: p.events.slice(0, 129) }, { llm, language: 'en' }, answered), /the log changed/);
  // Answered: only part 1 runs again, with its own turn replayed and the answers after it.
  calls.length = 0;
  const done = await vn.resumeDraft(p, { llm, language: 'en' }, answered);
  assert.ok('script' in done);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user, pend.user);
  assert.deepEqual(calls[0].replay.turn, pend.turn);
  assert.ok(calls[0].replay.followUp.startsWith('# Answers to your questions about this part\n- q1 ("Is L1 a bot banner?"): yes\n'));
  const all = allLines(done.script);
  assert.equal(all.length, 130);
  assert.deepEqual(all.filter((l) => l.hidden).map((l) => [l.seq, l.exclusion_reason]), [[1, 'bot banner (confirmed)'], [121, 'bot banner']]);
  assert.deepEqual(done.script.notes, []);
  assert.deepEqual(done.script.scenes.map((s) => s.title), ['Old Road', 'Inn']);
  // Skipped: no call, the draft is used and the script says so.
  calls.length = 0;
  const skipped = await vn.resumeDraft(p, { llm, language: 'en' }, { ...draft, pending: [{ ...pend, skip: true }] });
  assert.equal(calls.length, 0); assert.ok('script' in skipped);
  assert.deepEqual(allLines(skipped.script).filter((l) => l.hidden).map((l) => l.seq), [1, 121]);
  assert.deepEqual(skipped.script.notes, ['Part 1/2 (L1–L120): its questions were skipped; the draft was used.']);
  // Asking again after the answers pauses once more; the third time the draft is used.
  askAgain = true; calls.length = 0;
  const again = await vn.resumeDraft(p, { llm, language: 'en' }, answered);
  assert.ok('draft' in again); assert.equal(again.draft.pending[0].rounds, 2); assert.equal(again.draft.pending[0].answers, null); assert.ok(again.draft.pending[0].turn.text.includes('bot banner (confirmed)'), 'the new turn is kept for the next round');
  const third = await vn.resumeDraft(p, { llm, language: 'en' }, { ...again.draft, pending: [{ ...again.draft.pending[0], answers: { q1: 'no' } }] });
  assert.ok('script' in third);
  assert.ok(third.script.notes[0].includes('asked again after the answers'));
  // A plain-text model (no turn to replay) gets the answers appended to the part's prompt.
  const plain = async (req) => { calls.push(req); return JSON.stringify({ script: [...req.user.matchAll(/\[L(\d+)\]/g)].map((m) => ({ ref: `L${m[1]}`, background: 'Road' })) }); };
  calls.length = 0;
  const flat = await vn.resumeDraft(p, { llm: plain, language: 'en' }, { ...answered, pending: [{ ...answered.pending[0], turn: null }] });
  assert.ok('script' in flat); assert.equal(calls[0].replay, undefined); assert.ok(calls[0].user.startsWith(pend.user + '\n# Answers to your questions'));
  // composeScript itself never waits: the drafts of asking parts are used.
  const whole = await vn.composeScript(p, { llm, language: 'en' });
  assert.equal(allLines(whole).length, 130); assert.ok(whole.notes[0].includes('skipped; the draft was used'));
});

test('replayableBlocks sends thinking back only unmodified, signed and to the same model; text always', () => {
  const turn = { provider: 'anthropic', model: 'claude-x', text: '{}', blocks: [
    { type: 'thinking', thinking: 'Let me read the log.', signature: 'sig-1' }, { type: 'thinking', thinking: 'unsigned' }, { type: 'redacted_thinking', data: 'blob' },
    { type: 'tool_use', id: 't1', name: 'x', input: {} }, { type: 'text', text: '{}' }] };
  const same = vn.replayableBlocks(turn, 'anthropic', 'claude-x');
  assert.deepEqual(same.map((b) => b.type), ['thinking', 'redacted_thinking', 'text']); assert.equal(same[0].signature, 'sig-1'); assert.ok(vn.carriesReasoning(same));
  const other = vn.replayableBlocks(turn, 'anthropic', 'claude-y');
  assert.deepEqual(other.map((b) => b.type), ['text']); assert.ok(!vn.carriesReasoning(other));
  assert.equal(vn.replayableBlocks(turn, 'openai', 'claude-x'), null);
  assert.equal(vn.replayableBlocks({ ...turn, provider: 'openai' }, 'openai', 'claude-x'), null);
  assert.equal(vn.replayableBlocks({ ...turn, blocks: [{ type: 'thinking', thinking: 'x', signature: 's' }] }, 'anthropic', 'claude-x'), null);   // reasoning alone is no turn
  assert.equal(vn.replayableBlocks(null, 'anthropic', 'claude-x'), null);
  assert.ok(!vn.carriesReasoning(null));
});
