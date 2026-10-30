// The two WebSocket streams (/ws/chat and /ws/context): subscribe to one channel, keep the connection alive and
// reconnect with backoff. Emits "event" ({stream, ...payload}) and "reconnected" (refetch what may have been missed).
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export class Realtime extends EventEmitter {
  constructor({ apiBase, token, channelId, streams = ["chat", "context"], log = () => {} }) {
    super();
    this.wsBase = apiBase.replace(/^http/, "ws");
    this.token = token;
    this.channelId = channelId;
    this.streams = streams;
    this.log = log;
    this.sockets = new Map();
    this.closed = false;
  }

  start() { for (const s of this.streams) this.open(s, 0); }

  stop() {
    this.closed = true;
    for (const { ws, ping } of this.sockets.values()) { clearInterval(ping); ws.terminate(); }
    this.sockets.clear();
  }

  open(stream, attempt) {
    if (this.closed) return;
    // Node's built-in WebSocket reuses pooled HTTP connections, which the backend does not upgrade; `ws` always opens a
    // fresh connection.
    const ws = new WebSocket(`${this.wsBase}/ws/${stream}?token=${encodeURIComponent(this.token)}`);
    const entry = { ws, ping: null };
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
        if (attempt > 0) this.emit("reconnected", stream);
        attempt = 0;
        return;
      }
      if (m.type === "pong") return;
      if (m.type === "error") { this.log(`${stream} socket error: ${m.error}`); return; }
      this.emit("event", { stream, ...m });
    });
    ws.on("close", () => {
      clearInterval(entry.ping);
      if (this.closed) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      this.log(`${stream} socket closed; reconnecting in ${delay} ms`);
      setTimeout(() => this.open(stream, attempt + 1), delay);
    });
    ws.on("error", (e) => this.log(`${stream} socket: ${e.message}`));
  }
}
