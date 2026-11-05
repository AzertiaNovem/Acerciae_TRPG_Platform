const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const source = esbuild.buildSync({ stdin: { contents: "export * from './hybrid'; export * from './hybridImport'; export * from './actions'; export { bundleFiles } from './vn';", resolveDir: path.join(__dirname, '../src/openstudio'), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent' });
const mod = { exports: {} }; new Function('module', 'exports', 'require', source.outputFiles[0].text)(mod, mod.exports, require);
const H = mod.exports;
const image = Uint8Array.from([137, 80, 78, 71]);
const hash = require('node:crypto').createHash('sha256').update(image).digest('hex');
function fixture() {
  return { format: 'acerciae-hybrid-vn-1', era: '1920',
    assets: [{ key: 'portrait@1', id: 'portrait', version: 1, mime: 'image/png', hash }, { key: 'bg@1', id: 'bg', version: 1, mime: 'image/png', hash }],
    characters: [{ id: 'c1', name: 'Ada', kind: 'pc', appearance_prompt: 'red coat', portrait: 'portrait@1' }, { id: 'c2', name: 'Ada', kind: 'npc', appearance_prompt: 'blue coat', portrait: null }],
    voices: [{ id: 'v1', character_id: 'c1', voice_id: 'alloy', provider: 'openai', voice_type: 'preset', language: 'zh', style_instruction: 'quiet', synthesis_parameters: { speed: 0.9 } }], cast: { c1: 'v1' },
    asset_needs: [{ kind: 'standee', character_id: 'c1', subtitle: 'SAY', brief: 'raise a lantern' }],
    presentation: { id: 'pres1', title: 'A local story', snapshot_scope: 'character', template: { base: 'adv', character_colors: { c1: '#112233' } },
      scenes: [{ id: 's1', title: 'Harbour', canonical_scene_key: 'harbour', background: 'bg@1', background_brief: 'docks', environment: { effect: 'fog' } }, { id: 's2', title: 'House', canonical_scene_key: 'house', background: null, background_brief: 'old house', environment: {} }],
      events: [1, 2, 3].map((n) => ({ id: 'e' + n, scene_id: n === 3 ? 's2' : 's1', hidden: n === 2, display_kind: 'dialogue', content: 'original ' + n, display_text: 'server edit ' + n, tts_text: n === 1 ? 'pronounced line' : null,
        speaker_character_id: n === 3 ? 'c2' : 'c1', speaker_display_name: 'Ada', speaker_role: 'pc', dice: null, style_instruction: 'slowly', effect: 'none', voice_profile_id: n === 1 ? 'v1' : null,
        stage: [{ character_id: 'c1', expression: 'SAY', position: 'center', image: null }] })) } };
}

test('hybrid keeps server edits, hidden lines, distinct cast identities, pose directions and local export paths', () => {
  const p = H.hybridProject(fixture(), 'p', new Map([['portrait@1', 'assets/portrait.png'], ['bg@1', 'assets/bg.png']]));
  assert.deepEqual(p.characters.map(c => c.name), ['Ada', 'Ada (2)']);
  assert.equal(p.vn.script.scenes[0].lines[0].text, 'server edit 1');
  assert.equal(p.vn.script.scenes[0].lines[1].hidden, true);
  assert.equal(p.events[0].content, 'original 1');
  assert.equal(p.vn.script.scenes[1].lines[0].speaker, 'Ada (2)');
  assert.deepEqual(H.openNeeds(p).map(n => n.kind), ['background', 'standee']);
  assert.equal(H.openNeeds(p)[1].brief, 'raise a lantern');
  assert.deepEqual(p.vn.template.character_colors, { Ada: '#112233' });
  const jobs = H.voiceJobs(p); assert.equal(jobs.length, 1);
  assert.equal(jobs[0].text, 'pronounced line'); assert.equal(jobs[0].config.synthesis_parameters.speed, 0.9);
  assert.equal(jobs[0].delivery, 'quiet; slowly');
  H.applyCharacterArt(p, 'Ada', { kind: 'pose', subtitle: 'SAY' }, 'assets/say.png');
  H.applyBackground(p, 's2', 'assets/house.png');
  H.applyVoice(p, 1, { path: 'assets/voice.wav', ms: 1200 });
  assert.equal(H.openNeeds(p).length, 0); assert.equal(H.voiceJobs(p).length, 0, 'retries reuse completed media');
  const files = H.bundleFiles(p, p.vn.script, p.vn.template, p.vn.audio);
  assert.ok(files.some(f => f.asset === 'assets/say.png')); assert.ok(files.some(f => f.asset === 'assets/voice.wav'));
  assert.ok(!JSON.stringify(files).includes('token='));
  H.setLocalVoice(p, 'Ada', 'nova');
  assert.equal(p.vn.audio[1], undefined); assert.equal(H.voiceJobs(p)[0].voice, 'nova'); assert.equal(H.voiceJobs(p)[0].config, undefined);
});

test('existing exact poses are reused and no generation is planned for hidden-only poses', () => {
  const f = fixture(); f.presentation.events[0].stage[0].image = 'portrait@1'; f.presentation.events[1].stage[0].expression = 'HIDDEN';
  const p = H.hybridProject(f, 'p', new Map([['portrait@1', 'assets/say.png'], ['bg@1', 'assets/bg.png']]));
  assert.equal(H.openNeeds(p).filter(n => n.kind === 'standee').length, 0);
  f.presentation.events[0].stage[0].expression = 'default';
  const d = H.hybridProject(f, 'p', new Map([['portrait@1', 'assets/default.png'], ['bg@1', 'assets/bg.png']]));
  d.characters[0].portrait = 'assets/main.png';
  const script = H.bundleFiles(d, d.vn.script, d.vn.template, {}).find(f => f.path === 'script.json').content;
  assert.ok(script.includes('assets/default.png'), 'the imported default pose is displayed instead of the main portrait');
});

test('import downloads and stores equal content once, verifies the digest, and saves only local paths', async () => {
  let downloads = 0, writes = 0, saved;
  const p = await H.importHybridManifest(fixture(), { download: async () => { downloads++; return image; }, write: async () => { writes++; return 'assets/same.png'; }, save: async p => { saved = p; }, remove: async () => assert.fail('must not remove success') }, new AbortController().signal, () => {}, 'p');
  assert.equal(downloads, 1); assert.equal(writes, 1); assert.equal(saved, p);
  assert.equal(p.characters[0].portrait, p.vn.script.scenes[0].background);
});

test('bad checksum and cancellation discard only the unfinished new local project', async () => {
  let removed = [], saved = 0, written = 0;
  const io = { download: async () => Uint8Array.from([1]), write: async () => { written++; return 'bad'; }, save: async () => saved++, remove: async id => removed.push(id) };
  await assert.rejects(H.importHybridManifest(fixture(), io, new AbortController().signal, () => {}, 'new'), /checksum/);
  const c = new AbortController(); c.abort();
  await assert.rejects(H.importHybridManifest(fixture(), io, c.signal, () => {}, 'cancelled'));
  assert.deepEqual(removed, ['new', 'cancelled']); assert.equal(saved, 0); assert.equal(written, 0);
});
