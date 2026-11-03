// Shared offline engine. No Tauri, provider keys, network calls, or native bridge in generated documents.
import { importText, decodeBytes, scrubPlatformIds, buildProject, appendLogs, toNativeV2, toPlainText } from '../../frontend/src/openstudio/import';
import { isVisible, visibleCast } from '../../frontend/src/openstudio/render/common';
import { styledHtml, printHtml, normalizePdfConfig } from '../../frontend/src/openstudio/render';
import { composeScript } from '../../frontend/src/openstudio/vn/compose';
import { standaloneData, standaloneHtml } from '../../frontend/src/openstudio/vn/bundle';
import type { Project } from '../../frontend/src/openstudio/types';

const emptyBackground = { title: '', era: '', setting: '', summary: '' };
const localPath = (s: string) => /^assets\/[a-zA-Z0-9-]+\.(png|jpg|jpeg|webp)$/.test(s);
function check(p: Project) {
  if (!p || typeof p.title !== 'string' || !Array.isArray(p.events) || !Array.isArray(p.characters) || !Array.isArray(p.speakers) || !Array.isArray(p.sources) || !p.background) throw Error('Invalid project');
  if (p.events.length > 30000 || p.characters.length > 300 || JSON.stringify(p).length > 12 * 1024 * 1024) throw Error('Project is too large');
  return p;
}
function assetMap(input: Record<string,string> = {}) {
  let total = 0; const result: Record<string,string> = Object.create(null);
  for (const [key,value] of Object.entries(input)) {
    if (!localPath(key) || typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) throw Error('Invalid project image');
    total += value.length; if (total > 28 * 1024 * 1024) throw Error('Project images are too large');
    result[key] = value;
  }
  return result;
}
function secure(html: string) {
  return html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src data:">`);
}
export async function run(input: any): Promise<any> {
  const assets = assetMap(input.assets);
  if (input.action === 'import') {
    const files = (input.files ?? []).map((f: any) => {
      const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
      if (bytes.length > 32 * 1024 * 1024) throw Error('File is too large');
      return { name: String(f.name), text: decodeBytes(bytes).text };
    });
    if (!files.length) throw Error('Choose a log file');
    if (files.length === 1 && !input.project) {
      let archive: any; try { archive = JSON.parse(files[0].text); } catch {}
      if (archive?.format === 'acerciae-openstudio-mobile-1') {
        const project = check(archive.project); project.id = buildProject({title:"",background:emptyBackground,files:[]}).id;
        return { project, assets: assetMap(archive.assets) };
      }
    }
    const logs = files.map((f: any) => ({ file: f.name, log: scrubPlatformIds(importText(f.name, f.text)) }));
    let project: Project;
    if (input.project) { project = check(input.project); appendLogs(project, logs); }
    else project = buildProject({ title: '', background: emptyBackground, files: logs });
    if (!project.title) project.title = files[0].name.replace(/\.[^.]+$/, '');
    check(project); return { project, assets: {} };
  }
  const project = check(input.project);
  if (input.action === 'archive') return { text: JSON.stringify({ format:'acerciae-openstudio-mobile-1', project, assets }), ext:'json' };
  const visible = structuredClone(project);
  visible.events = visible.events.filter(e => isVisible(e, !!input.ooc, !!input.secret));
  visible.characters = visibleCast(project, visible.events);
  const speakers = new Set(visible.events.map(e => e.speaker_key));
  visible.speakers = visible.speakers.filter(s => speakers.has(s.key));
  if (input.action === 'native') return { text: JSON.stringify(toNativeV2(visible), null, 2), ext:'json' };
  if (input.action === 'text') return { text: toPlainText(visible), ext:'txt' };
  const options = { includeOoc: !!input.ooc, includeSecret: !!input.secret, lang:input.language ?? 'zh-CN', assetUrl:(ref:string) => assets[ref] ?? null };
  if (input.action === 'html') return { html:secure(styledHtml(project, options)) };
  if (input.action === 'pdf') return { html:secure(printHtml(project, normalizePdfConfig({ ...project.pdf, include_ooc:options.includeOoc }), options)) };
  if (input.action === 'vn') {
    const copy = visible;
    const script = await composeScript(copy, { llm:null, language:options.lang });
    // The offline planner normally hides chatter; an explicit export choice keeps OOC lines.
    if (options.includeOoc) {
      const events = new Map(copy.events.map(e => [e.seq,e]));
      for (const scene of script.scenes) for (const line of scene.lines) {
        if (events.get(line.seq)?.type === 'ooc' && line.exclusion_reason === 'out-of-character chatter') { line.hidden = false; delete line.exclusion_reason; }
      }
    }
    const background = assets[(project as any).mobile_background] ?? null;
    for (const scene of script.scenes) scene.background = background;
    for (const c of copy.characters) {
      c.avatar = assets[c.avatar ?? ''] ?? null; c.portrait = assets[c.portrait ?? ''] ?? null;
      c.poses = Object.fromEntries(Object.entries(c.poses).flatMap(([k,v]) => assets[v] ? [[k,assets[v]]] : []));
    }
    return { html:secure(standaloneHtml(standaloneData(copy, script, project.vn?.template ?? {}))) };
  }
  throw Error('Unknown studio action');
}
(globalThis as any).MobileStudio = { run: async (json: string) => {
  try { return JSON.stringify({ ok:true, value:await run(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok:false, error:error instanceof Error ? error.message : String(error) }); }
} };
