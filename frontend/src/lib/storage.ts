// localStorage can be blocked (private modes, policies) or hold corrupt values; the app must start anyway.
export function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeStorage(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
export function readJson<T>(key: string, fallback: T): T {
  try { const raw = readStorage(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
