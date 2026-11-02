import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { peekAsset, resolveAsset } from '../lib/assetCache';

// The URL an <img>, <audio> or CSS background should use for a cached asset: '' until it is known (from this device or
// fetched once), then a blob: URL that stays valid for the session. Without a key (content that may change) the direct
// URL comes back at once.
export function useAssetUrl(key: string | null, url: string): string {
  const [value, setValue] = useState(() => (key ? peekAsset(key) ?? '' : url));
  useEffect(() => {
    if (!key) { setValue(url); return; }
    const hit = peekAsset(key);
    if (hit) { setValue(hit); return; }
    let live = true; setValue('');
    resolveAsset(key, url).then((u) => { if (live) setValue(u); });
    return () => { live = false; };
  }, [key, url]);
  return value;
}

// For a component that shows many assets at once (the visual novel stage): `resolve(key, url)` answers synchronously
// with the cached URL, or '' while the asset is fetched, and re-renders the component when it arrives.
export function useAssetResolver(): (key: string | null, url: string) => string {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const inFlight = useRef(new Set<string>());
  return useCallback((key: string | null, url: string) => {
    if (!key) return url;
    const hit = peekAsset(key);
    if (hit) return hit;
    if (!inFlight.current.has(key)) {
      inFlight.current.add(key);
      resolveAsset(key, url).finally(() => { inFlight.current.delete(key); bump(); });
    }
    return '';
  }, []);
}
