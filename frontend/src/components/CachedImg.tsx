import type { ImgHTMLAttributes, ReactNode } from 'react';
import { useAssetUrl } from '../hooks/useAssetUrl';

// An <img> whose bytes come from the device cache when they are there (see lib/assetCache). While the asset is being
// fetched the first time, `fallback` is shown (nothing by default) instead of a broken image.
export default function CachedImg({ cacheKey, src, fallback = null, ...img }: { cacheKey: string | null; src: string; fallback?: ReactNode } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const url = useAssetUrl(cacheKey, src);
  if (!url) return <>{fallback}</>;
  return <img src={url} {...img} />;
}
