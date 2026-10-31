// Small string helpers with the server's semantics (lengths are UTF-8 bytes, like std::string sizes), so limits
// such as "80" or "2000" cut the same text as VnScriptService does.

const encoder = new TextEncoder();

/** UTF-8 length of one code point. */
function cpBytes(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** UTF-8 length of a string. */
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** Cut to at most n bytes without splitting a character; strips control characters except newlines. */
export function clip(s: string, n: number): string {
  let out = '';
  let size = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const len = cpBytes(cp);
    if (size + len > n) break;
    if (cp < 0x20 && cp !== 0x0a) continue;
    out += ch;
    size += len;
  }
  return out;
}

/** At most n bytes of s, whole characters only (control characters kept). */
export function utf8Prefix(s: string, n: number): string {
  let out = '';
  let size = 0;
  for (const ch of s) {
    const len = cpBytes(ch.codePointAt(0)!);
    if (size + len > n) break;
    out += ch;
    size += len;
  }
  return out;
}

export function trim(s: string): string {
  return s.replace(/^[\s]+|[\s]+$/g, '');
}

export function lower(s: string): string {
  return s.toLowerCase();
}

export function icontains(hay: string, needle: string): boolean {
  if (!needle) return false;
  return lower(hay).includes(lower(needle));
}

/** Alphanumeric tokens (apostrophes and non-ASCII characters count as word characters), as text::words. */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80 || /[A-Za-z0-9']/.test(ch)) cur += ch;
    else if (cur) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

/** The server's json::str: a string member, a number or boolean as text, else the fallback. */
export function str(v: unknown, key: string, def = ''): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return def;
  const x = (v as Record<string, unknown>)[key];
  if (typeof x === 'string') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  if (typeof x === 'boolean') return x ? 'true' : 'false';
  return def;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Array members only; anything else reads as empty. */
export function arr(v: unknown, key?: string): unknown[] {
  const x = key === undefined ? v : isObject(v) ? v[key] : undefined;
  return Array.isArray(x) ? x : [];
}

/** "L12" → 11 (zero-based) when in range. */
export function lineRef(v: unknown, count: number): number | null {
  if (typeof v !== 'string' || v.length < 2 || (v[0] !== 'L' && v[0] !== 'l')) return null;
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57 || i > 7) return null;
    n = n * 10 + (c - 48);
  }
  if (n === 0 || n > count) return null;
  return n - 1;
}

/** Stable scene key: ASCII letters/digits lowered, separators collapsed, non-ASCII (e.g. Chinese) kept as is. */
export function slugKey(raw: string, fallbackIndex: number): string {
  let k = '';
  let size = 0;
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80) { k += ch; size += cpBytes(cp); }
    else if (/[A-Za-z0-9]/.test(ch)) { k += ch.toLowerCase(); size += 1; }
    else if ((ch === '-' || ch === '_' || ch === ' ') && k && !k.endsWith('-')) { k += '-'; size += 1; }
    if (size >= 96) break;
  }
  k = clip(k, 48);
  while (k.endsWith('-')) k = k.slice(0, -1);
  return k || `scene-${fallbackIndex + 1}`;
}

export function oneOf<T extends string>(v: unknown, key: string, allowed: readonly T[], fallback: T): T {
  const s = str(v, key);
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

export function replaceQuotes(s: string): string {
  return s.replace(/"/g, "'");
}
