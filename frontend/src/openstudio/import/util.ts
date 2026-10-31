// Small helpers shared by the importers. They mirror the server's text:: helpers, which work on bytes: trim and
// lower only touch ASCII, and truncation counts UTF-8 bytes.

const ASCII_SPACE = ' \t\n\v\f\r';

export function asciiTrim(s: string): string {
  let a = 0, b = s.length;
  while (a < b && ASCII_SPACE.includes(s[a])) a++;
  while (b > a && ASCII_SPACE.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

// text::truncate: at most `maxBytes` UTF-8 bytes (never splitting a character), plus "…" when cut.
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0, end = 0;
  for (const ch of s) {
    const n = utf8Length(ch.codePointAt(0) ?? 0);
    if (bytes + n > maxBytes) return s.slice(0, end) + '…';
    bytes += n; end += ch.length;
  }
  return s;
}

// "2026/10/02 21:41:06" for a Unix time, read as UTC (the logs store local wall-clock time as if it were UTC).
export function formatUtc(seconds: number, dateSep = '/'): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${dateSep}${p(d.getUTCMonth() + 1)}${dateSep}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function isoUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// "2022/05/10 11:28:25", "2022-05-10 11:28:25", "2022-05-10T11:28" → Unix seconds (timegm); anything else → null.
const FULL_TIME = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;
export function parseTime(s: string): number | null {
  const m = FULL_TIME.exec(asciiTrim(s));
  if (!m) return null;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setUTCHours(Number(m[4]), Number(m[5]), m[6] !== undefined ? Number(m[6]) : 0, 0);
  const t = d.getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export type JsonObject = Record<string, unknown>;
export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// json::str: strings as they are, numbers and booleans as text, anything else → the default.
export function str(v: unknown, key: string, def = ''): string {
  if (!isObject(v)) return def;
  const x = v[key];
  if (typeof x === 'string') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  if (typeof x === 'boolean') return x ? 'true' : 'false';
  return def;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// json::toBool
export function bool(v: unknown, key: string, def = false): boolean {
  if (!isObject(v) || !(key in v)) return def;
  const x = v[key];
  if (typeof x === 'boolean') return x;
  if (typeof x === 'string') return x === 'true';
  if (typeof x === 'number') return Math.trunc(x) !== 0;
  return def;
}
