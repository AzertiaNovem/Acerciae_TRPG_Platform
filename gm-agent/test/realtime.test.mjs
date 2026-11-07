import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { Realtime } from "../src/realtime.mjs";

// A platform that checks the token only when a socket connects, as WsGateway does: an unknown token gets an error and
// a policy-violation close; a known one gets hello, then subscribed.
async function platform(t) {
  const wss = new WebSocketServer({ port: 0 });
  const p = { valid: new Set(["old"]), seen: [], sockets: new Set() };
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://x"), token = url.searchParams.get("token"), stream = url.pathname.split("/").pop();
    p.seen.push(`${stream}:${token}`);
    if (!p.valid.has(token)) { ws.send(JSON.stringify({ type: "error", error: "unauthorized" })); ws.close(1008, "unauthorized"); return; }
    p.sockets.add(ws); ws.on("close", () => p.sockets.delete(ws));
    ws.send(JSON.stringify({ type: "hello", stream }));
    ws.on("message", (d) => { const m = JSON.parse(d); if (m.type === "subscribe") ws.send(JSON.stringify({ type: "subscribed", channel_id: m.channel_id })); });
  });
  await new Promise((r) => wss.once("listening", r));
  t.after(() => new Promise((r) => { for (const ws of wss.clients) ws.terminate(); wss.close(r); }));
  p.base = `http://127.0.0.1:${wss.address().port}`;
  return p;
}
const until = async (fn, label, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 5)); } };

test("a socket refused after its session ended signs in again once and reconnects with the new token", async (t) => {
  const p = await platform(t);
  const api = { token: "old", logins: 0 };
  const logs = [];
  const rt = new Realtime({ apiBase: p.base, token: () => api.token, reauth: async () => { api.logins++; api.token = `new${api.logins}`; p.valid.add(api.token); }, channelId: "ch", log: (m) => logs.push(m), retryDelay: () => 20 });
  t.after(() => rt.stop());
  const subscribed = [];
  rt.on("subscribed", (stream, again) => subscribed.push(`${stream}${again ? " again" : ""}`));
  rt.start();
  await until(() => rt.connected.size === 2, "both streams up");
  // Seven days later the session is gone, then the backend restarts: both sockets drop.
  p.valid.delete("old");
  for (const ws of p.sockets) ws.close(1012, "restart");
  await until(() => rt.connected.size === 2 && subscribed.length === 4, "both streams back");
  assert.equal(api.logins, 1, "one sign-in serves both streams");
  assert.ok(p.seen.includes("chat:old") && p.seen.filter((s) => s.endsWith(":new1")).length === 2, p.seen.join(" "));
  assert.deepEqual(subscribed.slice(2).sort(), ["chat again", "context again"], "the table refetches what it missed");
  assert.ok(logs.some((l) => /the session ended; signing in again/.test(l)));
});

test("a token another caller already renewed is used without signing in again; a failed sign-in backs off", async (t) => {
  const p = await platform(t);
  const api = { token: "old", logins: 0 };
  const rt = new Realtime({ apiBase: p.base, token: () => api.token, reauth: async () => { api.logins++; throw new Error("account suspended"); }, channelId: "ch", streams: ["chat"], log: () => {}, retryDelay: (a) => 30 * (a + 1) });
  t.after(() => rt.stop());
  rt.start();
  await until(() => rt.connected.size === 1, "up");
  // A REST call already signed in again: the refused socket just uses the new token.
  p.valid.delete("old"); p.valid.add("rest"); api.token = "rest";
  for (const ws of p.sockets) ws.close(1012, "restart");
  await until(() => rt.connected.size === 1 && p.seen.at(-1) === "chat:rest", "back with the REST session");
  assert.equal(api.logins, 0);
  // Now no session can be had (a suspended account): it keeps trying, but with backoff, not in a loop.
  p.valid.clear();
  for (const ws of p.sockets) ws.close(1012, "restart");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(api.logins >= 1 && api.logins <= 6, `sign-ins: ${api.logins}`);
  assert.equal(rt.connected.size, 0);
});

test("a plain string token still works (one-off clients)", async (t) => {
  const p = await platform(t);
  const rt = new Realtime({ apiBase: p.base, token: "old", channelId: "ch", streams: ["chat"], log: () => {} });
  t.after(() => rt.stop());
  rt.start();
  await until(() => rt.connected.size === 1, "up");
});

import { Api } from "../src/api.mjs";
test("REST calls that find the session ended share one sign-in", async () => {
  let logins = 0, token = "old";
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/login") { logins++; await new Promise((r) => setTimeout(r, 20)); token = `new${logins}`; return new Response(JSON.stringify({ token, user: { id: "gm" } }), { status: 200 }); }
    const auth = init.headers.Authorization;
    return auth === `Bearer ${token}` && token !== "old" ? new Response(JSON.stringify({ ok: path }), { status: 200 }) : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  };
  const api = new Api("http://platform", { fetchImpl: fetch });
  api.token = "old"; api.credentials = { username: "gm", password: "pw" };
  const [a, b] = await Promise.all([api.get("/api/a"), api.get("/api/b")]);
  assert.deepEqual([a.ok, b.ok, logins], ["/api/a", "/api/b", 1]);
  assert.equal(api.token, "new1");
});
