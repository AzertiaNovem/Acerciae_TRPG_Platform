// Desktop bridge fixture: the real VN wizard, import, local workspace and folder export; no paid provider calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
const site = process.env.WEB_BASE || 'http://127.0.0.1:5197';
if (!['localhost', '127.0.0.1'].includes(new URL(site).hostname)) throw Error('Use a local fixture');
const engine = process.argv[2] || 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: process.env.CHROME_CHANNEL });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const projects = new Map(), assets = new Map(); const mutations = [], aiCalls = []; let exported, bucketReads = 0;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const reference = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>');
  const hash = createHash('sha256').update(reference).digest('hex');
  await context.exposeBinding('hybridBridge', (_, command, args, options) => {
    if (command === 'project_save') { projects.set(args.id, { data: args.data, meta: args.meta }); return; }
    if (command === 'project_load') return projects.get(args.id)?.data;
    if (command === 'project_list') return [...projects.values()].map(p => p.meta);
    if (command === 'project_delete') return projects.delete(args.id);
    if (command === 'plugin:dialog|open') return '/tmp/hybrid-export-fixture';
    if (command === 'export_files') { exported = args; return { dir: '/tmp/hybrid-export-fixture/story', written: args.files.length, skipped: 0, failed: [] }; }
    if (command === 'secret_get') return 'local-fixture-key';
    if (command === 'asset_write') { const path = `assets/${assets.size + 1}.${options.headers['x-ext']}`; assets.set(path, Buffer.from(Object.values(args))); return path; }
    if (command === 'asset_read') return [...assets.get(args.path)];
    if (command === 'asset_path') return args.path;
    return null;
  });
  await context.addInitScript(() => {
    localStorage.setItem('acerciae.server_url', 'https://hybrid.test');
    localStorage.setItem('acerciae.ui-language', 'en');
    localStorage.setItem('acerciae.openstudio.ai', JSON.stringify({ parallel: 2,
      image: { provider: 'openai', base_url: 'https://local-ai.test/v1', model: 'fixture-image', size: '1024x1536', quality: 'auto' },
      tts: { provider: 'openai', base_url: 'https://local-ai.test/v1', model: 'fixture-speech', language: 'en' } }));
    window.__TAURI_INTERNALS__ = { invoke: window.hybridBridge, convertFileSrc: path => 'https://local-assets.test/' + path,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } };
  });
  // Keep all network traffic inside Playwright, including the native HTTP module's boundary.
  await context.route('**/node_modules/.vite/deps/@tauri-apps_plugin-http.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export const fetch = globalThis.fetch.bind(globalThis);' }));
  await context.routeWebSocket(/ws:\/\/(localhost|127\.0\.0\.1):5197\//, () => {});
  await context.route('https://bucket.test/**', async route => { bucketReads++; assert.equal(route.request().headers().authorization, undefined); await route.fulfill({ contentType: 'image/svg+xml', body: reference }); });
  await context.route('https://local-assets.test/**', route => route.fulfill({ contentType: 'image/png', body: assets.get(new URL(route.request().url()).pathname.slice(1)) || png }));
  await context.route('https://local-ai.test/**', async route => {
    const req = route.request(); aiCalls.push({ path: new URL(req.url()).pathname, body: req.postData(), auth: req.headers().authorization });
    if (req.url().endsWith('/audio/speech')) {
      const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
      return route.fulfill({ contentType: 'audio/wav', body: wav });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) });
  });
  const scene = { id: 's1', title: 'Harbour', canonical_scene_key: 'harbour', background: 'bg@1', background_brief: 'harbour', environment: {} };
  const event = { id: 'e1', scene_id: 's1', hidden: false, display_kind: 'narration', content: 'original', display_text: 'Server-edited story', speaker_character_id: null, speaker_display_name: 'Keeper', speaker_role: 'gm', style_instruction: '', effect: 'none', voice_profile_id: null, dice: null, stage: [] };
  const job = { id: 'j1', status: 'completed', title: 'Hybrid story', created_at: '2026-11-05T00:00:00Z', presentation_id: 'p1', params: { media_mode: 'hybrid' } };
  const manifest = { format: 'acerciae-hybrid-vn-1', era: '1920',
    assets: ['portrait', 'bg'].map(id => ({ key: id + '@1', id, version: 1, mime: 'image/svg+xml', hash })),
    characters: [{ id: 'c1', name: 'Ada', kind: 'pc', appearance_prompt: 'red coat', portrait: 'portrait@1' }],
    voices: [{ id: 'v1', character_id: 'c1', provider: 'openai', voice_id: 'alloy', language: 'zh', style_instruction: 'quiet', synthesis_parameters: { speed: 0.8 } }],
    cast: { c1: 'v1' }, asset_needs: [{ kind: 'standee', character_id: 'c1', subtitle: 'SAY', brief: 'raise a lantern' }],
    presentation: { id: 'p1', title: 'Hybrid story', snapshot_scope: 'gm_full', template: {},
      scenes: [scene, { ...scene, id: 's2', title: 'House', background: null }],
      events: [event, { ...event, id: 'e2', scene_id: 's2', display_kind: 'dialogue', speaker_role: 'pc', speaker_character_id: 'c1', speaker_display_name: 'Ada',
        stage: [{ character_id: 'c1', expression: 'SAY', position: 'center', image: null }] }] } };
  let created = false;
  await context.route('https://hybrid.test/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname; let body = [];
    if (req.method() !== 'GET') mutations.push({ path, body: req.postDataJSON() });
    if (path.includes('/media/')) {
      assert.equal(req.headers().authorization, 'Bearer fixture');
      return route.fulfill({ contentType: 'application/vnd.acerciae.direct+json', body: JSON.stringify({ url: 'https://bucket.test/reference.svg' }) });
    }
    if (path.endsWith('/vn-scripts/status')) body = { mock: true, model: 'mock', retry_failed_chunks: true };
    else if (path.endsWith('/vn-scripts/windows')) body = { windows: [{ id: 'w1', name: 'Harbour', line_count: 1 }] };
    else if (path.endsWith('/vn-scripts') && req.method() === 'POST') { created = true; body = job; }
    else if (path.endsWith('/vn-scripts')) body = created ? [job] : [];
    else if (path.endsWith('/vn-scripts/j1')) body = job;
    else if (path.endsWith('/presentations/p1/hybrid')) body = manifest;
    else if (path.endsWith('/presentations/p1')) body = { id: 'p1', settings: { media_mode: 'hybrid' }, scenes: [], events: [], can_edit: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await context.route(site + '/', route => route.fulfill({ contentType: 'text/html', body: `<html><head><link rel="stylesheet" href="/src/styles/app.css"></head><body><div id="test-root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>t=>t; window.__vite_plugin_react_preamble_installed__=true;
    const React=(await import('/node_modules/.vite/deps/react.js')).default;
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const {useNav}=await import('/src/store/nav.ts'); const {setToken}=await import('/src/api/client.ts'); setToken('fixture');
    useNav.setState({channelId:'ch1',channel:{id:'ch1',my_role:'gm'},characters:[]});
    const Wizard=(await import('/src/components/studio/VnWizard.tsx')).default;
    const Studio=(await import('/src/openstudio/ui/OpenLogStudio.tsx')).default;
    const {useOpenStudio}=await import('/src/openstudio/ui/state.ts');
    function Harness(){const open=useOpenStudio(s=>s.open);return React.createElement(open?Studio:Wizard,{onOpenEditor:()=>{}})}
    createRoot(document.getElementById('test-root')).render(React.createElement(Harness));
  </script></body></html>` }));
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', e => { if (e.type() === 'error') console.error(e.text()); });
  await page.goto(site);
  await page.getByLabel('Hybrid: server script, local art and voices').check();
  await page.getByRole('button', { name: 'Write the script', exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByTestId('hybrid-vn-transfer').waitFor();
  assert.equal(mutations[0].body.media_mode, 'hybrid');
  assert.equal(await page.getByRole('button', { name: 'Apply cast and voice every line' }).count(), 0);
  await page.getByRole('button', { name: 'Continue in the local studio' }).click();
  await page.getByText('Hybrid · server script ready', { exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const { useTasks } = await import('/src/openstudio/tasks.ts');
    const all = useTasks.getState().tasks; return all.length === 2 && all.every(t => t.status === 'done' && !t.failures.length);
  });
  await page.evaluate(async () => { const { flushProject, useProjects } = await import('/src/openstudio/projects.ts'); for (const id of Object.keys(useProjects.getState().projects)) await flushProject(id); });
  assert.equal(projects.size, 1); const saved = JSON.parse([...projects.values()][0].data);
  assert.equal(saved.vn.script.scenes[0].lines[0].text, 'Server-edited story');
  assert.equal(saved.characters[0].portrait, saved.vn.script.scenes[0].background, 'equal existing content is stored once');
  assert.match(saved.characters[0].portrait, /\.png$/); assert.equal(bucketReads, 1);
  assert.ok(saved.characters[0].poses.SAY); assert.ok(saved.vn.script.scenes[1].background); assert.ok(saved.vn.audio[2]);
  assert.equal(aiCalls.length, 3); assert.ok(aiCalls.every(c => c.auth === 'Bearer local-fixture-key'));
  const speech = JSON.parse(aiCalls.find(c => c.path.endsWith('/audio/speech')).body);
  assert.equal(speech.model, 'fixture-speech'); assert.equal(speech.voice, 'alloy'); assert.equal(speech.speed, 0.8);
  assert.match(speech.instructions, /Mandarin Chinese.*quiet/);
  const edit = aiCalls.find(c => c.path.endsWith('/images/edits'));
  assert.match(edit.body, /raise a lantern/); assert.match(edit.body, /transparent/); assert.match(edit.body, /image\/png/);
  assert.equal(await page.getByRole('button', { name: 'Compose again', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Save as a folder (player)…', exact: true }).click();
  await page.waitForTimeout(300);
  assert.ok(exported?.files.some(f => f.path === 'index.html')); assert.ok(exported.files.some(f => f.path === 'script.json'));
  assert.equal(exported.files.filter(f => f.asset).length, 4, 'existing art, new background, pose and voice are in the local export');
  assert.equal(mutations.length, 1, 'only the script is requested from the platform');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `/tmp/acerciae-hybrid-${engine}.png`, fullPage: true });
  await page.getByText('Hybrid · server script ready', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/acerciae-hybrid-controls-${engine}.png`, fullPage: true });
  console.log(`${engine}: desktop hybrid selection, direct hash-checked import, local images/voice and folder export passed`);
} finally { await browser.close(); }
