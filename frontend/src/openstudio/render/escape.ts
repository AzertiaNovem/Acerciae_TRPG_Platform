// Escaping for everything the renderers write: element text, attribute values, CSS strings and URLs.
// Every piece of log text, name, title or setting passes through one of these before it reaches the output.

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes text for element content and quoted attribute values. Strips characters HTML cannot carry. */
export function esc(value: unknown): string {
  return String(value ?? '')
    // NUL and the C0/C1 controls other than tab/newline/CR are not valid in HTML text.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** A quoted CSS string (for `content:` in @page margin boxes). Escapes everything that could end the string or the style. */
export function cssString(value: unknown): string {
  let out = '"';
  for (const ch of String(value ?? '')) {
    const cp = ch.codePointAt(0)!;
    const control = cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
    if (control) out += ch === '\n' ? '\\a ' : '';
    else if ('"\\<>&'.includes(ch)) out += `\\${cp.toString(16)} `;
    else out += ch;
  }
  return out + '"';
}

/** #RRGGBB only. */
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

const RASTER_DATA_URI = /^data:image\/(png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * A URL that may appear in a src/href: http(s), raster data: images, blob:, Tauri's asset: protocol, or a relative
 * path without a scheme (e.g. "assets/x.png" next to an exported file). Anything else (javascript:, vbscript:,
 * data:text/html, file:, …) is dropped.
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = String(url).trim();
  if (!u || /[\u0000-\u001F\u007F]/.test(u)) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^data:/i.test(u)) return RASTER_DATA_URI.test(u) ? u.replace(/\s+/g, '') : null;
  if (/^(blob|asset):/i.test(u)) return u;
  // No scheme at all: a relative path. A colon before the first "/", "?" or "#" would be a scheme.
  const head = u.split(/[/?#]/, 1)[0];
  if (!head.includes(':') && !u.startsWith('//')) return u;
  return null;
}

/** http(s) or raster data: URI written directly in the project (e.g. an avatar from a native export). */
const isDirectUrl = (ref: string) => /^https?:\/\//i.test(ref) || /^data:image\//i.test(ref);

/**
 * Turns an asset reference (project-relative path, or an http(s) URL from a native export) into a safe URL:
 * the caller's assetUrl first, then the reference itself when it already is an http(s)/data: image URL.
 */
export function resolveAsset(ref: string | null | undefined, assetUrl: (ref: string) => string | null): string | null {
  if (!ref || typeof ref !== 'string') return null;
  let mapped: string | null = null;
  try { mapped = assetUrl(ref); } catch { mapped = null; }
  return safeUrl(mapped) ?? (isDirectUrl(ref) ? safeUrl(ref) : null);
}

/** The Content-Security-Policy every rendered document carries: no scripts, no frames, images only. */
export const DOCUMENT_CSP =
  "default-src 'none'; img-src 'self' * data: blob: asset: http://asset.localhost https://asset.localhost; style-src 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'";
