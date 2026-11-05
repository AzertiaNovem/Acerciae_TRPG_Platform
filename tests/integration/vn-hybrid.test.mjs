import { test } from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw Object.assign(Error(JSON.stringify(data)), { status: r.status }); return data;
}
async function finished(token, path) {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const j = await call(token, 'GET', path); if (['completed', 'failed'].includes(j.status)) { assert.equal(j.status, 'completed', j.error); return j; } await new Promise(r => setTimeout(r, 100)); }
  throw Error('Hybrid script timed out');
}
test('hybrid handoff retains script/cast/art with normal authorization and never starts server media generation', async () => {
  const suffix = Math.random().toString(36).slice(2);
  const gm = await call('', 'POST', '/api/auth/register', { username: 'hgm' + suffix, password: 'password' });
  const pl = await call('', 'POST', '/api/auth/register', { username: 'hpl' + suffix, password: 'password' });
  const srv = await call(gm.token, 'POST', '/api/servers', { name: 'Hybrid fixtures' });
  await call(gm.token, 'PUT', `/api/servers/${srv.id}/settings`, { llm: { provider: 'mock' }, image: { provider: 'mock' }, tts: { provider: 'mock' } });
  const ch = (await call(gm.token, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Hybrid harbour' })).id;
  const root = `/api/channels/${ch}/studio`;
  await call(gm.token, 'POST', `/api/channels/${ch}/members`, { username: 'hpl' + suffix, role: 'player' });
  const pc = await call(pl.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ada' });
  await call(pl.token, 'PUT', `/api/channels/${ch}/characters/${pc.id}/appearance`, { asset_mode: 'generated', appearance_prompt: 'red coat' });
  const form = new FormData(); form.append('slot', 'portrait'); form.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'profile.png');
  const upload = await fetch(base + `/api/channels/${ch}/characters/${pc.id}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${pl.token}` }, body: form });
  assert.equal(upload.status, 200); const portrait = (await upload.json()).portrait;
  const win = (await call(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const say = (token, content, extra = {}) => call(token, 'POST', `/api/channels/${ch}/windows/${win}/messages`, { content, ...extra });
  await say(gm.token, 'Fog rolls over the harbour.', { kind: 'narration' });
  await say(pl.token, 'I raise my lantern.', { character_id: pc.id });
  const voice = await call(gm.token, 'POST', root + '/voices', { name: 'Ada voice', character_id: pc.id, voice_id: 'alloy', voice_type: 'preset', language: 'zh', style_instruction: 'quiet', synthesis_parameters: { speed: 0.8 } });
  const narrator = await call(gm.token, 'POST', root + '/voices', { name: 'Narrator', voice_id: 'nova', voice_type: 'preset', language: 'zh' });
  await assert.rejects(call(gm.token, 'POST', root + '/vn-scripts', { media_mode: 'bogus' }), e => e.status === 400);
  const job = await call(gm.token, 'POST', root + '/vn-scripts', { media_mode: 'hybrid', generate_art: true });
  assert.equal(job.params.generate_art, false);
  const done = await finished(gm.token, root + '/vn-scripts/' + job.id);
  const pp = root + '/presentations/' + done.presentation_id;
  const pres = await call(gm.token, 'GET', pp); assert.equal(pres.settings.media_mode, 'hybrid');
  await call(gm.token, 'POST', pp + '/cast', { cast: { [pc.id]: voice.id } });
  const handoff = await call(gm.token, 'GET', pp + '/hybrid');
  assert.equal(handoff.format, 'acerciae-hybrid-vn-1');
  assert.equal(handoff.presentation.events.length, pres.events.length);
  assert.equal(handoff.characters.find(c => c.id === pc.id).portrait, portrait.id + '@1');
  assert.equal(handoff.assets.filter(a => a.id === portrait.id).length, 1);
  assert.match(handoff.assets[0].hash, /^[0-9a-f]{64}$/);
  assert.ok(handoff.presentation.events.flatMap(e => e.stage).some(s => s.expression === 'SAY' && s.image === null), 'portrait fallback is not a completed SAY pose');
  assert.equal(handoff.voices[0].voice_id, 'alloy'); assert.equal(handoff.voices[0].synthesis_parameters.speed, 0.8);
  assert.equal(handoff.voices[0].consent_metadata, undefined);
  assert.equal(handoff.voices[0].created_by, undefined);
  assert.equal(handoff.voices[0].api_key, undefined);
  assert.equal(handoff.cast.narrator, narrator.id, 'the implicit platform narrator is retained');
  assert.equal(handoff.voices.find(v => v.id === narrator.id).voice_id, 'nova');
  assert.deepEqual(await call(gm.token, 'GET', root + '/images/jobs'), []);
  await assert.rejects(call(gm.token, 'POST', root + '/vn-scripts/' + job.id + '/backgrounds/retry', {}), e => e.status === 400);
  await assert.rejects(call(gm.token, 'POST', pp + '/tts/jobs', {}), e => e.status === 400);
  await assert.rejects(call(pl.token, 'GET', pp + '/hybrid'), e => e.status === 403 || e.status === 404);
  // Player-created character-scoped copies remain exportable without granting access to the GM draft.
  const pj = await call(pl.token, 'POST', root + '/vn-scripts', { media_mode: 'hybrid', scope: 'character', scope_character_id: pc.id });
  const pd = await finished(pl.token, root + '/vn-scripts/' + pj.id);
  const playerCopy = await call(pl.token, 'GET', root + '/presentations/' + pd.presentation_id + '/hybrid');
  assert.equal(playerCopy.presentation.snapshot_scope, 'character');
  assert.ok(playerCopy.presentation.events.length > 0);
  // Continuing a hybrid story inherits the mode even if the caller omits it.
  await say(pl.token, 'The gate is open.', { character_id: pc.id });
  const continuation = await call(gm.token, 'POST', root + '/vn-scripts', { continue_presentation_id: done.presentation_id });
  assert.equal(continuation.params.media_mode, 'hybrid'); assert.equal(continuation.params.generate_art, false);
  await finished(gm.token, root + '/vn-scripts/' + continuation.id);
  assert.deepEqual(await call(gm.token, 'GET', root + '/images/jobs'), []);
  const full = await call(gm.token, 'GET', pp + '/hybrid');
  assert.ok(full.presentation.events.length > handoff.presentation.events.length, 'handoff contains the full continued timeline');
});
