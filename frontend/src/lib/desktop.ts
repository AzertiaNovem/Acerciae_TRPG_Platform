// Desktop-only features (the Tauri shell): native downloads, a visual novel saved file by file, system
// notifications, links opened in the user's browser. Loaded lazily, and only when running in the desktop app.
import { apiBase, isDesktop } from './platform';
import { t } from '../i18n';

const core = () => import('@tauri-apps/api/core');

// GET a URL and save the answer where the user picks (the name comes from the server when it gives one).
export async function downloadToFile(url: string, suggestedName?: string): Promise<string | null> {
  const { invoke } = await core();
  return invoke<string | null>('download_file', { url, suggestedName: suggestedName ?? null });
}

export interface ManifestFile { path: string; url?: string; content?: string; bytes?: number }
export interface SaveReport { dir: string; written: number; skipped: number; failed: string[] }
// Saves files into <chosen folder>/<folder>/: inline ones written, the others downloaded (four at a time), files
// already there with the same size skipped, so saving again only fetches what changed.
export async function saveFilesToFolder(folder: string, files: ManifestFile[], onProgress?: (done: number, total: number) => void): Promise<SaveReport | null> {
  const [{ invoke }, { open }, { listen }] = await Promise.all([core(), import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/event')]);
  const parent = await open({ directory: true, multiple: false, title: 'Save the visual novel into…' });
  if (!parent || Array.isArray(parent)) return null;
  const unlisten = await listen<{ done: number; total: number }>('files-progress', (e) => onProgress?.(e.payload.done, e.payload.total));
  try { return await invoke<SaveReport>('save_files', { parent, folder, files }); }
  finally { unlisten(); }
}
export async function showInFolder(path: string) {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}
export async function openExternal(url: string) {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

// System notifications: permission is asked once, the first time one is needed.
let permission: Promise<boolean> | null = null;
export async function notifySystem(title: string, body: string) {
  const n = await import('@tauri-apps/plugin-notification');
  permission ??= (async () => (await n.isPermissionGranted()) || (await n.requestPermission()) === 'granted')();
  if (!(await permission)) return;
  n.sendNotification({ title, body });
  try { const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window'); await getCurrentWindow().requestUserAttention(UserAttentionType.Informational); } catch { /* not supported here */ }
}

// Links: files of the API are saved with a native dialog, everything else opens in the user's browser (the app
// window only ever shows the app itself).
export function installLinkHandling() {
  if (!isDesktop) return;
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.href;
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    const api = apiBase();
    const isApiFile = href.startsWith(api + '/api/') && a.target !== '_blank';
    if (!isApiFile) { openExternal(href).catch((err) => console.error(err)); return; }
    import('../store/ui').then(({ useUi }) => downloadToFile(href, a.getAttribute('download') || undefined)
      .then((path) => { if (path) useUi.getState().toast(t('Saved {name}', { name: path.split(/[\\/]/).pop() ?? path })); })
      .catch((err) => useUi.getState().toast(String(err?.message ?? err), 'error')));
  }, true);
}
