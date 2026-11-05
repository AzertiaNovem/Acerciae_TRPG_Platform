import { hybridProject, type HybridAsset, type HybridManifest } from './hybrid';
import type { Project } from './types';

export interface HybridImportIo {
  download: (asset: HybridAsset, signal: AbortSignal) => Promise<Uint8Array>;
  write: (id: string, bytes: Uint8Array, ext: string) => Promise<string>;
  save: (project: Project) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
const extOf: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
export async function importHybridManifest(manifest: HybridManifest, io: HybridImportIo, signal: AbortSignal,
  progress: (done: number, total: number) => void, id = crypto.randomUUID()): Promise<Project> {
  const paths = new Map<string, string>(), hashes = new Map<string, string>();
  try {
    if (manifest.format !== 'acerciae-hybrid-vn-1') throw new Error('Unsupported hybrid VN format');
    progress(0, manifest.assets.length);
    let done = 0;
    for (const asset of manifest.assets) {
      signal.throwIfAborted();
      const ext = extOf[asset.mime]; if (!ext) throw new Error(`Unsupported reference image format: ${asset.mime}`);
      let path = asset.hash ? hashes.get(asset.hash) : undefined;
      if (!path) {
        const bytes = await io.download(asset, signal);
        signal.throwIfAborted();
        if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Reference image exceeds the 64 MB limit or is empty');
        const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (asset.hash && asset.hash !== hash) throw new Error('Reference image checksum mismatch; download the project again');
        path = hashes.get(hash) || await io.write(id, bytes, ext);
        hashes.set(hash, path);
      }
      paths.set(asset.key, path); progress(++done, manifest.assets.length);
    }
    signal.throwIfAborted();
    const project = hybridProject(manifest, id, paths);
    await io.save(project);
    return project;
  } catch (error) {
    // This is a newly allocated project, never one the user has edited or generated art for.
    await io.remove(id).catch(() => undefined);
    throw error;
  }
}

// The image providers accept raster references. Decode SVG/GIF as an image (never as page markup),
// then keep a static PNG locally; the original download's hash was verified before this conversion.
async function rasterReference(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: ext === 'svg' ? 'image/svg+xml' : 'image/gif' }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const scale = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Cannot prepare the reference image');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Cannot prepare the reference image')), 'image/png'));
    return new Uint8Array(await png.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}

export async function downloadHybridProject(channelId: string, presentationId: string, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<Project> {
  const [{ api, getToken }, { apiBase }, storage, { fetch: nativeFetch }] = await Promise.all([
    import('../api/client'), import('../lib/platform'), import('./storage'), import('@tauri-apps/plugin-http'),
  ]);
  const base = apiBase(), token = getToken();
  const manifest = await api.hybridVn(channelId, presentationId);
  const download: HybridImportIo['download'] = async (asset, signal) => {
    // Credentials go only to the configured platform. Public assets then come directly from the bucket,
    // without carrying the platform session token to it or persisting signed URLs in the local project.
    const url = `${base}/api/channels/${encodeURIComponent(channelId)}/media/${encodeURIComponent(asset.id)}?v=${asset.version}&direct=1`;
    let response = await nativeFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal });
    if (!response.ok) throw new Error(`Reference image download failed: HTTP ${response.status}`);
    if ((response.headers.get('Content-Type') ?? '').startsWith('application/vnd.acerciae.direct+json')) {
      const direct = await response.json(); const target = new URL(direct.url);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Invalid public image address');
      response = await nativeFetch(target.href, { method: 'GET', redirect: 'error', signal });
      if (!response.ok) throw new Error(`Reference image download failed: HTTP ${response.status}`);
    }
    if (Number(response.headers.get('Content-Length')) > 64 * 1024 * 1024) throw new Error('Reference image exceeds the 64 MB limit');
    return new Uint8Array(await response.arrayBuffer());
  };
  const write: HybridImportIo['write'] = async (id, bytes, ext) => {
    if (ext === 'svg' || ext === 'gif') { bytes = await rasterReference(bytes, ext); ext = 'png'; }
    signal.throwIfAborted();
    return storage.writeAsset(id, bytes, ext);
  };
  return importHybridManifest(manifest, { download, write, save: storage.saveProject, remove: storage.deleteProject }, signal, progress);
}
