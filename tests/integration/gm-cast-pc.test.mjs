import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server: API_BASE=http://127.0.0.1:8080 node --test tests/integration/gm-cast-pc.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}

test("a GM-cast PC: owned by the Keeper, a PC to everyone, never the Keeper's identity in a window, a PC in the log", async () => {
  const s = Math.random().toString(36).slice(2); const u = {};
  for (const r of ["gm", "p1"]) u[r] = await call(null, "POST", "/api/auth/register", { username: r + s, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Cast" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Arkham", knowledge_mode: "public" })).id;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: "p1" + s, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  await call(gm, "POST", `/api/channels/${ch}/windows/${main}/members`, { user_id: u.p1.user.id });

  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const harriet = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Harriet Vance", kind: "pc" });
  assert.equal(harriet.kind, "pc"); assert.equal(harriet.user_id, u.gm.user.id, "the Keeper owns it");

  // Not bound into the Keeper's windows: neither the existing ones nor new ones.
  const keeperIn = async (w) => (await call(gm, "GET", `/api/channels/${ch}/windows`)).find((x) => x.id === w).members.find((m) => m.user_id === u.gm.user.id);
  assert.equal((await keeperIn(main)).character_id, null);
  const side = await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Side", kind: "group", members: [{ user_id: u.p1.user.id }] });
  assert.equal((await keeperIn(side.id)).character_id, null);
  assert.equal((await call(gm, "GET", `/api/channels/${ch}/windows`)).find((x) => x.id === side.id).members.find((m) => m.user_id === u.p1.user.id).character_id, ada.id, "players still get their own PC");

  // A PC to the players: listed, and its space readable but not editable.
  const listed = (await call(p1, "GET", `/api/channels/${ch}/characters`)).find((c) => c.id === harriet.id);
  assert.equal(listed?.kind, "pc"); assert.equal(listed.player_name, "gm");
  const space = await call(p1, "GET", `/api/channels/${ch}/characters/${harriet.id}/space`);
  assert.equal(space.character.editable, false);

  // The Keeper speaks as it; the line is that investigator's in the log, not an NPC's.
  await call(gm, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content: "I keep watch by the door.", character_id: harriet.id });
  await call(p1, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content: "I open my notebook.", character_id: ada.id });
  const root = `/api/channels/${ch}/studio`;
  const project = await call(gm, "POST", root + "/projects", { title: "Cast" });
  await call(gm, "POST", root + `/projects/${project.id}/sync`, {});
  const events = await call(gm, "GET", root + `/projects/${project.id}/events`);
  assert.equal(events.find((e) => e.content === "I keep watch by the door.").speaker_role, "pc");
  assert.equal(events.find((e) => e.content === "I open my notebook.").speaker_role, "pc");
});
