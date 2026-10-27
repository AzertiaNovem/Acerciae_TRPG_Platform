import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server with the mock LLM: API_BASE=http://127.0.0.1:8080 node --test tests/integration/script-knowledge.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return; } assert.fail(`expected HTTP ${status}`); };
const PAGES = [
  "THE LANTERN SOCIETY\nA scenario for Call of Cthulhu set in Arkham, 1925.\n\nChapter 1: The Sheriff's Office\nThe investigators meet Sheriff Dunmore, who holds the only key to the lighthouse. He stalls them politely.\nNPC: Sheriff Dunmore\nA tired lawman who secretly belongs to the Lantern Society.\nItem: The Lighthouse Key\nAn iron key stamped with a lantern sigil.\nIf the investigators obtain the key they may enter the lighthouse at night.",
  "Chapter 2: The Lighthouse\nLocation: The Lighthouse\nA ruined tower on the cliffs north of town.\nHandout 1: The Keeper's Diary\nThe diary names the Society's members.\nTwist: The Sheriff's Betrayal\nSheriff Dunmore locks the investigators inside once they find the diary.\nSecret: What Really Happened\nThe Society drowned the lighthouse keeper in 1919.",
  "Ending: Dawn\nIf the investigators escape, the Society scatters.",
];

test("script knowledge: built from the module, Keeper-only, moved by reviewed changes, pinned board, Keeper reminders", async () => {
  const s = Math.random().toString(36).slice(2); const u = {};
  for (const r of ["gm", "p1"]) u[r] = await call(null, "POST", "/api/auth/register", { username: r + s, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Script" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Lantern", knowledge_mode: "isolated" })).id;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: "p1" + s, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const say = (t, content, extra = {}) => call(t, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content, ...extra });
  const observe = () => call(gm, "POST", `/api/channels/${ch}/ai/observe-now`);
  // Import builds the script knowledge.
  const mod = await call(gm, "POST", `/api/channels/${ch}/modules/text`, { title: "The Lantern Society", pages: PAGES });
  assert.equal(mod.status, "ready");
  const all = await call(gm, "GET", `/api/channels/${ch}/script-knowledge`);
  const kinds = new Set(all.map((e) => e.kind));
  for (const k of ["flow", "relationship", "clue", "foreshadowing", "background"]) assert.ok(kinds.has(k), `has ${k}`);
  assert.ok(all.every((e) => e.status === "pending" && e.origin === "script"));
  const flow = all.filter((e) => e.kind === "flow").sort((a, b) => a.position - b.position);
  assert.ok(flow.length >= 3 && flow[flow.length - 1].title === "Dawn", "endings close the flow");
  // Keeper-only.
  await rejects(call(p1, "GET", `/api/channels/${ch}/script-knowledge`), 403);
  await rejects(call(p1, "GET", `/api/channels/${ch}/kp/board`), 403);
  await rejects(call(p1, "POST", `/api/channels/${ch}/tools/get_script_knowledge`, { kind: "flow" }), 403);
  const b0 = await call(gm, "GET", `/api/channels/${ch}/kp/board`);
  assert.equal(b0.next.has_script, true); assert.ok(!b0.next.current?.id); assert.ok(b0.next.next?.title);
  // Play: the Keeper narrates stage one; a player's speculation about the lighthouse moves nothing.
  await say(gm, "You step into the Sheriff's Office. Sheriff Dunmore looks up from his desk and stalls you politely.", { kind: "narration" });
  await say(p1, "I bet the Lighthouse is where the Society meets. Let's ask about the key.", { character_id: ada.id });
  await observe();
  const flow1 = (await call(gm, "GET", `/api/channels/${ch}/script-knowledge?kind=flow`));
  assert.equal(flow1.find((e) => /Sheriff/.test(e.title)).status, "active");
  assert.equal(flow1.find((e) => e.title === "The Lighthouse").status, "pending");
  const changes = await call(gm, "GET", `/api/channels/${ch}/script-knowledge/changes`);
  assert.ok(changes.length >= 1);
  for (const c of changes) { assert.ok(["approved", "rejected"].includes(c.verdict)); if (c.applied) assert.equal(c.verdict, "approved"); assert.ok(c.evidence.length >= 1); assert.ok(c.reviewer_reason); }
  for (const c of changes.filter((c) => c.applied)) {
    for (const ev of c.evidence) { const log = await call(gm, "GET", `/api/channels/${ch}/events?ids=${ev.event_id}`); assert.ok(log[0].payload.content.includes(ev.text), "evidence is verbatim"); }
  }
  const b1 = await call(gm, "GET", `/api/channels/${ch}/kp/board`);
  assert.match(b1.next.current.title, /Sheriff/); assert.equal(b1.next.next.title, "The Lighthouse"); assert.match(b1.next.summary, /Next per the script: The Lighthouse/);
  assert.ok(Array.isArray(b1.notes.timeline) && Array.isArray(b1.notes.open_threads));
  // Keeper edit is final and logged.
  const key = all.find((e) => e.kind === "clue" && e.title === "The Lighthouse Key");
  const upd = await call(gm, "PUT", `/api/channels/${ch}/script-knowledge/${key.id}`, { status: "done", body: "Handed over by Dunmore after the bribe." });
  assert.equal(upd.gm_edited, true); assert.equal(upd.status, "done");
  assert.equal((await call(gm, "GET", `/api/channels/${ch}/script-knowledge/changes?limit=1`))[0].reviewer_reason, "Keeper edit");
  await rejects(call(p1, "PUT", `/api/channels/${ch}/script-knowledge/${key.id}`, { status: "pending" }), 403);
  // Stage two reached; a player asks about the diary → a Keeper reminder with a script reference; players see none.
  await say(gm, "Night. You climb the cliff path to the Lighthouse; the ruined tower groans in the wind.", { kind: "narration" });
  await say(p1, "Is there a diary anywhere in here? I search the desk.", { character_id: ada.id });
  await observe();
  const flow2 = (await call(gm, "GET", `/api/channels/${ch}/script-knowledge?kind=flow`));
  assert.equal(flow2.find((e) => e.title === "The Lighthouse").status, "active");
  assert.equal(flow2.find((e) => /Sheriff/.test(e.title)).status, "done");
  const kp = await call(gm, "GET", `/api/channels/${ch}/reminders`);
  const diary = kp.find((r) => /Diary/.test(r.title));
  assert.ok(diary, "Keeper reminder about the unrevealed handout"); assert.equal(diary.player_group_id, null); assert.equal(diary.script_refs.length, 1); assert.equal(diary.script_refs[0].kind, "clue"); assert.ok(diary.citations.length >= 1);
  const ctx = await call(gm, "GET", `/api/channels/${ch}/reminders/${diary.id}/context?limit=10`);
  assert.ok(ctx.events.some((e) => e.cited)); assert.equal(ctx.reminder.script_refs.length, 1);
  assert.ok((await call(p1, "GET", `/api/channels/${ch}/reminders`)).every((r) => !/Diary/.test(r.title) && (r.script_refs ?? []).length === 0));
  await rejects(call(p1, "GET", `/api/channels/${ch}/reminders/${diary.id}/context`), 404);
  const b2 = await call(gm, "GET", `/api/channels/${ch}/kp/board`);
  assert.equal(b2.next.current.title, "The Lighthouse"); assert.equal(b2.next.next.title, "Dawn"); assert.equal(b2.notes.stages_done.length, 1);
  // The Keeper's prelude leads with the script; the tool answers; rebuilding keeps the edit.
  const tool = await call(gm, "POST", `/api/channels/${ch}/tools/get_script_knowledge`, { kind: "clue", query: "diary" });
  assert.ok(tool.entries.some((e) => /Diary/.test(e.title)));
  const rebuilt = await call(gm, "POST", `/api/channels/${ch}/script-knowledge/rebuild`, {});
  assert.ok(rebuilt.entries >= 8);
  const after = await call(gm, "GET", `/api/channels/${ch}/script-knowledge?kind=clue`);
  const kept = after.find((e) => e.id === key.id);
  assert.ok(kept && kept.gm_edited && kept.status === "done", "Keeper edit survives a rebuild");
});
