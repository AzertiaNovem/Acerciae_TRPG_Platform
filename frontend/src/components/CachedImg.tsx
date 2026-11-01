import type { ImgHTMLAttributes } from 'react';
import { useCachedSrc } from '../hooks/useCachedSrc';

// An <img> whose source comes from the local asset cache (lib/assetCache.ts).
export function CachedImg({ src, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src?: string | null }) {
  const cached = useCachedSrc(src);
  return <img {...rest} src={cached} />;
}
