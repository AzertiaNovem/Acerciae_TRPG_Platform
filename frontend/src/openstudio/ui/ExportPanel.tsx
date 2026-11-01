import { t as tr, useLocale } from '../../i18n';
import { useState } from 'react';
import { useUi } from '../../store/ui';
import { toNativeV2, toPlainText, toSealDiceText } from '../import';
import { normalizePdfConfig, printHtml, styledHtml } from '../render';
import type { Project } from '../types';
import type { PdfConfig } from '../../components/studio/publicationApi';
import { assetUrls, exportToFolder, printHtml as openPrint, saveTextFile, type ExportFile } from '../storage';

const slug = (s: string) => (s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'log').slice(0, 60);

// The log as files: the native format, SealDice text, plain text; a styled HTML page; a PDF through the print dialog.
export default function ExportPanel({ p, update }: { p: Project; update: (fn: (d: Project) => void) => void }) {
  const toast = useUi((s) => s.toast);
  const lang = useLocale((s) => s.language);
  const [ooc, setOoc] = useState(false);
  const [secret, setSecret] = useState(false);
  const cfg = normalizePdfConfig((p.pdf ?? {}) as Partial<PdfConfig>);
  const setCfg = (patch: Partial<PdfConfig>) => update((d) => { d.pdf = { ...(d.pdf ?? {}), ...patch }; });
  const run = async (fn: () => Promise<unknown>) => { try { const r = await fn(); if (r) toast(tr('Saved')); } catch (e: any) { toast(String(e?.message ?? e), 'error'); } };
  const name = slug(p.title);
  // Images the HTML shows, copied next to it so the folder works anywhere.
  const pictures = (): ExportFile[] => [...new Set(p.characters.flatMap((c) => [c.avatar, c.portrait]).filter((x): x is string => !!x && !/^https?:/i.test(x)))].map((a) => ({ path: a, asset: a }));
  const html = () => run(async () => {
    const page = styledHtml(p, { includeOoc: ooc, includeSecret: secret, assetUrl: (ref) => ref, lang });
    return exportToFolder(p.id, name, [{ path: 'index.html', content: page }, ...pictures()]);
  });
  const pdf = () => run(async () => {
    const urls = await assetUrls(p.id, [...p.characters.flatMap((c) => [c.avatar, c.portrait]), cfg.cover_asset_id, ...Object.values(cfg.scene_images ?? {})].filter((x): x is string => !!x));
    await openPrint(printHtml(p, cfg, { includeOoc: ooc, includeSecret: secret, assetUrl: (ref) => urls.get(ref) ?? null, lang }), p.title);
    return false;
  });
  return (
    <div className="col" style={{ gap: 12, maxWidth: 860 }}>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr('Log files')}</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="small" onClick={() => run(() => saveTextFile(`${name}.acerciae-log.json`, JSON.stringify(toNativeV2(p), null, 2), { name: 'Acerciae log', extensions: ['json'] }))}>{tr('Acerciae log (JSON)')}</button>
          <button className="small" onClick={() => run(() => saveTextFile(`${name}.sealdice.txt`, toSealDiceText(p), { name: 'SealDice', extensions: ['txt'] }))}>{tr('SealDice text')}</button>
          <button className="small" onClick={() => run(() => saveTextFile(`${name}.txt`, toPlainText(p), { name: 'Text', extensions: ['txt'] }))}>{tr('Plain text')}</button>
        </div>
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr('What the HTML and PDF show')}</h3>
        <label className="row tiny"><input type="checkbox" checked={ooc} onChange={(e) => setOoc(e.target.checked)} />{tr('Out-of-character chatter')}</label>
        <label className="row tiny"><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />{tr('Secret lines (Keeper-only and observers)')}</label>
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr('Styled HTML')}</h3>
        <p className="tiny muted" style={{ margin: 0 }}>{tr('A page with the background, the cast and the whole log by scene, saved in a folder with its pictures.')}</p>
        <div><button className="primary small" onClick={html}>{tr('Save HTML…')}</button></div>
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>PDF</h3>
        <p className="tiny muted" style={{ margin: 0 }}>{tr('Opens the print-ready book in its own window with the system print dialog: choose "Save as PDF".')}</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="tiny">{tr('Style')} <select value={cfg.base} onChange={(e) => setCfg({ base: e.target.value })}><option value="classic">{tr('Classic')}</option><option value="novel">{tr('Novel')}</option><option value="dossier">{tr('Dossier')}</option></select></label>
          <label className="tiny">{tr('Page')} <select value={cfg.page_size} onChange={(e) => setCfg({ page_size: e.target.value })}><option value="A4">A4</option><option value="A5">A5</option><option value="B5">B5</option></select></label>
          <label className="tiny">{tr('Orientation')} <select value={cfg.orientation} onChange={(e) => setCfg({ orientation: e.target.value })}><option value="portrait">{tr('Portrait')}</option><option value="landscape">{tr('Landscape')}</option></select></label>
          <label className="tiny">{tr('Font size')} <input type="number" min={8} max={16} value={cfg.font_size} onChange={(e) => setCfg({ font_size: +e.target.value })} style={{ width: 60 }} /></label>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="row tiny"><input type="checkbox" checked={cfg.toc} onChange={(e) => setCfg({ toc: e.target.checked })} />{tr('Table of contents')}</label>
          <label className="row tiny"><input type="checkbox" checked={cfg.timestamps} onChange={(e) => setCfg({ timestamps: e.target.checked })} />{tr('Times')}</label>
          <label className="row tiny"><input type="checkbox" checked={cfg.chapter_breaks} onChange={(e) => setCfg({ chapter_breaks: e.target.checked })} />{tr('Each scene on a new page')}</label>
          <label className="row tiny"><input type="checkbox" checked={cfg.include_ooc} onChange={(e) => setCfg({ include_ooc: e.target.checked })} />{tr('OOC in the book')}</label>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input placeholder={tr('Book title')} value={cfg.title} onChange={(e) => setCfg({ title: e.target.value })} />
          <input placeholder={tr('Subtitle')} value={cfg.subtitle} onChange={(e) => setCfg({ subtitle: e.target.value })} />
        </div>
        <div><button className="primary small" onClick={pdf}>{tr('Print / Save as PDF…')}</button></div>
      </div>
    </div>
  );
}
