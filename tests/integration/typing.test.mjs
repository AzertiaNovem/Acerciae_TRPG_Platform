import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
// Typing flags on the chat socket: a client raises one for a character with a `typing` pack, keeps it up with another
// every few seconds, and lowers it with `active: false`; the server lets it fall when the packs stop or the socket
// closes. Each change reaches the users who may read the window (an NPC's only the GMs). The character list carries
// each character's vitals (HP, SAN, DEX for Call of Cthulhu; HP, AC, DEX for D&D) for the status summary.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A chat socket subscribed to the channel; `received` collects every event, `next(pred)` waits for one.
async function socket(token, channelId) {
  const { token: fileToken } = await call(token, "POST", "/api/auth/file-token");
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/chat?token=${encodeURIComponent(fileToken)}`);
  const received = []; const waiters = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); received.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  await new Promise((resolve, reject) => { ws.on("error", reject); ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "hello") ws.send(JSON.stringify({ type: "subscribe", channel_id: channelId })); if (m.type === "subscribed") resolve(); }); });
  const next = (pred, ms = 15000) => new Promise((resolve, reject) => { const hit = received.find(pred); if (hit) return resolve(hit); const w = { pred, resolve }; waiters.push(w); setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(Error("no such event in time")); } }, ms); });
  const send = (m) => ws.send(JSON.stringify(m));
  return { ws, received, next, send, forget: () => received.splice(0) };
}
const typingOf = (m, cid, active) => m.type === "typing.changed" && m.character_id === cid && m.active === active;

test("typing flags: raised per character, kept up by heartbeats, seen by the window's readers, lowered on stop, silence or a closed socket; vitals in the character list", async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `ty${r}${s}`, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Typing" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Parlour", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `ty${r}${s}`, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada", sheet: { attrs: { HP: 9, SAN: 55, DEX: 60 } } });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo" });
  const tom = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Old Tom", kind: "npc" });
  await call(p1, "PUT", `/api/channels/${ch}/characters/${ada.id}/card`, { role_card: { derived: { hp_max: 12, san_max: 70 } } });

  // Vitals come with the character list: the dice values and the card's maxima, however the sheet spells them.
  const listed = (await call(p2, "GET", `/api/channels/${ch}/characters`)).find((c) => c.id === ada.id);
  assert.deepEqual(listed.vitals, { rule_system: "coc7e", hp: 9, hp_max: 12, san: 55, san_max: 70, dex: 60 });
  assert.equal((await call(p2, "GET", `/api/channels/${ch}/characters`)).find((c) => c.id === mo.id).vitals.hp, null, "a blank sheet invents nothing");

  const G = await socket(gm, ch), P1 = await socket(p1, ch), P2 = await socket(p2, ch);
  try {
    // Bad packs are answered, never broadcast: another player's character, an NPC for a player, a window one is not in.
    P2.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: ada.id, active: true });
    assert.match((await P2.next((m) => m.type === "error")).error, /not your character/);
    P2.forget();
    P1.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: tom.id, active: true });
    assert.match((await P1.next((m) => m.type === "error")).error, /not your character/);
    P1.forget();
    // Ada's player types in the Main Chat: everyone sees Ada's flag, including the writer.
    P1.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: ada.id, active: true });
    for (const S of [G, P1, P2]) { const m = await S.next((m) => typingOf(m, ada.id, true)); assert.equal(m.chat_window_id, main); }
    // A late subscriber gets the current flags at once.
    const late = await socket(p2, ch);
    try {
      const snap = await late.next((m) => m.type === "typing.snapshot");
      assert.deepEqual(snap.typing, [{ chat_window_id: main, character_id: ada.id }]);
    } finally { late.ws.close(); }
    // Heartbeats keep it up silently: no second "raised" event, and the flag outlives the 10 s the server allows.
    const seen = G.received.filter((m) => typingOf(m, ada.id, true)).length;
    for (let i = 0; i < 4; i++) { await sleep(3000); P1.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: ada.id, active: true }); }
    assert.equal(G.received.filter((m) => typingOf(m, ada.id, true)).length, seen, "a heartbeat raises nothing anew");
    assert.ok(!G.received.some((m) => typingOf(m, ada.id, false)), "still up after 12 s of heartbeats");
    // Stopping lowers it for everyone.
    P1.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: ada.id, active: false });
    for (const S of [G, P1, P2]) await S.next((m) => typingOf(m, ada.id, false));
    // Someone else cannot lower a flag they did not raise.
    for (const S of [G, P1, P2]) S.forget();
    P1.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: ada.id, active: true });
    await G.next((m) => typingOf(m, ada.id, true));
    G.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: ada.id, active: false });
    await sleep(500);
    assert.ok(!P2.received.some((m) => typingOf(m, ada.id, false)), "the GM's pack did not lower Ada's player's flag");

    // Silence: the packs stop, and the flag falls on its own within the server's allowance.
    const t0 = Date.now();
    await G.next((m) => typingOf(m, ada.id, false), 16000);
    const quiet = Date.now() - t0;
    assert.ok(quiet >= 8000 && quiet <= 14000, `fell after ${quiet} ms of silence`);

    // In Ada's private window, Mo's player sees nothing; the GM and Ada's player do. An NPC's flag reaches the GM only.
    const priv = (await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Ada alone", kind: "private", members: [{ user_id: u.p1.user.id, character_id: ada.id }] })).id;
    for (const S of [G, P1, P2]) S.forget();
    P1.send({ type: "typing", channel_id: ch, chat_window_id: priv, character_id: ada.id, active: true });
    await G.next((m) => typingOf(m, ada.id, true)); await P1.next((m) => typingOf(m, ada.id, true));
    G.send({ type: "typing", channel_id: ch, chat_window_id: main, character_id: tom.id, active: true });
    await G.next((m) => typingOf(m, tom.id, true));
    await sleep(500);
    assert.ok(!P2.received.some((m) => m.type === "typing.changed"), "Mo's player saw neither the private window nor the NPC");
    assert.ok(!P1.received.some((m) => typingOf(m, tom.id, true)), "nor did Ada's player see the NPC");
    // Mo's player, not in that window, cannot raise a flag there.
    P2.send({ type: "typing", channel_id: ch, chat_window_id: priv, character_id: mo.id, active: true });
    assert.equal((await P2.next((m) => m.type === "error")).type, "error");

    // A closed socket types no more.
    P1.ws.close();
    await G.next((m) => typingOf(m, ada.id, false), 5000);
  } finally { for (const S of [G, P1, P2]) S.ws.close(); }
});
