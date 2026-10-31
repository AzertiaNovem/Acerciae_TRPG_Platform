import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Local protocol fixtures only: never call paid providers. The test backend needs AI_ALLOW_PRIVATE_ENDPOINTS=true
// because the fixture listens on 127.0.0.1.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const rejects = (p, status) => assert.rejects(p, e => e.status === status);
const wait = async fn => {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const x = await fn(); if (x) return x; await new Promise(r => setTimeout(r, 150)); }
  throw Error('timed out');
};

test('maintainer AI settings: separate image credentials, GPT images/edits, Anthropic and OpenAI Responses tool loops, isolation and failure handling', async () => {
  const requests = [];
  let imageFailures = 0, releaseImage;
  const fixture = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part.toString('utf8');
    const json = req.headers['content-type']?.includes('application/json') ? JSON.parse(body) : null;
    requests.push({ url: req.url, headers: req.headers, body, json });
    res.setHeader('Content-Type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    if (req.url.endsWith('/messages')) {
      const results = json.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
      if (!results.length) return send({ type: 'message', stop_reason: 'tool_use', content: [
        { type: 'text', text: 'I will check the authorized scope.' },
        { type: 'tool_use', id: 'call_scope_1', name: 'get_knowledge_scope', input: {} },
        { type: 'tool_use', id: 'call_scope_2', name: 'get_knowledge_scope', input: {} }
      ], usage: { input_tokens: 12, output_tokens: 6 } });
      return send({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ draft: '我先核对聊天中的原始证词。', used_fact_ids: [] }) }], usage: { input_tokens: 25, output_tokens: 12 } });
    }
    if (req.url.endsWith('/audio/speech')) {
      if (json?.model === 'rate-limited-tts') { res.statusCode = 429; return send({ error: { message: 'fixture rate limit' } }); }
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.end(Buffer.alloc(24000 * 2 / 2));   // half a second of 24 kHz 16-bit PCM silence
    }
    if (req.url.endsWith('/responses')) {
      // OpenAI Responses API: a function call first, then the final answer once its output comes back.
      if (!json.input.some(i => i.type === 'function_call_output')) return send({ status: 'completed', output: [
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'call_oa_1', name: 'get_knowledge_scope', arguments: '{}' }
      ], usage: { input_tokens: 10, output_tokens: 4 } });
      return send({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ draft: 'I check the original statement.', used_fact_ids: [] }) }] }], usage: { input_tokens: 20, output_tokens: 9 } });
    }
    if (req.url.endsWith('/images/generations') || req.url.endsWith('/images/edits')) {
      if (json?.model === 'held-image') await new Promise(resolve => { releaseImage = resolve; });
      if (json?.model === 'retry-image' && imageFailures++ === 0) { res.statusCode = 429; return send({ error: { message: 'fixture rate limit' } }); }
      if (json?.model === 'url-only') return send({ data: [{ url: 'http://127.0.0.1/do-not-fetch' }] });
      if (json?.model === 'bad-image') return send({ data: [{ b64_json: Buffer.from('not a raster').toString('base64') }] });
      return send({ data: [{ b64_json: png }] });
    }
    res.statusCode = 404; send({ error: 'unknown fixture path' });
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${fixture.address().port}`;
  const settingsToClear = [];
  try {
    const suffix = Math.random().toString(36).slice(2);
    const gm = await call('', 'POST', '/api/auth/register', { username: `provider_gm_${suffix}`, password: 'password', display_name: 'Provider maintainer' });
    const pl = await call('', 'POST', '/api/auth/register', { username: `provider_pl_${suffix}`, password: 'password', display_name: 'Player' });
    const server = await call(gm.token, 'POST', '/api/servers', { name: 'Provider protocol fixtures' });
    const settings = `/api/servers/${server.id}/settings`;
    settingsToClear.push([gm.token, settings]);
    const ch = (await call(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Protocol test', knowledge_mode: 'isolated' })).id;
    await call(gm.token, 'POST', `/api/channels/${ch}/members`, { username: pl.user.username, role: 'player' });
    const root = `/api/channels/${ch}/studio`;
    const imageConfig = { provider: 'gpt_image', api_base: endpoint + '/image/v1', api_key: 'image-secret-A', model: 'gpt-image-2.5-sunburst', size: '1536x1024', quality: 'low' };
    const saved = await call(gm.token, 'PUT', settings, { llm: { provider: 'anthropic', api_base: endpoint + '/anthropic/v1', api_key: 'anthropic-secret-A', model: 'fixture-claude', reasoning_effort: 'high' }, image: imageConfig });
    assert.equal(saved.llm.provider, 'anthropic'); assert.equal(saved.image.api_key_set, true);
    assert.ok(!JSON.stringify(saved).includes('secret-A'));
    const publicSettings = await call(pl.token, 'GET', settings);
    assert.equal(publicSettings.llm, undefined); assert.equal(publicSettings.image, undefined);
    await rejects(call(pl.token, 'PUT', settings, { image: imageConfig }), 403);
    await rejects(call(gm.token, 'PUT', settings, { llm: { provider: 'made-up' } }), 400);
    await rejects(call(gm.token, 'PUT', settings, { llm: { model: '' } }), 400);
    await rejects(call(gm.token, 'PUT', settings, { image: { quality: 'made-up' } }), 400);
    await rejects(call(gm.token, 'PUT', settings, { image: { api_base: 'https://user:pass@example.com/v1' } }), 400);
    const w = (await call(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
    const draft = await call(pl.token, 'POST', `/api/channels/${ch}/inspiration`, { chat_window_id: w, hint: 'Check the evidence' });
    assert.equal(draft.draft, '我先核对聊天中的原始证词。');
    assert.equal(draft.auto_sent, false);
    const anth = requests.filter(r => r.url.endsWith('/messages'));
    assert.equal(anth.length, 2); assert.equal(anth[0].headers['x-api-key'], 'anthropic-secret-A');
    assert.equal(anth[0].headers['anthropic-version'], '2023-06-01'); assert.equal(anth[0].headers.authorization, undefined);
    assert.equal(anth[0].json.model, 'fixture-claude'); assert.ok(anth[0].json.system.includes('JSON'));
    assert.equal(anth[0].json.reasoning_effort, undefined); assert.equal(anth[0].json.response_format, undefined);
    assert.ok(anth[0].json.tools.every(t => t.input_schema && !t.function));
    const answer = anth[1].json.messages.at(-1);
    assert.equal(answer.role, 'user'); assert.deepEqual(answer.content.map(b => b.tool_use_id), ['call_scope_1', 'call_scope_2']);
    assert.ok(answer.content.every(b => b.type === 'tool_result'));
    assert.equal(anth[1].json.messages.at(-2).content.filter(b => b.type === 'tool_use').length, 2);

    const style = await call(gm.token, 'POST', root + '/styles', { style_name: 'Cold harbour', art_direction: 'blue-grey', period_setting: '1926' });
    const generate = extra => call(gm.token, 'POST', root + '/images/jobs', { kind: 'background', style_profile_id: style.id, prompt: 'Empty harbour', allow_cloud: true, ...extra });
    const finish = id => wait(async () => (await call(gm.token, 'GET', root + '/images/jobs')).find(j => j.id === id && ['completed', 'failed'].includes(j.status)));
    await rejects(generate(), 403); // campaign cloud processing is off
    await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: true });
    await rejects(generate({ allow_cloud: false }), 400);
    const generated = await finish((await generate()).id);
    assert.equal(generated.status, 'completed', generated.error);
    const img = requests.find(r => r.url.endsWith('/images/generations'));
    assert.equal(img.url, '/image/v1/images/generations'); assert.equal(img.headers.authorization, 'Bearer image-secret-A');
    assert.equal(img.json.model, 'gpt-image-2.5-sunburst'); assert.equal(img.json.background, undefined); assert.equal(img.json.output_format, 'png'); assert.equal(img.json.response_format, undefined);
    assert.equal(img.json.size, '1536x1024'); assert.equal(img.json.quality, 'low'); assert.ok(img.json.prompt.includes('blue-grey'));
    assert.ok(!img.body.includes('anthropic-secret-A'));
    await call(gm.token, 'PUT', `/api/channels/${ch}/media/${generated.result_asset_id}`, { approval_status: 'approved', visibility_scope: 'channel' });
    await call(gm.token, 'PUT', root + `/styles/${style.id}`, { reference_asset_ids: [generated.result_asset_id] });
    const edited = await finish((await generate({ request_id: 'reference-edit' })).id);
    assert.equal(edited.status, 'completed', edited.error);
    const edit = requests.find(r => r.url.endsWith('/images/edits'));
    assert.ok(edit.headers['content-type'].startsWith('multipart/form-data;'));
    assert.ok(!edit.body.includes('name="background"'));
    assert.ok(edit.body.includes('name="image[]"')); assert.ok(edit.body.includes('name="prompt"')); assert.ok(!edit.body.includes('name="reference_images"'));

    // Character art belongs to the character page, not the Log Studio: it works with Studio cloud processing off.
    await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: false });
    await rejects(generate({ request_id: 'studio-off' }), 403);
    // Uploaded main portrait -> poses use /edits, including its actual PNG bytes and frozen provenance.
    const pc = await call(pl.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Reference investigator' });
    const pcRoot = `/api/channels/${ch}/characters/${pc.id}`;
    await call(pl.token, 'PUT', pcRoot + '/appearance', { asset_mode: 'generated', appearance_prompt: '' });
    await rejects(call(pl.token, 'POST', pcRoot + '/assets/generate', { slots: [], subtitles: ['SAY'], allow_cloud: true }), 400);
    const form = new FormData(); form.append('slot', 'portrait'); form.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'profile.png');
    const upload = await fetch(base + pcRoot + '/assets', { method: 'POST', headers: { Authorization: `Bearer ${pl.token}` }, body: form });
    assert.equal(upload.status, 200); const original = (await upload.json()).portrait;
    const beforePose = requests.length;
    const poses = await call(pl.token, 'POST', pcRoot + '/assets/generate', { slots: [], subtitles: ['SAY', 'FIGHT'], allow_cloud: true });
    for (const job of poses.jobs) {
      const done = await finish(job.id); assert.equal(done.status, 'completed', done.error);
      const meta = await call(pl.token, 'GET', `/api/channels/${ch}/media/${done.result_asset_id}/meta`);
      assert.equal(meta.source_reference.portrait_reference.asset_id, original.id);
      assert.equal(meta.source_reference.portrait_reference.version, original.version);
    }
    const poseRequests = requests.slice(beforePose);
    assert.equal(poseRequests.length, 2); assert.ok(poseRequests.every(r => r.url.endsWith('/images/edits')));
    assert.ok(poseRequests.every(r => r.body.includes('name="image[]"') && r.body.includes('identity_instruction')));
    for (const request of poseRequests) {
      assert.match(request.body, /name="background"\r\n\r\ntransparent\r\n/);
      assert.match(request.body, /name="output_format"\r\n\r\npng\r\n/);
      assert.match(request.body, /name="model"\r\n\r\ngpt-image-2.5-sunburst\r\n/);
      assert.match(request.body, /transparent background with a real alpha channel/);
      assert.match(request.body, /Mandatory image requirement, even if the gateway omits the background option/);
      assert.match(request.body, /alpha=0/);
      assert.ok(!request.body.includes('standee on a plain background'));
    }
    // Generating a new main portrait and poses together waits for the new portrait, not the old upload.
    await call(pl.token, 'PUT', pcRoot + '/appearance', { appearance_prompt: 'Grey coat and round spectacles' });
    const beforeBatch = requests.length;
    const batch = await call(pl.token, 'POST', pcRoot + '/assets/generate', { slots: ['portrait'], subtitles: ['IDLE', 'SCARED'], allow_cloud: true });
    assert.equal(batch.jobs.length, 3);
    const mainDone = await finish(batch.jobs[0].id); assert.equal(mainDone.status, 'completed', mainDone.error);
    for (const job of batch.jobs.slice(1)) {
      const done = await finish(job.id); assert.equal(done.status, 'completed', done.error);
      const meta = await call(pl.token, 'GET', `/api/channels/${ch}/media/${done.result_asset_id}/meta`);
      assert.equal(meta.source_reference.portrait_reference.asset_id, mainDone.result_asset_id);
      assert.notEqual(meta.source_reference.portrait_reference.asset_id, original.id);
    }
    const batchRequests = requests.slice(beforeBatch);
    assert.deepEqual(batchRequests.map(r => r.url.split('/').at(-1)), ['generations', 'edits', 'edits']);
    assert.equal(batchRequests[0].json.background, undefined);
    for (const request of batchRequests.slice(1)) assert.match(request.body, /name="background"\r\n\r\ntransparent\r\n/);

    await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: true });

    // A different server resolves its own credentials and model even inside the same worker process.
    const other = await call(gm.token, 'POST', '/api/servers', { name: 'Other provider server' });
    const otherSettings = `/api/servers/${other.id}/settings`; settingsToClear.push([gm.token, otherSettings]);
    const otherCh = (await call(gm.token, 'POST', `/api/servers/${other.id}/channels`, { name: 'Other' })).id;
    await call(gm.token, 'PUT', otherSettings, { image: { ...imageConfig, api_key: 'image-secret-B', api_base: endpoint + '/other/v1', model: 'other-image' } });
    await call(gm.token, 'PUT', `/api/channels/${otherCh}/studio/settings`, { studio_cloud_allowed: true });
    const otherStyle = await call(gm.token, 'POST', `/api/channels/${otherCh}/studio/styles`, { style_name: 'Other' });
    const otherJob = await call(gm.token, 'POST', `/api/channels/${otherCh}/studio/images/jobs`, { kind: 'background', style_profile_id: otherStyle.id, prompt: 'Other', allow_cloud: true });
    await wait(async () => (await call(gm.token, 'GET', `/api/channels/${otherCh}/studio/images/jobs`)).find(j => j.id === otherJob.id && j.status === 'completed'));
    const otherReq = requests.find(r => r.url === '/other/v1/images/generations');
    assert.equal(otherReq.headers.authorization, 'Bearer image-secret-B'); assert.equal(otherReq.json.model, 'other-image');

    await call(gm.token, 'PUT', settings, { llm: { provider: 'openai_compatible', api_base: endpoint + '/openai/v1', api_key: 'openai-secret-A', model: 'fixture-openai', reasoning_effort: '' } });
    assert.equal((await call(pl.token, 'POST', `/api/channels/${ch}/inspiration`, { chat_window_id: w })).draft, 'I check the original statement.');
    const oa = requests.filter(r => r.url === '/openai/v1/responses');
    assert.equal(oa.length, 2, 'one function call round, then the answer');
    assert.ok(!requests.some(r => r.url.endsWith('/chat/completions')), 'Chat Completions is no longer used');
    assert.equal(oa[0].headers.authorization, 'Bearer openai-secret-A'); assert.equal(oa[0].json.model, 'fixture-openai');
    assert.equal(oa[0].json.store, false); assert.ok(oa[0].json.instructions); assert.equal(oa[0].json.messages, undefined);
    assert.ok(oa[0].json.tools.every(t => t.type === 'function' && t.name && t.strict === false && !t.function));
    const replay = oa[1].json.input;
    const callAt = replay.findIndex(i => i.type === 'function_call' && i.call_id === 'call_oa_1');
    assert.ok(callAt >= 0, 'the function call is replayed');
    assert.ok(replay.slice(callAt).some(i => i.type === 'function_call_output' && i.call_id === 'call_oa_1' && typeof i.output === 'string'), 'its output follows with the same call_id');
    await call(gm.token, 'PUT', root + `/styles/${style.id}`, { reference_asset_ids: [] });
    // One running request may finish; a pending request must not move to a new provider configuration.
    await call(gm.token, 'PUT', settings, { image: { model: 'held-image' } });
    const runningJob = await generate({ request_id: 'held-first' });
    await wait(() => releaseImage);
    const pendingJob = await generate({ request_id: 'held-second' });
    await call(gm.token, 'PUT', settings, { image: { model: 'replacement-model' } });
    releaseImage(); releaseImage = null;
    assert.equal((await finish(runningJob.id)).status, 'completed');
    const stale = await finish(pendingJob.id);
    assert.equal(stale.status, 'failed'); assert.match(stale.error, /configuration changed/);
    assert.equal(requests.filter(r => r.json?.model === 'replacement-model').length, 0);
    for (const model of ['retry-image', 'url-only', 'bad-image']) {
      await call(gm.token, 'PUT', settings, { image: { model } });
      const job = await finish((await generate({ request_id: model })).id);
      assert.equal(job.status, model === 'retry-image' ? 'completed' : 'failed', job.error);
      if (model === 'retry-image') assert.equal(job.attempts, 2);
    }
    assert.ok(!requests.some(r => r.url.includes('do-not-fetch')));
    const beforeFailedPortrait = requests.length;
    const failedBatch = await call(pl.token, 'POST', pcRoot + '/assets/generate', { slots: ['portrait'], subtitles: ['ANGRY'], allow_cloud: true });
    assert.equal((await finish(failedBatch.jobs[0].id)).status, 'failed');
    const dependent = await finish(failedBatch.jobs[1].id);
    assert.equal(dependent.status, 'failed'); assert.match(dependent.error, /main portrait generation failed/);
    assert.equal(requests.slice(beforeFailedPortrait).length, 1, 'failed main portrait must not trigger text-only poses');

    // OpenAI speech: /audio/speech with gpt-4o-mini-tts by default, or any model of the same contract.
    await rejects(call(gm.token, 'PUT', settings, { tts: { provider: 'openai', clear_api_key: true } }), 400);   // needs its own key
    await call(gm.token, 'PUT', settings, { tts: { provider: 'openai', api_base: endpoint + '/openai/v1', api_key: 'speech-secret-A', model: '', voice: 'coral' } });
    await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: true });
    const ttsStatus = await call(gm.token, 'GET', root + '/tts/status');
    assert.equal(ttsStatus.provider, 'openai'); assert.equal(ttsStatus.mock, false); assert.equal(ttsStatus.official_model, 'gpt-4o-mini-tts');
    assert.equal(ttsStatus.capabilities.voice_design, false); assert.equal(ttsStatus.capabilities.voice_clone, false);
    // The Voice Studio follows the service: OpenAI offers speed, a model per voice, a spoken language and an accent.
    const f = ttsStatus.features;
    assert.equal(f.label, 'OpenAI'); assert.equal(f.voice_design, false); assert.equal(f.voice_clone, false); assert.equal(f.phoneme_dictionary, false);
    assert.deepEqual(f.params.map(p => p.key), ['speed']); assert.deepEqual(f.models, ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1']);
    assert.equal(f.dialect.label, 'Accent'); assert.ok(f.languages.some(l => l.id === 'ja'));
    assert.ok((await call(gm.token, 'GET', root + '/tts/available-voices')).some(v => v.id === 'marin'));
    await rejects(call(gm.token, 'POST', root + '/voices', { name: 'Designed', voice_type: 'design', design_prompt: 'A calm old sailor' }), 502);
    const sailor = await call(gm.token, 'POST', root + '/voices', { name: 'Sailor', voice_type: 'preset', voice_id: 'ash', language: 'en', style_instruction: 'gravelly, unhurried', synthesis_parameters: { speed: 9, pitch: 1.5 } });
    assert.equal(sailor.provider, 'openai'); assert.equal(sailor.model_id, 'gpt-4o-mini-tts');
    assert.deepEqual(sailor.synthesis_parameters, { speed: 4 }, 'only the service\'s own parameters, clamped');
    await call(gm.token, 'PUT', root + `/voices/${sailor.id}`, { synthesis_parameters: {} });   // back to the default speed
    const speak = extra => call(gm.token, 'POST', root + '/tts/preview', { voice_profile_id: sailor.id, text: 'The tide is turning.', ...extra });
    const clip = await speak({ style_instruction: 'whispered' });
    assert.equal(clip.mime, 'audio/wav'); assert.equal(clip.duration_ms, 500); assert.equal(clip.is_mock, false);
    const speech = requests.filter(r => r.url === '/openai/v1/audio/speech');
    assert.equal(speech.length, 1); assert.equal(speech[0].headers.authorization, 'Bearer speech-secret-A');
    assert.deepEqual(speech[0].json, { model: 'gpt-4o-mini-tts', input: 'The tide is turning.', voice: 'ash', response_format: 'pcm', instructions: 'Speak in English. gravelly, unhurried; whispered' });
    await speak({ style_instruction: 'whispered' });   // cached: no second call
    assert.equal(requests.filter(r => r.url === '/openai/v1/audio/speech').length, 1);
    await speak({ model_id: 'tts-1-hd', text: 'Older model.' });   // the same contract; tts-1 models take no instructions
    assert.deepEqual(requests.filter(r => r.url === '/openai/v1/audio/speech').at(-1).json, { model: 'tts-1-hd', input: 'Older model.', voice: 'ash', response_format: 'pcm' });
    await rejects(speak({ model_id: 'rate-limited-tts', text: 'Busy.' }), 502);
    await call(gm.token, 'PUT', settings, { tts: { provider: 'mock', clear_api_key: true } });

    await call(gm.token, 'PUT', settings, { image: { provider: 'disabled' } });
    assert.equal((await call(gm.token, 'GET', root + '/images/status')).enabled, false);
    await rejects(generate(), 400);
    // A live image provider needs its own key: there is no other credential to borrow.
    await rejects(call(gm.token, 'PUT', settings, { image: { provider: 'gpt_image', clear_api_key: true } }), 400);
    assert.equal((await call(gm.token, 'GET', root + '/images/status')).enabled, false);
    await rejects(generate(), 400);
    await call(gm.token, 'PUT', settings, { image: { provider: 'mock' } });
    assert.equal((await call(gm.token, 'GET', root + '/images/status')).mock, true);
    await rejects(call(gm.token, 'PUT', settings, { llm: { clear_api_key: true } }), 400);   // still Anthropic: a key is required
    await call(gm.token, 'PUT', settings, { llm: { provider: 'mock', clear_api_key: true } });
    const cleared = await call(gm.token, 'GET', settings);
    assert.equal(cleared.llm.api_key_set, false); assert.equal(cleared.llm_mode, 'mock');
  } finally {
    if (releaseImage) releaseImage();
    for (const [token, path] of settingsToClear) await call(token, 'PUT', path, { llm: { provider: 'mock', clear_api_key: true }, image: { provider: 'disabled', clear_api_key: true } }).catch(() => {});
    fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
  }
});
