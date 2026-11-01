// Open Log Studio projects and their files on this computer (the desktop app's data folder), and provider keys
// in the system keychain. Thin wrappers over the app's native commands.
import type { Project } from './types';

const core = () => import('@tauri-apps/api/core');

export interface ProjectMeta { id: string; title: string; updated_at: string; created_at: string; events: number; characters: number }

export async function listProjects(): Promise<ProjectMeta[]> { const { invoke } = await core(); return invoke('project_list'); }
export async function loadProject(id: string): Promise<Project> { const { invoke } = await core(); return JSON.parse(await invoke<string>('project_load', { id })); }
export async function saveProject(p: Project): Promise<void> {
  const { invoke } = await core();
  p.updated_at = new Date().toISOString();
  const meta: ProjectMeta = { id: p.id, title: p.title, updated_at: p.updated_at, created_at: p.created_at, events: p.events.length, characters: p.characters.length };
  await invoke('project_save', { id: p.id, data: JSON.stringify(p), meta });
}
export async function deleteProject(id: string): Promise<void> { const { invoke } = await core(); await invoke('project_delete', { id }); }

// Files of a project: stored under assets/, shown through the asset protocol, read back as bytes.
export async function writeAsset(projectId: string, bytes: Uint8Array, ext: string): Promise<string> {
  const { invoke } = await core();
  return invoke<string>('asset_write', bytes, { headers: { 'x-project': projectId, 'x-ext': ext } });
}
export async function importAsset(projectId: string, source: string): Promise<string> { const { invoke } = await core(); return invoke('asset_import', { project: projectId, source }); }
export async function readAsset(projectId: string, path: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>('asset_read', { project: projectId, path }));
}
export async function assetAbsolutePath(projectId: string, path: string): Promise<string> { const { invoke } = await core(); return invoke('asset_path', { project: projectId, path }); }

// URLs for <img>/<audio>: project assets through the asset protocol, http(s) links (from a native export) as they are.
const urlCache = new Map<string, string>();
export async function assetUrls(projectId: string, paths: string[]): Promise<Map<string, string>> {
  const { convertFileSrc, invoke } = await core();
  const out = new Map<string, string>();
  for (const p of paths) {
    if (!p) continue;
    if (/^https?:\/\//i.test(p)) { out.set(p, p); continue; }
    const key = projectId + '|' + p;
    if (!urlCache.has(key)) urlCache.set(key, convertFileSrc(await invoke<string>('asset_path', { project: projectId, path: p })));
    out.set(p, urlCache.get(key)!);
  }
  return out;
}

export interface ExportFile { path: string; content?: string; asset?: string }
export interface ExportReport { dir: string; written: number; skipped: number; failed: string[] }
// Asks for a folder and writes the files into <folder>/<name>/.
export async function exportToFolder(projectId: string, name: string, files: ExportFile[]): Promise<ExportReport | null> {
  const [{ invoke }, { open }] = await Promise.all([core(), import('@tauri-apps/plugin-dialog')]);
  const parent = await open({ directory: true, multiple: false });
  if (!parent || Array.isArray(parent)) return null;
  return invoke<ExportReport>('export_files', { project: projectId, parent, folder: name, files });
}
// Asks where to save one text file.
export async function saveTextFile(defaultName: string, content: string, filter: { name: string; extensions: string[] }): Promise<string | null> {
  const [{ save }, { invoke }] = await Promise.all([import('@tauri-apps/plugin-dialog'), core()]);
  const path = await save({ defaultPath: defaultName, filters: [filter] });
  if (!path) return null;
  await invoke('save_text', { path, content });
  return path;
}
// Opens print-ready HTML in its own window with the system print dialog ("Save as PDF").
export async function printHtml(html: string, title: string): Promise<void> { const { invoke } = await core(); await invoke('print_html', { html, title }); }

// Provider keys, kept in the system keychain.
export async function getSecret(name: string): Promise<string | null> { const { invoke } = await core(); return invoke('secret_get', { name }); }
export async function setSecret(name: string, value: string): Promise<void> { const { invoke } = await core(); await invoke(value ? 'secret_set' : 'secret_delete', value ? { name, value } : { name }); }
