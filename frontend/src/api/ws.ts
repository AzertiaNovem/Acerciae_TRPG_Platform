import { getToken } from './client';

// Two sockets: chat traffic and context (document/highlight) traffic are kept apart so that a burst of
// document updates never delays message delivery and vice versa.
export type WsStream = 'chat' | 'context';
type Listener = (msg: any) => void;

class StreamSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private channels = new Set<string>();
  private spectating = new Set<string>();   // read-only Main Chat of channels the user is not in
  private retry = 1000;
  private closed = false;
  constructor(private stream: WsStream) {}

  connect() {
    this.closed = false;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = (import.meta.env.VITE_API_BASE as string | undefined) || `${proto}://${location.host}`;
    const url = base.replace(/^http/, 'ws') + `/ws/${this.stream}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 1000; for (const c of this.channels) ws.send(JSON.stringify({ type: 'subscribe', channel_id: c })); for (const c of this.spectating) ws.send(JSON.stringify({ type: 'subscribe', channel_id: c, spectate: true })); this.emit({ type: '_open' }); };
    ws.onmessage = (ev) => { try { this.emit(JSON.parse(ev.data)); } catch { /* ignore */ } };
    ws.onclose = () => { this.emit({ type: '_close' }); if (!this.closed) setTimeout(() => this.connect(), this.retry), this.retry = Math.min(this.retry * 2, 15000); };
    ws.onerror = () => ws.close();
  }
  close() { this.closed = true; this.ws?.close(); this.ws = null; }
  subscribe(channelId: string) { this.channels.add(channelId); if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId })); }
  unsubscribe(channelId: string) { this.channels.delete(channelId); if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', channel_id: channelId })); }
  spectate(channelId: string) { this.spectating.add(channelId); if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId, spectate: true })); }
  stopSpectating(channelId: string) { this.spectating.delete(channelId); if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', channel_id: channelId, spectate: true })); }
  on(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private emit(m: any) { for (const l of this.listeners) l(m); }
  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
}

export const chatSocket = new StreamSocket('chat');
export const contextSocket = new StreamSocket('context');
export function connectSockets() { chatSocket.connect(); contextSocket.connect(); }
export function closeSockets() { chatSocket.close(); contextSocket.close(); }
