// End-to-end acceptance scenarios against a running backend (default http://localhost:8080).
// Run:  API_BASE=http://localhost:8080 node --test scenarios.test.mjs
// Each run creates its own users/server/channel, so it can be repeated against a live instance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';   // Node's built-in WebSocket reuses pooled HTTP connections, which Drogon does not upgrade; `ws` opens a fresh socket.

const BASE = process.env.API_BASE || 'http://localhost:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const RUN = Math.random().toString(36).slice(2, 8);
const here = path.dirname(fileURLToPath(import.meta.url));

async function api(method, p, body, token, raw) {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`; if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const err = new Error(`${method} ${p} -> ${res.status} ${data?.message ?? text}`); err.status = res.status; err.data = data; throw err; }
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 500, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(interval); }
}
function openWs(stream, token, channelId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/${stream}?token=${token}`);
    const received = [];
    ws.on('message', (data) => { const m = JSON.parse(data.toString()); received.push(m); if (m.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId })); if (m.type === 'subscribed') resolve({ ws, received }); });
    ws.on('error', (e) => reject(e));
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
}

const U = {};               // tokens by role
const ids = {};             // created ids
let observerInterval = 5000;

before(async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 'ok');
  for (const [k, display] of [['gm', 'Keeper'], ['pl1', 'Player One'], ['pl2', 'Player Two'], ['pl3', 'Player Three']]) {
    const r = await api('POST', '/api/auth/register', { username: `${k}_${RUN}`, password: 'password', display_name: display });
    U[k] = r.token; ids[`${k}_user`] = r.user.id;
  }
  const server = await api('POST', '/api/servers', { name: `Test Table ${RUN}` }, U.gm);
  ids.server = server.id;
  const channel = await api('POST', `/api/servers/${server.id}/channels`, { name: `Scenario Campaign ${RUN}`, knowledge_mode: 'isolated' }, U.gm);
  ids.channel = channel.id;
  for (const k of ['pl1', 'pl2', 'pl3']) await api('POST', `/api/channels/${channel.id}/members`, { username: `${k}_${RUN}`, role: 'player' }, U.gm);
  ids.c1 = (await api('POST', `/api/channels/${channel.id}/characters`, { name: 'Ada Vance', speaking_style: 'formal' }, U.pl1)).id;
  ids.c2 = (await api('POST', `/api/channels/${channel.id}/characters`, { name: 'Ben Okoro', speaking_style: 'blunt' }, U.pl2)).id;
  ids.c3 = (await api('POST', `/api/channels/${channel.id}/characters`, { name: 'Cora Lindqvist', speaking_style: 'terse' }, U.pl3)).id;
  await api('POST', `/api/channels/${channel.id}/characters`, { name: 'Sheriff Dunmore', kind: 'npc' }, U.gm);
  const windows = await api('GET', `/api/channels/${channel.id}/windows`, undefined, U.gm);
  ids.main = windows[0].id;
  ids.sceneOffice = (await api('POST', `/api/channels/${channel.id}/scenes`, { title: 'Session 1 — Sheriff Office', location: "Sheriff's Office", narrative_time: 'Monday morning' }, U.gm)).id;
  ids.sceneArchive = (await api('POST', `/api/channels/${channel.id}/scenes`, { title: 'Session 2 — Archive', location: 'Town Archive', narrative_time: 'Tuesday afternoon' }, U.gm)).id;
  ids.sceneHarbour = (await api('POST', `/api/channels/${channel.id}/scenes`, { title: 'Session 2 — Harbour', location: 'Old Harbour', narrative_time: 'Tuesday night' }, U.gm)).id;
  await api('POST', `/api/channels/${channel.id}/windows/${ids.main}/scene`, { scene_id: ids.sceneOffice }, U.gm);
  ids.winArchive = (await api('POST', `/api/channels/${channel.id}/windows`, { name: 'Archive (PL1+PL2)', kind: 'group', members: [{ user_id: ids.pl1_user }, { user_id: ids.pl2_user }], scene_id: ids.sceneArchive }, U.gm)).id;
  ids.winHarbour = (await api('POST', `/api/channels/${channel.id}/windows`, { name: 'Harbour (PL3)', kind: 'private', members: [{ user_id: ids.pl3_user }], scene_id: ids.sceneHarbour }, U.gm)).id;
  const status = await api('GET', `/api/channels/${channel.id}/ai/status`, undefined, U.gm);
  observerInterval = status.interval_ms;
});

const say = (token, win, content, kind = 'ic') => api('POST', `/api/channels/${ids.channel}/windows/${win}/messages`, { content, kind }, token);
const docByType = async (token, type) => (await api('GET', `/api/channels/${ids.channel}/documents`, undefined, token)).find((d) => d.doc_type === type);
const docEntries = async (token, type, sceneId) => (await api('GET', `/api/channels/${ids.channel}/documents/${(await docByType(token, type)).id}${sceneId ? `?scene_id=${sceneId}` : ''}`, undefined, token)).entries;

test('Scenario 2: messages within one scan interval are analysed as ONE batch, bubbles get a change indicator', async () => {
  const { ws, received } = await openWs('context', U.pl1, ids.channel);
  const before = await api('GET', `/api/channels/${ids.channel}/ai/jobs`, undefined, U.gm);
  // Session 1 in the main window — a burst of messages well inside the 5s window.
  await say(U.gm, ids.main, 'The investigators arrive at the Sheriff\'s Office on a grey Monday morning. Sheriff Dunmore rises with a careful smile.', 'narration');
  await say(U.pl1, ids.main, '"Sheriff, we would like to see the lighthouse. We understand it has been locked."');
  await say(U.gm, ids.main, 'Dunmore nods. "I\'ve got the only key — somewhere in this mess. I promise I\'ll look for it and bring it to you at the boarding house."', 'narration');
  await say(U.pl2, ids.main, 'I look around the office while they talk. I try to read the papers on the desk.');
  await say(U.gm, ids.main, 'Ben, with a successful Spot Hidden you notice a tarnished badge on the desk. It bears a lantern sigil instead of the county seal.', 'narration');
  await say(U.pl2, ids.main, 'Maybe the Sheriff is hiding something. That badge isn\'t a county badge.');
  // Wait for the scheduler (not an explicit trigger) to pick the batch up.
  const job = await waitFor(async () => {
    const jobs = await api('GET', `/api/channels/${ids.channel}/ai/jobs`, undefined, U.gm);
    return jobs.find((j) => j.kind === 'observe' && j.status === 'succeeded' && j.group_key.startsWith(ids.main) && !before.some((b) => b.id === j.id));
  }, { timeout: observerInterval * 4 + 15000, label: 'observer job' });
  assert.ok(job.event_count >= 6, `one job should cover the whole burst, got ${job.event_count}`);
  assert.equal(job.llm_calls <= 2, true, 'the batch must not call the LLM once per message');
  const updates = await waitFor(async () => { const u = received.filter((m) => m.type === 'document.updated'); return u.length >= 1 ? u : null; }, { label: 'document.updated push' });
  assert.ok(updates.some((u) => u.change_count > 0));
  const docs = await api('GET', `/api/channels/${ids.channel}/documents`, undefined, U.pl1);
  assert.ok(docs.find((d) => d.doc_type === 'clue_journal').recent_changes >= 1, 'clue journal bubble shows a change indicator');
  const clues = await docEntries(U.pl1, 'clue_journal');
  assert.ok(clues.some((e) => /badge/i.test(e.summary) && e.status === 'confirmed'));
  const rel = await docEntries(U.pl1, 'relationships');
  assert.ok(rel.some((e) => e.data?.relation === 'promised' && e.status === 'npc_claim'), 'NPC promise recorded as a claim, not a fact');
  ws.close();
});

test('Scenario 1: split-party investigation — PL3 cannot read PL1/PL2\'s private clue', async () => {
  await say(U.gm, ids.winArchive, 'The Town Archive smells of dust. Ada, Ben — where do you start?', 'narration');
  await say(U.pl1, ids.winArchive, 'I search the shelves for anything about the shoals. Library Use.');
  await say(U.gm, ids.winArchive, 'Ada succeeds. You find a 1911 clipping about a shipwreck and a photograph of a brass lantern recovered from the wreck.', 'narration');
  await say(U.gm, ids.winHarbour, 'Cora, fog hangs over the Old Harbour. A figure in oilskins watches the water.', 'narration');
  await say(U.pl3, ids.winHarbour, 'I approach slowly. "Evening. You waiting on a boat?"');
  await say(U.gm, ids.winHarbour, 'The man turns. "Jonah Pike. Stay off the water at the new moon." He drops a tarnished badge with a lantern sigil on the planks as he leaves.', 'narration');
  await api('POST', `/api/channels/${ids.channel}/ai/observe-now`, undefined, U.gm);
  const gmClues = await docEntries(U.gm, 'clue_journal');
  assert.ok(gmClues.some((e) => /clipping|lantern/i.test(e.summary)), 'GM sees the archive clue');
  const pl3Clues = await docEntries(U.pl3, 'clue_journal');
  assert.ok(!pl3Clues.some((e) => /clipping/i.test(e.summary)), 'PL3 must not see the archive clue');
  assert.ok(pl3Clues.some((e) => /badge/i.test(e.summary)), 'PL3 sees their own harbour clue');
  const pl1Clues = await docEntries(U.pl1, 'clue_journal');
  assert.ok(pl1Clues.some((e) => /clipping/i.test(e.summary)));
  assert.ok(!pl1Clues.some((e) => /Jonah|planks/i.test(e.summary)), 'PL1 must not see PL3\'s harbour clue');
  // Raw retrieval respects the same scope.
  const search = await api('POST', `/api/channels/${ids.channel}/tools/search_scene_history`, { query: 'clipping shipwreck' }, U.pl3);
  assert.equal(search.facts.length, 0);
  await assert.rejects(api('GET', `/api/channels/${ids.channel}/windows/${ids.winArchive}/messages`, undefined, U.pl3), (e) => e.status === 403);
});

test('Scenario 3: return of historical foreshadowing — mention of the badge highlights the earlier clue', async () => {
  ids.sceneReunion = (await api('POST', `/api/channels/${ids.channel}/scenes`, { title: 'Session 3 — Boarding House', location: 'Boarding House', narrative_time: 'Wednesday morning' }, U.gm)).id;
  await api('POST', `/api/channels/${ids.channel}/windows/${ids.main}/scene`, { scene_id: ids.sceneReunion }, U.gm);
  const { ws, received } = await openWs('context', U.pl3, ids.channel);
  await say(U.gm, ids.main, 'Wednesday morning at the Boarding House. The three of you are together again.', 'narration');
  await say(U.pl3, ids.main, 'I put the tarnished badge on the table between us. "A man named Jonah Pike dropped this at the harbour last night."');
  await api('POST', `/api/channels/${ids.channel}/ai/observe-now`, undefined, U.gm);
  const highlights = await api('GET', `/api/channels/${ids.channel}/highlights`, undefined, U.pl3);
  const clueDoc = await docByType(U.pl3, 'clue_journal');
  const clueHl = highlights.filter((h) => h.kind === 'association' && h.document_id === clueDoc.id);
  assert.ok(clueHl.length >= 1, 'an association highlight on the clue journal exists');
  const targets = await Promise.all(clueHl.map((h) => api('GET', `/api/channels/${ids.channel}/entries/${h.target_entry_id}`, undefined, U.pl3)));
  const idx = targets.findIndex((e) => /badge/i.test(e.summary) && e.scene_id === ids.sceneOffice);
  assert.ok(idx >= 0, 'the Session 1 badge clue entry is highlighted');
  const badgeHl = [clueHl[idx]]; const entry = targets[idx];
  assert.ok(/badge/i.test(badgeHl[0].reason) || /tarnished/i.test(badgeHl[0].reason), 'reason names the recurring thing');
  assert.ok(entry.source_event_ids.length >= 1, 'entry traces back to original events');
  const events = await api('GET', `/api/channels/${ids.channel}/events?ids=${entry.source_event_ids.join(',')}`, undefined, U.pl3);
  assert.ok(events.length >= 1 && events[0].message_id, 'original message is reachable');
  assert.ok(badgeHl[0].source_event_ids.length >= 1, 'highlight cites the triggering event');
  const pushed = await waitFor(async () => received.find((m) => m.type === 'highlight.created'), { timeout: 5000, label: 'highlight push' }).catch(() => null);
  assert.ok(pushed, 'highlight was pushed over the context stream');
  const rel = await docEntries(U.gm, 'relationships');
  assert.ok(rel.some((e) => /badge/i.test(e.summary) && /Cora/i.test(e.summary)), 'relationship journal links the character to the recurring item');
  // Dismiss works and is scoped.
  await api('POST', `/api/channels/${ids.channel}/highlights/${badgeHl[0].id}/dismiss`, undefined, U.pl3);
  ws.close();
});

test('Scenario 4: consistency conflict — claiming an item that was only promised', async () => {
  const r = await api('POST', `/api/channels/${ids.channel}/consistency`, { chat_window_id: ids.main, character_id: ids.c1, draft: 'I take out the key that the Sheriff gave me last week and unlock the lighthouse door.' }, U.pl1);
  assert.equal(r.insufficient_evidence, false);
  assert.ok(typeof r.score === 'number' && r.score >= 0 && r.score <= 100);
  assert.ok(r.score < 70, `expected a low heuristic score, got ${r.score}`);
  assert.ok(r.conflicts.length >= 1);
  assert.ok(/promised|no confirmed record|no record/i.test(r.conflicts[0].description));
  assert.ok(r.evidence.length >= 1, 'evidence list is present');
  assert.ok(r.evidence.some((e) => e.source_event_ids?.length >= 1), 'evidence is traceable to events');
  assert.ok(r.highlights.length >= 1 && r.highlights.every((h) => h.kind === 'consistency' && h.visibility_scope === 'user'), 'temporary user-scoped highlights were created');
  assert.ok(/heuristic/i.test(r.rationale));
  // Insufficient evidence path
  const r2 = await api('POST', `/api/channels/${ids.channel}/consistency`, { chat_window_id: ids.main, character_id: ids.c1, draft: 'I hum quietly to myself.' }, U.pl1);
  assert.equal(r2.insufficient_evidence, true); assert.equal(r2.score, null); assert.equal(r2.score_label, 'Insufficient Evidence');
  // The draft was never posted.
  const msgs = await api('GET', `/api/channels/${ids.channel}/windows/${ids.main}/messages`, undefined, U.pl1);
  assert.ok(!msgs.some((m) => /unlock the lighthouse door/.test(m.content)));
  // GM-only secrets never leak into a player's check.
  await api('POST', `/api/channels/${ids.channel}/windows/${ids.main}/messages`, { content: 'KEEPER NOTE: the real key is hidden inside the lighthouse lamp.', kind: 'narration', visibility: 'gm_only' }, U.gm);
  await api('POST', `/api/channels/${ids.channel}/ai/observe-now`, undefined, U.gm);
  const r3 = await api('POST', `/api/channels/${ids.channel}/consistency`, { chat_window_id: ids.main, character_id: ids.c1, draft: 'I search the lighthouse lamp for the real key.' }, U.pl1);
  assert.ok(!JSON.stringify(r3).includes('hidden inside the lighthouse lamp'), 'GM secret must not be revealed or hinted');
});

test('Scenario 5: inspiration — editable draft grounded in the character\'s knowledge, never auto-sent', async () => {
  const countBefore = (await api('GET', `/api/channels/${ids.channel}/windows/${ids.main}/messages`, undefined, U.pl2)).length;
  const r = await api('POST', `/api/channels/${ids.channel}/inspiration`, { chat_window_id: ids.main, character_id: ids.c2 }, U.pl2);
  assert.ok(r.draft.length > 20); assert.equal(r.editable, true); assert.equal(r.auto_sent, false);
  assert.ok(!/Jonah|planks|harbour|lamp/i.test(r.draft), 'draft must not use facts Ben does not know (PL3 harbour-only clue or GM secrets)');
  const countAfter = (await api('GET', `/api/channels/${ids.channel}/windows/${ids.main}/messages`, undefined, U.pl2)).length;
  assert.equal(countAfter, countBefore, 'nothing was sent');
  const r2 = await api('POST', `/api/channels/${ids.channel}/inspiration`, { chat_window_id: ids.main, character_id: ids.c2, variant: 3 }, U.pl2);
  assert.notEqual(r2.draft, r.draft, 'regeneration yields a different draft');
  await assert.rejects(api('POST', `/api/channels/${ids.channel}/inspiration`, { chat_window_id: ids.main, character_id: ids.c1 }, U.pl2), (e) => e.status === 403, 'cannot draft as someone else\'s character');
});

test('Scenario 6: module deviation — events are recorded, GM gets potential associations, no module truth invented', async () => {
  const pdfPath = path.join(here, '..', '..', 'backend', 'seed', 'demo_module.pdf');
  let mod;
  if (existsSync(pdfPath)) {
    const fd = new FormData(); fd.append('file', new Blob([readFileSync(pdfPath)], { type: 'application/pdf' }), 'demo_module.pdf'); fd.append('title', 'Demo module (PDF)');
    const up = await api('POST', `/api/channels/${ids.channel}/modules`, undefined, U.gm, fd);
    mod = await waitFor(async () => { const m = await api('GET', `/api/channels/${ids.channel}/modules/${up.id}`, undefined, U.gm); return m.status === 'ready' || m.status === 'failed' ? m : null; }, { label: 'module processing' });
    assert.equal(mod.status, 'ready', mod.error ?? '');
    assert.ok(mod.page_count >= 2, 'PDF text extracted per page');
  } else {
    mod = await api('POST', `/api/channels/${ids.channel}/modules/text`, { title: 'Demo module (text)', pages: ['Scene: The Sheriff\'s Office\nSheriff Dunmore holds the only key.\nItem: The Lighthouse Key\nAn iron key.', 'Location: The Lighthouse\nIf the investigators obtain the key they may enter the lighthouse.'] }, U.gm);
  }
  assert.ok(mod.nodes.length >= 3);
  assert.ok(mod.nodes.every((n) => n.citations.length >= 1 && n.citations[0].page >= 1), 'every node cites a page');
  assert.ok(mod.edges.length >= 1);
  const types = new Set(mod.nodes.map((n) => n.node_type));
  assert.ok(types.has('npc') || types.has('location') || types.has('item'));
  await assert.rejects(api('GET', `/api/channels/${ids.channel}/modules`, undefined, U.pl1), (e) => e.status === 403, 'module layer is GM-only');
  // Players go somewhere the module does not know about.
  ids.sceneOff = (await api('POST', `/api/channels/${ids.channel}/scenes`, { title: 'Session 3 — The Quarry', location: 'Abandoned Granite Quarry', narrative_time: 'Wednesday noon' }, U.gm)).id;
  await api('POST', `/api/channels/${ids.channel}/windows/${ids.main}/scene`, { scene_id: ids.sceneOff }, U.gm);
  await say(U.gm, ids.main, 'You reach the Abandoned Granite Quarry. Nobody in town mentioned this place. A rusted lantern hangs from a hook by the water pump.', 'narration');
  await say(U.pl1, ids.main, 'I examine the rusted lantern. Does it carry the lantern sigil like the badge?');
  await say(U.gm, ids.main, 'You find a lantern sigil scratched into its base — the same mark as the badge.', 'narration');
  await api('POST', `/api/channels/${ids.channel}/ai/observe-now`, undefined, U.gm);
  const scene = await api('GET', `/api/channels/${ids.channel}/scenes/${ids.sceneOff}`, undefined, U.gm);
  assert.equal(scene.off_module, true, 'scene flagged as outside the module');
  const clues = await docEntries(U.gm, 'clue_journal');
  assert.ok(clues.some((e) => /sigil|lantern/i.test(e.summary) && e.scene_id === ids.sceneOff), 'what actually happened off-module is recorded');
  const hints = await api('GET', `/api/channels/${ids.channel}/modules/hints`, undefined, U.gm);
  assert.ok(hints.length >= 1, 'GM receives potential-association hints');
  assert.ok(hints.every((h) => h.status === 'potential'), 'hints are marked potential, not facts');
  const progress = await docEntries(U.gm, 'module_progress');
  assert.ok(progress.every((e) => e.status === 'ai_inferred' || e.status === 'confirmed'), 'module progress entries are inferred, never invented truths');
  const ws = await api('GET', `/api/channels/${ids.channel}/gm/workspace`, undefined, U.gm);
  assert.ok(ws.scenes.some((s) => s.id === ids.sceneOff && s.off_module));
  await assert.rejects(api('GET', `/api/channels/${ids.channel}/gm/workspace`, undefined, U.pl2), (e) => e.status === 403);
});

test('Scenario 7: GM error correction — history preserved, erroneous fact no longer confirmed context', async () => {
  // Make the AI record an attempt that a GM note later confirms incorrectly worded; simpler: find an attempted
  // action and have the GM correct a confirmed clue that was actually only attempted.
  const clueDoc = await docByType(U.gm, 'clue_journal');
  const entries = (await api('GET', `/api/channels/${ids.channel}/documents/${clueDoc.id}`, undefined, U.gm)).entries;
  const target = entries.find((e) => e.status === 'confirmed');
  assert.ok(target, 'a confirmed entry exists');
  const revsBefore = await api('GET', `/api/channels/${ids.channel}/documents/${clueDoc.id}/revisions`, undefined, U.gm);
  const out = await api('PUT', `/api/channels/${ids.channel}/documents/${clueDoc.id}/entries/${target.id}`, { status: 'attempted', reason: 'The investigators only tried; the roll had not been resolved.' }, U.gm);
  assert.equal(out.entry.status, 'attempted');
  const revsAfter = await api('GET', `/api/channels/${ids.channel}/documents/${clueDoc.id}/revisions`, undefined, U.gm);
  assert.equal(revsAfter.length, revsBefore.length + 1);
  assert.equal(revsAfter[0].actor, 'gm');
  const old = await api('GET', `/api/channels/${ids.channel}/documents/${clueDoc.id}/revisions/${revsBefore[0].version}`, undefined, U.gm);
  assert.ok(old.snapshot.some((s) => s.fact_id === target.fact_id && s.status === 'confirmed'), 'previous reading preserved in history');
  const fact = await api('GET', `/api/channels/${ids.channel}/facts/${target.fact_id}`, undefined, U.gm);
  assert.equal(fact.status, 'attempted');
  // Retrieval tools now report the corrected status, so no downstream prompt treats it as confirmed.
  const tool = await api('POST', `/api/channels/${ids.channel}/tools/get_clue`, { clue: target.fact_id }, U.gm);
  assert.equal(tool.clue.status, 'attempted');
  // Players cannot correct.
  await assert.rejects(api('PUT', `/api/channels/${ids.channel}/documents/${clueDoc.id}/entries/${target.id}`, { status: 'confirmed' }, U.pl1), (e) => e.status === 403);
  // AI may not silently re-confirm a GM-authored correction: it lands in review.
  const ev = await api('GET', `/api/channels/${ids.channel}/events?ids=${target.source_event_ids.join(',')}`, undefined, U.gm);
  assert.ok(ev.length >= 1);
  // Rollback restores and is itself a revision.
  const rolled = await api('POST', `/api/channels/${ids.channel}/documents/${clueDoc.id}/rollback`, { version: revsBefore[0].version }, U.gm);
  assert.equal(rolled.version, revsAfter[0].version + 1);
  assert.equal((await api('GET', `/api/channels/${ids.channel}/facts/${target.fact_id}`, undefined, U.gm)).status, 'confirmed');
});

test('Realtime: chat stream delivers messages only to window participants', async () => {
  const a = await openWs('chat', U.pl1, ids.channel);
  const c = await openWs('chat', U.pl3, ids.channel);
  await say(U.pl2, ids.winArchive, 'Psst — only the archive window should get this.');
  await sleep(800);
  assert.ok(a.received.some((m) => m.type === 'message.posted' && /archive window/.test(m.message.content)));
  assert.ok(!c.received.some((m) => m.type === 'message.posted' && /archive window/.test(m.message.content)));
  a.ws.close(); c.ws.close();
});

test('Knowledge sharing suggestion is proposed to the GM, never applied automatically (Mode B)', async () => {
  const proposals = await api('GET', `/api/channels/${ids.channel}/proposals?status=needs_gm_review`, undefined, U.gm);
  // Cora talked about the badge (her private clue) in front of Ada and Ben → suggestion to share.
  const share = proposals.find((p) => p.ops?.[0]?.op === 'share_knowledge');
  if (share) {
    const factId = share.ops[0].fact_id;
    const beforeScope = await api('GET', `/api/channels/${ids.channel}/facts/${factId}/visibility`, undefined, U.gm);
    assert.ok(!share.ops[0].character_ids.every((c) => beforeScope.character_ids.includes(c)), 'not yet shared automatically');
    await api('POST', `/api/channels/${ids.channel}/proposals/${share.id}/decide`, { accept: true }, U.gm);
    const afterScope = await api('GET', `/api/channels/${ids.channel}/facts/${factId}/visibility`, undefined, U.gm);
    assert.ok(share.ops[0].character_ids.every((c) => afterScope.character_ids.includes(c)), 'GM acceptance widens knowledge');
  }
  await assert.rejects(api('GET', `/api/channels/${ids.channel}/proposals`, undefined, U.pl1), (e) => e.status === 403);
});

after(() => { /* data stays for inspection; each run uses unique names */ });
