import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Providers and model uses: a server adds providers of several kinds and assigns each use a provider that can do it.
// Local protocol fixtures only (the backend runs with AI_ALLOW_PRIVATE_ENDPOINTS=true); never a paid provider.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, data });
  return data;
}
const rejects = (p, status) => assert.rejects(p, e => e.status === status);
const wait = async fn => {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const x = await fn(); if (x) return x; await new Promise(r => setTimeout(r, 150)); }
  throw Error('timed out');
};
const sse = events => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

test('providers and model uses: capability limits, Chat Completions, Stability, Gemini edits and Doubao speech', async () => {
  const requests = [];
  const fixture = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const raw = Buffer.concat(chunks);
    const json = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw.toString('utf8')) : null;
    requests.push({ url: req.url, headers: req.headers, body: raw.toString('latin1'), json });
    const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/openai/v1/chat/completions') {
      // Streamed Chat Completions: a tool call split over chunks first, then the final JSON answer.
      res.setHeader('Content-Type', 'text/event-stream');
      if (!json.messages.some(m => m.role === 'tool')) return res.end(sse([
        { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_knowledge_scope', arguments: '{' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }, '[DONE]']));
      const answer = JSON.stringify({ options: [{ text: 'I read the ledger twice.', kind: 'ic', roll: '', angle: 'careful' }, { text: '"Who signed this?"', kind: 'ic', roll: '', angle: 'direct' }], used_fact_ids: [] });
      return res.end(sse([{ choices: [{ delta: { content: answer.slice(0, 20) } }] }, { choices: [{ delta: { content: answer.slice(20) }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } }, '[DONE]']));
    }
    if (req.url === '/stability/v2beta/stable-image/generate/sd3') return send({ image: png, finish_reason: 'SUCCESS', seed: 1 });
    if (req.url === '/google/v1beta/interactions') {
      if (json.response_format?.type === 'audio') return send({ id: 'a1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16', sample_rate: 24000, data: Buffer.alloc(9600).toString('base64') }] }] });
      return send({ id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: png }] }] });
    }
    if (req.url === '/openrouter/v1/images') return send({ created: 1, data: [{ b64_json: png, media_type: 'image/png' }] });
    if (req.url === '/volc/api/v3/images/generations') return send({ created: 1, data: [{ b64_json: png, size: '2048x2048' }] });
    if (req.url === '/bedrock/model/stability.sd3-5-large-v1%3A0/invoke') return send({ seeds: [1], finish_reasons: [null], images: [png] });
    if (req.url === '/polly/v1/speech') { res.setHeader('Content-Type', 'audio/pcm'); return res.end(Buffer.alloc(3200)); }
    if (req.url.startsWith('/polly/v1/voices')) return send({ Voices: [{ Id: 'Joanna', Name: 'Joanna', Gender: 'Female', LanguageCode: 'en-US', LanguageName: 'US English' }] });
    if (req.url === '/volc/api/v3/tts/unidirectional') {
      // Back-to-back JSON objects: base64 PCM chunks, then the final code.
      const pcm = Buffer.alloc(4800).toString('base64');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ code: 0, message: '', data: pcm }) + JSON.stringify({ code: 0, message: '', data: pcm }) + JSON.stringify({ code: 20000000, message: 'ok', data: null }));
    }
    res.statusCode = 404; send({ error: 'unknown fixture path ' + req.url });
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${fixture.address().port}`;
  try {
    const suffix = Math.random().toString(36).slice(2);
    const gm = await call('', 'POST', '/api/auth/register', { username: `kinds_gm_${suffix}`, password: 'password', display_name: 'Maintainer' });
    const pl = await call('', 'POST', '/api/auth/register', { username: `kinds_pl_${suffix}`, password: 'password', display_name: 'Player' });
    const server = await call(gm.token, 'POST', '/api/servers', { name: 'Provider kinds' });
    const ch = (await call(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Kinds', knowledge_mode: 'isolated' })).id;
    await call(gm.token, 'POST', `/api/channels/${ch}/members`, { username: pl.user.username, role: 'player' });
    const ai = `/api/servers/${server.id}/ai`;

    // The catalog: nine kinds, each with its capabilities.
    const catalog = await call(pl.token, 'GET', '/api/ai/catalog');
    assert.deepEqual(catalog.kinds.map(k => k.id).sort(), ['alibaba', 'anthropic', 'aws', 'google', 'openai', 'openrouter', 'responses', 'stability', 'volcengine']);
    assert.deepEqual(catalog.kinds.find(k => k.id === 'stability').capabilities, ['image_generation', 'image_edit']);
    await rejects(call(pl.token, 'GET', ai), 403);

    // Providers: required fields per kind, secrets never returned, the kind fixed once created.
    await rejects(call(pl.token, 'POST', ai + '/providers', { kind: 'openai', name: 'X', api_key: 'k' }), 403);
    await rejects(call(gm.token, 'POST', ai + '/providers', { kind: 'nope', name: 'X', api_key: 'k' }), 400);
    await rejects(call(gm.token, 'POST', ai + '/providers', { kind: 'openai', name: 'No key' }), 400);
    await rejects(call(gm.token, 'POST', ai + '/providers', { kind: 'aws', name: 'AWS', api_key: 'secret' }), 400);   // region and access key id
    await rejects(call(gm.token, 'POST', ai + '/providers', { kind: 'openai', name: 'Odd', api_key: 'k', options: { region: 'x' } }), 400);
    await rejects(call(gm.token, 'POST', ai + '/providers', { kind: 'openai', name: 'Bad URL', api_key: 'k', api_base: 'https://user:pass@example.com/v1' }), 400);
    const gateway = await call(gm.token, 'POST', ai + '/providers', { kind: 'openai', name: 'Gateway', api_base: endpoint + '/openai/v1', api_key: 'chat-secret-A' });
    assert.equal(gateway.api_key_set, true); assert.ok(!JSON.stringify(gateway).includes('secret-A'));
    await rejects(call(gm.token, 'POST', ai + '/providers', { kind: 'anthropic', name: 'Gateway', api_key: 'k' }), 409);
    await rejects(call(gm.token, 'PUT', `${ai}/providers/${gateway.id}`, { kind: 'anthropic' }), 400);
    const stability = await call(gm.token, 'POST', ai + '/providers', { kind: 'stability', name: 'Stability', api_base: endpoint + '/stability', api_key: 'stability-secret-B' });
    const google = await call(gm.token, 'POST', ai + '/providers', { kind: 'google', name: 'Gemini', api_base: endpoint + '/google/v1beta', api_key: 'google-secret-C' });
    const volc = await call(gm.token, 'POST', ai + '/providers', { kind: 'volcengine', name: 'Volcano', api_base: endpoint + '/volc/api/v3', api_key: 'ark-secret-D',
      options: { speech_endpoint: endpoint + '/volc' }, secrets: { speech_api_key: 'speech-secret-E' } });
    assert.equal(volc.secrets.speech_api_key.set, true); assert.equal(volc.options.speech_endpoint, endpoint + '/volc');
    const aws = await call(gm.token, 'POST', ai + '/providers', { kind: 'aws', name: 'AWS', api_key: 'aws-secret-F', api_base: endpoint + '/bedrock',
      options: { region: 'us-west-2', access_key_id: 'AKIDTEST', polly_endpoint: endpoint + '/polly' }, secrets: { session_token: 'tok' } });
    const router = await call(gm.token, 'POST', ai + '/providers', { kind: 'openrouter', name: 'Router', api_base: endpoint + '/openrouter/v1', api_key: 'router-secret-G' });
    assert.ok(!JSON.stringify(await call(gm.token, 'GET', ai)).match(/secret-[A-F]|tok"/));

    // Uses only take providers that can do them.
    await rejects(call(gm.token, 'PUT', ai + '/uses', { uses: { text: { provider: stability.id, model: 'sd3.5-large' } } }), 400);
    await rejects(call(gm.token, 'PUT', ai + '/uses', { uses: { embedding: { provider: volc.id, model: 'x' } } }), 400);
    await rejects(call(gm.token, 'PUT', ai + '/uses', { uses: { tts: { provider: google.id, model: '' } } }), 400);   // a model is required
    await rejects(call(gm.token, 'PUT', ai + '/uses', { uses: { text: { provider: 'disabled' } } }), 400);   // text is mock or a provider
    await rejects(call(gm.token, 'PUT', ai + '/uses', { uses: { image_generation: { provider: stability.id, model: 'sd3.5-large', options: { voice: 'x' } } } }), 400);
    const uses = await call(gm.token, 'PUT', ai + '/uses', { uses: {
      text: { provider: 'mock' },
      text_assist: { provider: gateway.id, model: 'fixture-chat' },
      embedding: { provider: aws.id, model: 'amazon.titan-embed-text-v2:0' },
      image_generation: { provider: stability.id, model: 'sd3.5-large', options: { size: '1536x1024' } },
      image_edit: { provider: google.id, model: 'gemini-nano-banana-2.1' },
      tts: { provider: volc.id, model: 'seed-tts-2.0', options: { voice: 'zh_female_vv_uranus_bigtts' } } } });
    assert.equal(uses.uses.text_assist.provider, gateway.id); assert.equal(uses.uses.text_chronicle.provider, 'inherit');
    assert.deepEqual(uses.providers.find(p => p.id === stability.id).used_by, ['image_generation']);

    // Text: player assists run on the gateway through streamed Chat Completions, tool round included; other text stays mock.
    const settings = `/api/servers/${server.id}/settings`;
    const pub = await call(pl.token, 'GET', settings);
    assert.equal(pub.llm_mode, 'mock'); assert.equal(pub.images_enabled, true); assert.equal(pub.ai, undefined);
    const w = (await call(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
    const idea = await call(pl.token, 'POST', `/api/channels/${ch}/inspiration`, { chat_window_id: w, hint: 'Check the ledger' });
    assert.equal(idea.llm_mode, 'live'); assert.equal(idea.options[0].text, 'I read the ledger twice.');
    const chat = requests.filter(r => r.url === '/openai/v1/chat/completions');
    assert.equal(chat.length, 2);
    assert.equal(chat[0].headers.authorization, 'Bearer chat-secret-A');
    assert.equal(chat[0].json.model, 'fixture-chat'); assert.equal(chat[0].json.stream, true); assert.ok(chat[0].json.max_completion_tokens > 0);
    assert.ok(chat[0].json.tools.some(t => t.function.name === 'get_knowledge_scope'));
    const toolTurn = chat[1].json.messages;
    assert.equal(toolTurn.find(m => m.tool_calls)?.tool_calls[0].function.arguments, '{}');
    assert.equal(toolTurn.find(m => m.role === 'tool').tool_call_id, 'call_1');

    // Images: generation on Stability (multipart), a reference request on Gemini (the editing use).
    const root = `/api/channels/${ch}/studio`;
    await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: true });
    const style = await call(gm.token, 'POST', root + '/styles', { style_name: 'Ledger room', art_direction: 'sepia', period_setting: '1920s' });
    const generate = extra => call(gm.token, 'POST', root + '/images/jobs', { kind: 'background', style_profile_id: style.id, prompt: 'A quiet counting house', allow_cloud: true, ...extra });
    const finish = id => wait(async () => (await call(gm.token, 'GET', root + '/images/jobs')).find(j => j.id === id && ['completed', 'failed'].includes(j.status)));
    const generated = await finish((await generate()).id);
    assert.equal(generated.status, 'completed', JSON.stringify(generated));
    const sd3 = requests.find(r => r.url === '/stability/v2beta/stable-image/generate/sd3');
    assert.equal(sd3.headers.authorization, 'Bearer stability-secret-B'); assert.equal(sd3.headers.accept, 'application/json');
    assert.match(sd3.body, /name="model"\r\n\r\nsd3\.5-large/); assert.match(sd3.body, /name="aspect_ratio"\r\n\r\n3:2/); assert.match(sd3.body, /A quiet counting house/);
    await call(gm.token, 'PUT', `/api/channels/${ch}/media/${generated.result_asset_id}`, { approval_status: 'approved', visibility_scope: 'channel' });
    await call(gm.token, 'PUT', root + `/styles/${style.id}`, { reference_asset_ids: [generated.result_asset_id] });
    const edited = await finish((await generate({ request_id: 'with-reference' })).id);
    assert.equal(edited.status, 'completed', JSON.stringify(edited));
    const gemini = requests.find(r => r.url === '/google/v1beta/interactions');
    assert.equal(gemini.headers['x-goog-api-key'], 'google-secret-C');
    assert.equal(gemini.json.model, 'gemini-nano-banana-2.1'); assert.equal(gemini.json.response_format.type, 'image');
    assert.ok(gemini.json.input.some(i => i.type === 'image' && i.mime_type === 'image/png' && i.data.length > 0));

    // Speech: Doubao V3 with the speech key; chunks joined into one WAV.
    const ttsStatus = await call(gm.token, 'GET', root + '/tts/status');
    assert.equal(ttsStatus.provider, 'volcengine'); assert.equal(ttsStatus.mock, false); assert.equal(ttsStatus.official_model, 'seed-tts-2.0');
    const voice = await call(gm.token, 'POST', root + '/voices', { name: 'Clerk', voice_type: 'preset', voice_id: 'zh_female_vv_uranus_bigtts', language: 'zh' });
    await call(gm.token, 'POST', root + '/tts/preview', { voice_profile_id: voice.id, text: '账本上有一个陌生的签名。' });
    const speech = requests.find(r => r.url === '/volc/api/v3/tts/unidirectional');
    assert.equal(speech.headers['x-api-key'], 'speech-secret-E'); assert.equal(speech.headers['x-api-resource-id'], 'seed-tts-2.0');
    assert.equal(speech.json.req_params.speaker, 'zh_female_vv_uranus_bigtts'); assert.equal(speech.json.req_params.audio_params.format, 'pcm');

    // The other image kinds: OpenRouter's Images endpoint, Seedream, Stability on Bedrock (SigV4).
    const plainStyle = await call(gm.token, 'POST', root + '/styles', { style_name: 'Plain room', art_direction: 'ink', period_setting: '1920s' });
    for (const [provider, model, path] of [[router, 'google/gemini-nano-banana-2.1', '/openrouter/v1/images'], [volc, 'doubao-seedream-4-5-251128', '/volc/api/v3/images/generations'],
                                            [aws, 'stability.sd3-5-large-v1:0', '/bedrock/model/stability.sd3-5-large-v1%3A0/invoke']]) {
      await call(gm.token, 'PUT', ai + '/uses', { uses: { image_generation: { provider: provider.id, model } } });   // the size option (1536x1024) stays
      const job = await finish((await generate({ request_id: 'kind-' + provider.kind, style_profile_id: plainStyle.id })).id);
      assert.equal(job.status, 'completed', `${provider.kind}: ${job.error}`);
      const hit = requests.filter(r => r.url === path).at(-1);
      assert.ok(hit, provider.kind);
      if (provider.kind === 'openrouter') { assert.equal(hit.headers.authorization, 'Bearer router-secret-G'); assert.equal(hit.json.model, model); assert.equal(hit.json.aspect_ratio, '3:2'); }
      if (provider.kind === 'volcengine') { assert.equal(hit.headers.authorization, 'Bearer ark-secret-D'); assert.equal(hit.json.response_format, 'b64_json'); assert.equal(hit.json.watermark, false); }
      if (provider.kind === 'aws') {
        assert.match(hit.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
        assert.equal(hit.headers['x-amz-security-token'], 'tok'); assert.equal(hit.json.mode, 'text-to-image'); assert.equal(hit.json.aspect_ratio, '3:2');
      }
    }
    // Speech on Gemini (Interactions, 24 kHz PCM) and Polly (SigV4, the model is the engine).
    await call(gm.token, 'PUT', ai + '/uses', { uses: { tts: { provider: google.id, model: 'gemini-3.8-flash-tts', options: { voice: 'Kore' } } } });
    assert.equal((await call(gm.token, 'GET', root + '/tts/status')).provider, 'google');
    const narrator = await call(gm.token, 'POST', root + '/voices', { name: 'Narrator', voice_type: 'preset', voice_id: 'Puck', language: 'en', style_instruction: 'hushed' });
    await call(gm.token, 'POST', root + '/tts/preview', { voice_profile_id: narrator.id, text: 'The ledger was older than the bank.' });
    const geminiSpeech = requests.filter(r => r.url === '/google/v1beta/interactions' && r.json?.response_format?.type === 'audio').at(-1);
    assert.equal(geminiSpeech.json.generation_config.speech_config[0].voice, 'Puck'); assert.equal(geminiSpeech.json.response_format.mime_type, 'audio/l16');
    await call(gm.token, 'PUT', ai + '/uses', { uses: { tts: { provider: aws.id, model: 'neural', options: { voice: 'Joanna' } } } });
    assert.ok((await call(gm.token, 'GET', root + '/tts/available-voices')).some(v => v.id === 'Joanna'));
    const reader = await call(gm.token, 'POST', root + '/voices', { name: 'Reader', voice_type: 'preset', voice_id: 'Joanna', language: 'en' });
    await call(gm.token, 'POST', root + '/tts/preview', { voice_profile_id: reader.id, text: 'Closing time.' });
    const polly = requests.filter(r => r.url === '/polly/v1/speech').at(-1);
    assert.match(polly.headers.authorization, /Credential=AKIDTEST\/\d{8}\/us-west-2\/polly\/aws4_request/);
    assert.deepEqual({ ...polly.json }, { Text: 'Closing time.', TextType: 'text', OutputFormat: 'pcm', SampleRate: '16000', VoiceId: 'Joanna', Engine: 'neural' });
    await call(gm.token, 'PUT', ai + '/uses', { uses: { tts: { provider: volc.id, model: 'seed-tts-2.0', options: { voice: 'zh_female_vv_uranus_bigtts' } }, image_generation: { provider: stability.id, model: 'sd3.5-large', options: { size: '1536x1024' } } } });

    // Older clients still read and send the single-provider settings.
    const full = await call(gm.token, 'GET', settings);
    assert.equal(full.llm.provider, 'mock'); assert.equal(full.image.provider, 'stability'); assert.equal(full.tts.provider, 'volcengine'); assert.equal(full.tts.voice, 'zh_female_vv_uranus_bigtts');
    await call(gm.token, 'PUT', settings, { llm: full.llm, image: full.image, tts: full.tts });   // a round trip changes nothing
    assert.deepEqual((await call(gm.token, 'GET', ai)).uses, (await call(gm.token, 'GET', ai)).uses);
    assert.equal((await call(gm.token, 'GET', ai)).uses.image_generation.provider, stability.id);

    // Deleting a provider puts its uses back to their defaults.
    const after = await call(gm.token, 'DELETE', `${ai}/providers/${stability.id}`);
    assert.equal(after.uses.image_generation.provider, 'disabled');
    assert.equal((await call(pl.token, 'GET', settings)).images_enabled, false);
    assert.equal(after.uses.image_edit.provider, google.id);
  } finally { fixture.close(); }
});
