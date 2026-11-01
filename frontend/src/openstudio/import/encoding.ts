// Bytes → text, as the server's normaliseEncoding: UTF-8 (with or without BOM), UTF-16 LE/BE with a BOM, and
// GB18030/GBK when the bytes are not valid UTF-8.

export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030-inferred';

function decode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;   // invalid bytes (or, for gb18030, a runtime without that decoder)
  }
}

export function decodeBytes(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    const le = bytes[0] === 0xff;
    const text = decode(le ? 'utf-16le' : 'utf-16be', bytes.subarray(2));
    if (text === null) throw new Error('invalid UTF-16; re-export the log as UTF-8');
    return { text, encoding: le ? 'utf-16le' : 'utf-16be' };
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const utf8 = decode('utf-8', bom ? bytes.subarray(3) : bytes);
  if (utf8 !== null) return { text: utf8, encoding: bom ? 'utf-8-bom' : 'utf-8' };
  const gb = decode('gb18030', bytes);
  if (gb !== null) return { text: gb, encoding: 'gb18030-inferred' };
  throw new Error('unknown or invalid log encoding; re-export the log as UTF-8 (UTF-16 with a BOM and GBK/GB18030 are also read)');
}
