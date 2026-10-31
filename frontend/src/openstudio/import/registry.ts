// Format detection (same order as the server's AdapterRegistry) and the entry points that read a file.
import type { ParsedLog } from '../types';
import type { LogAdapter } from './adapter';
import { decodeBytes } from './encoding';
import { qqExportAdapter, renderedLogAdapter, sealDiceTextAdapter } from './headerFormats';
import { nativeJsonAdapter, sealDiceJsonAdapter } from './jsonFormats';

export const ADAPTERS: readonly LogAdapter[] = [nativeJsonAdapter, sealDiceJsonAdapter, sealDiceTextAdapter, qqExportAdapter, renderedLogAdapter];

export function adapterByName(name: string): LogAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}

export function detectAdapter(text: string): LogAdapter | null {
  return ADAPTERS.find((a) => a.detect(text)) ?? null;
}

export function supportedFormats(): string[] {
  return ADAPTERS.map((a) => a.supportedVersions);
}

// Reads a log already decoded to text. `name` is the file name written into the events and issues.
export function importText(name: string, text: string): ParsedLog {
  const t = text.startsWith('﻿') ? text.slice(1) : text;
  const adapter = detectAdapter(t);
  if (!adapter) {
    throw new Error(`"${name}" is not a log format Open Log Studio can read. Supported formats:\n- ${supportedFormats().join('\n- ')}`);
  }
  return adapter.parse(t, name);
}

// Reads a log file: decodes the bytes (UTF-8, UTF-16 with a BOM, GBK/GB18030), detects the format and parses it.
// Platform ids (QQ numbers and the like) are dropped from the source text kept with each line as well: the
// header's "(1234567)" / "<1234567>" and the JSON items' IMUserId/uniformId. The message text is never touched.
const PLATFORM_ID = /\((?:QQ:)?\d{5,}\)|<(?:QQ:)?\d{5,}>/g;
export function scrubPlatformIds(log: ParsedLog): ParsedLog {
  for (const e of log.events) {
    const raw = e.raw ?? '';
    if (raw.startsWith('{')) {
      try { const j = JSON.parse(raw); delete j.IMUserId; delete j.uniformId; e.raw = JSON.stringify(j); continue; } catch { /* not JSON after all */ }
    }
    const lines = raw.split('\n');
    const body = e.content.split('\n');
    // Only header lines lose the id; lines that are part of the message stay as written.
    e.raw = lines.map((l) => (body.includes(l) ? l : l.replace(PLATFORM_ID, ''))).join('\n');
  }
  return log;
}

export function importFile(name: string, bytes: Uint8Array): ParsedLog {
  const { text, encoding } = decodeBytes(bytes);
  const log = scrubPlatformIds(importText(name, text));
  if (encoding === 'gb18030-inferred') {
    log.issues.unshift({ file: name, line: 0, raw: '', reason: 'the file is not UTF-8; it was read as GBK/GB18030', severity: 'warning' });
  }
  return log;
}
