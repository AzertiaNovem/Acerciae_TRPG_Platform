import { useEffect, useState } from 'react';
import { assetUrls } from '../storage';

// URLs for a project's asset paths (asset protocol) and http(s) links, refreshed when the set of paths changes.
export function useAssetUrls(projectId: string, paths: (string | null | undefined)[]): (path: string | null | undefined) => string | null {
  const list = [...new Set(paths.filter((p): p is string => !!p))].sort();
  const key = list.join('|');
  const [map, setMap] = useState<Map<string, string>>(new Map());
  useEffect(() => { let live = true; assetUrls(projectId, list).then((m) => { if (live) setMap(m); }).catch(() => undefined); return () => { live = false; }; }, [projectId, key]);
  return (p) => (p ? map.get(p) ?? (/^https?:/i.test(p) ? p : null) : null);
}
