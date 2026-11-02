import type { ImgHTMLAttributes, ReactNode } from 'react';
import { useCachedSrc } from '../hooks/useCachedSrc';

// An <img> whose source comes from the local asset cache (lib/assetCache.ts). `hash` is the picture's content hash
// when the server named one, so the entry outlives versions and tokens. While the picture is being fetched the first
// time, `fallback` is shown (nothing by default) instead of a broken image.
export function CachedImg({ src, hash, fallback = null, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src?: string | null; hash?: string | null; fallback?: ReactNode }) {
  const cached = useCachedSrc(src, hash);
  if (!cached) return <>{fallback}</>;
  return <img {...rest} src={cached} />;
}
export default CachedImg;
