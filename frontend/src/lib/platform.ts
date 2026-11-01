import { readStorage, writeStorage } from './storage';

// Web or desktop. On the web the API is the page's own origin (or VITE_API_BASE); the desktop app (Tauri, the
// system's own web view) talks to a server whose address is chosen on the sign-in screen.
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const DEFAULT_SERVER = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || 'https://trpg.missazertia.com';
const SERVER_KEY = 'acerciae.server_url';   // ('acerciae.server' holds the last server picked in the sidebar)

// "trpg.example.com" → "https://trpg.example.com"; no trailing slash, no path. Throws on anything else.
export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Enter the server address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('The server must use https:// (http:// only for localhost).');
  return `${u.protocol}//${u.host}`;
}
export function serverUrl(): string {
  const saved = readStorage(SERVER_KEY);
  try { return saved ? normalizeServer(saved) : DEFAULT_SERVER; } catch { return DEFAULT_SERVER; }
}
export function setServerUrl(url: string) { writeStorage(SERVER_KEY, normalizeServer(url) === DEFAULT_SERVER ? null : normalizeServer(url)); }

// The origin every API path is resolved against.
export function apiBase(): string {
  return isDesktop ? serverUrl() : ((import.meta.env.VITE_API_BASE as string | undefined) || '');
}
// The origin of the web app, for links people share (invites, published logs).
export function webOrigin(): string { return isDesktop ? serverUrl() : location.origin; }
