// The two WebSocket streams (/ws/chat and /ws/context): subscribe to one channel, keep the connection alive and
// reconnect with backoff. Emits "event" ({stream, ...payload}) and "subscribed" (refetch what may have been missed).
//
// The platform checks the session token only when a socket connects, and a session ends (AUTH_TOKEN_TTL_HOURS, 168 by
// default, or a revocation). So every connection reads the current token (`token` may be a function), and a socket the
// platform refuses as unauthorized signs in again (`reauth`) before it reconnects: a channel kept for weeks never goes
// deaf after a reconnect.
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export class Realtime extends EventEmitter {
  constructor({ apiBase, token, reauth = null, channelId, streams = ["chat", "context"], log = () => {}, retryDelay = (attempt) => Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) }) {
    super();
    this.wsBase = apiBase.replace(/^http/, "ws");
    this.token = token;
    this.reauth = reauth;
    this.retryDelay = retryDelay;
    this.signingIn = null;          // one sign-in shared by both streams
    this.channelId = channelId;
    this.streams = streams;
    this.log = log;
    this.sockets = new Map();
    this.closed = false;
    this.reconnectTimers = new Set();
    this.connected = new Set();     // streams subscribed right now (for status)
  }

  start() { for (const s of this.streams) this.open(s, 0); }
  currentToken() { return typeof this.token === "function" ? this.token() : this.token; }

  // A new session for the sockets (and the REST client, which shares it); concurrent callers wait for the same one.
  async renew(stream) {
    if (!this.reauth) return false;
    this.signingIn ??= (async () => {
      this.log(`${stream} socket: the session ended; signing in again`);
      try { await this.reauth(); return true; }
      catch (e) { this.log(`signing in again failed: ${e.message}`); return false; }
      finally { setTimeout(() => { this.signingIn = null; }, 0); }
    })();
    return this.signingIn;
  }

  stop() {
    this.closed = true;
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const { ws, ping } of this.sockets.values()) { clearInterval(ping); ws.terminate(); }
    this.sockets.clear();
    this.connected.clear();
  }

  open(stream, attempt) {
    if (this.closed) return;
    // Node's built-in WebSocket reuses pooled HTTP connections, which the backend does not upgrade; `ws` always opens a
    // fresh connection.
    const token = this.currentToken() ?? "";
    const ws = new WebSocket(`${this.wsBase}/ws/${stream}?token=${encodeURIComponent(token)}`);
    const entry = { ws, ping: null, unauthorized: false, token };
    this.sockets.set(stream, entry);
    ws.on("open", () => {
      entry.ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 25000);
    });
    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "hello") { ws.send(JSON.stringify({ type: "subscribe", channel_id: this.channelId })); return; }
      if (m.type === "subscribed") {
        this.log(`subscribed to ${stream}`);
        this.connected.add(stream);
        this.emit("subscribed", stream, attempt > 0);
        if (attempt > 0) this.emit("reconnected", stream);
        attempt = 0;
        return;
      }
      if (m.type === "pong") return;
      if (m.type === "error") {
        if (m.error === "unauthorized") entry.unauthorized = true;
        this.log(`${stream} socket error: ${m.error}`);
        return;
      }
      this.emit("event", { stream, ...m });
    });
    ws.on("close", async (code, reason) => {
      clearInterval(entry.ping);
      this.connected.delete(stream);
      if (this.closed) return;
      // Refused for its session (expired or revoked): sign in again, then reconnect at once with the new token. A
      // failed sign-in falls back to the usual backoff, so a suspended account does not loop.
      const refused = entry.unauthorized || (code === 1008 && /unauthori[sz]ed/i.test(String(reason ?? "")));
      // Someone already signed in again since this socket opened (the other stream, a REST call): use that session.
      const renewed = refused && (this.currentToken() !== entry.token || await this.renew(stream));
      if (this.closed) return;
      const delay = renewed ? 0 : this.retryDelay(attempt);
      this.log(`${stream} socket closed; reconnecting in ${delay} ms`);
      const timer = setTimeout(() => { this.reconnectTimers.delete(timer); this.open(stream, renewed ? attempt : attempt + 1); }, delay);
      this.reconnectTimers.add(timer);
    });
    ws.on("error", (e) => this.log(`${stream} socket: ${e.message}`));
  }
}
