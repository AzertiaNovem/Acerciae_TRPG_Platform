import { useEffect, useState } from 'react';
import { assetKey, cachedSrc, peekSrc } from '../lib/assetCache';

// The locally cached source for a media URL (lib/assetCache.ts): at once when this page already has it, otherwise once
// it is read from the cache or downloaded. With the picture's content hash the entry is the content itself; without
// one the key is the URL without its file token, so a renewed token does not reload anything either way.
export function useCachedSrc(url: string | null | undefined, hash?: string | null): string | undefined {
  const key = assetKey(url, hash);
  const [src, setSrc] = useState<string | undefined>(() => (key ? peekSrc(url, hash) : url || undefined));
  useEffect(() => {
    if (!url) { setSrc(undefined); return; }
    if (!key) { setSrc(url); return; }
    const hit = peekSrc(url, hash);
    if (hit) { setSrc(hit); return; }
    let live = true;
    setSrc(undefined);
    void cachedSrc(url, hash).then((s) => { if (live) setSrc(s); });
    return () => { live = false; };
    // The key, not the URL: only a different asset (or version, or content) loads anew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return src;
}
