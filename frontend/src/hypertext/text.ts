// Text rules shared by every string of a card. Lengths count code points ([...s].length here; text::utf8Length in
// C++, codePointCount in Kotlin, unicodeScalars.count in Swift). Refused: C0 controls (except \n where the text is
// multi-line), bidi embeddings/overrides/isolates (U+202A–202E, U+2066–2069) so a card cannot spoof its frame or the
// provenance pill, lone surrogates and noncharacters. Written without lookbehind: older WebViews cannot parse it.

export const cpLength = (s: string) => [...s].length;
export const cpPrefix = (s: string, n: number) => { const cps = [...s]; return cps.length <= n ? s : cps.slice(0, n).join(''); };

/** UTF-8 byte length (lone surrogates count as the 3 bytes of U+FFFD, as TextEncoder writes them). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** The first refused code point's index (in code units), or -1 when the text is allowed. */
export function badCharAt(s: string, multiline = false): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) { if (c === 0x0a && multiline) continue; return i; }
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return i;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if ((d & 0xfc00) !== 0xdc00) return i;
      const cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
      if ((cp & 0xfffe) === 0xfffe) return i;
      i++; continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return i;
    if ((c >= 0xfdd0 && c <= 0xfdef) || c === 0xfffe || c === 0xffff) return i;
  }
  return -1;
}
export const textOk = (s: string, multiline = false) => badCharAt(s, multiline) < 0;

/** An allowed string of `min` to `max` code points. */
export const boundedText = (s: unknown, max: number, multiline = false, min = 0): s is string =>
  typeof s === 'string' && textOk(s, multiline) && cpLength(s) >= min && cpLength(s) <= max;

/** Refused characters become U+FFFD: for diagnostics (logs, error messages) that are shown, never sent. */
export function sanitize(s: string, multiline = true): string {
  let out = '', i: number;
  while ((i = badCharAt(s, multiline)) >= 0) {
    const pair = (s.charCodeAt(i) & 0xfc00) === 0xd800 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    out += s.slice(0, i) + '\ufffd'; s = s.slice(i + (pair ? 2 : 1));
  }
  return out + s;
}

/** Lines as a reader sees them: \n, and the breaks the text rules let through (U+0085, U+2028, U+2029). */
export const lineCount = (s: string) => s.split(/[\n\u0085\u2028\u2029]/).length;

/** Nesting depth of a JSON text, scanned before JSON.parse so a deep document cannot exhaust the parser's stack. */
export function jsonDepth(raw: string): number {
  let depth = 0, max = 0, str = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (str) { if (c === 0x5c) i++; else if (c === 0x22) str = false; continue; }
    if (c === 0x22) str = true;
    else if (c === 0x5b || c === 0x7b) { if (++depth > max) max = depth; }
    else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}

/** Trim as the server does (C++ text::trim: ASCII whitespace only, so a full-width space is kept). */
export function asciiTrim(s: string): string {
  const ws = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  let a = 0, b = s.length;
  while (a < b && ws(s.charCodeAt(a))) a++;
  while (b > a && ws(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Ids, state keys and handler names: ^[a-z][a-z0-9_]{0,31}$, never a JS prototype name. The same list as the server's
 *  kReserved (backend/src/chat/Hypertext.cpp); the names that start with "_" already fail the pattern. */
const RESERVED = new Set(['constructor', 'prototype', 'hasownproperty', 'isprototypeof', 'propertyisenumerable', 'tolocalestring', 'tostring', 'valueof']);
export const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(s) && !RESERVED.has(s);

/** Own-property lookups only: card keys are untrusted, so `in` and plain indexing could reach Object.prototype. */
export const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
