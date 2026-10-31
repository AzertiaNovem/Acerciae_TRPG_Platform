import { t as tr } from '../../i18n';
import { useState } from 'react';
import { api, ensureFileToken } from '../../api/client';
import { apiBase } from '../../lib/platform';
import { useUi } from '../../store/ui';
import type { VideoProgress, VideoQuality } from './vn/videoExport';

// Desktop app only: the visual novel saved file by file into a folder (saving again fetches only what changed), or
// turned into a video.
export default function DesktopVnTools({ channelId, presentationId }: { channelId: string; presentationId: string }) {
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [quality, setQuality] = useState<VideoQuality>('lossless');
  const [height, setHeight] = useState<720 | 1080>(1080);

  const saveFiles = async () => {
    setBusy(tr('Preparing…')); setSaved(null);
    try {
      const [m, token, desktop] = await Promise.all([api.vnFiles(channelId, presentationId), ensureFileToken(), import('../../lib/desktop')]);
      const files = m.files.map((f) => (f.url ? { ...f, url: `${apiBase()}${f.url}${f.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` } : f));
      const r = await desktop.saveFilesToFolder(m.folder, files, (done, total) => setBusy(tr('Saving files… {done}/{total}', { done, total })));
      if (!r) return;
      setSaved(r.dir);
      if (r.failed.length) toast(tr('{n} files could not be saved: {first}', { n: r.failed.length, first: r.failed[0] }), 'error');
      else toast(tr('Saved: {written} new or changed, {skipped} already there', { written: r.written, skipped: r.skipped }));
    } catch (e: any) { toast(e?.message ?? String(e), 'error'); }
    finally { setBusy(null); }
  };

  const video = async () => {
    setBusy(tr('Preparing…')); setSaved(null);
    try {
      const { exportVideo } = await import('./vn/videoExport');
      const label = (p: VideoProgress) => p.phase === 'prepare' ? tr('Loading pictures… {done}/{total}', { done: p.done, total: p.total })
        : p.phase === 'frames' ? tr('Drawing lines… {done}/{total}', { done: p.done, total: p.total })
        : p.phase === 'voices' ? tr('Fetching voices… {done}/{total}', { done: p.done, total: p.total })
        : tr('Encoding… {percent}%', { percent: p.total ? Math.floor((p.done / p.total) * 100) : 0 });
      const out = await exportVideo(channelId, presentationId, quality, height, (p) => setBusy(label(p)));
      if (out) { setSaved(out); toast(tr('Video saved')); }
    } catch (e: any) { toast(e?.message ?? String(e), 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <button className="small" disabled={!!busy} onClick={saveFiles} title={tr('Every image, voice line and the player as separate files in a folder; saving again only fetches what changed.')}>{tr('Save files to a folder')}</button>
      <select className="small" value={quality} onChange={(e) => setQuality(e.target.value as VideoQuality)} disabled={!!busy} title={tr('Lossless: exact pictures (MKV, plays in VLC/mpv). Compatible: MP4 that plays everywhere.')}>
        <option value="lossless">{tr('Lossless (MKV)')}</option>
        <option value="compatible">{tr('Compatible (MP4)')}</option>
      </select>
      <select className="small" value={height} onChange={(e) => setHeight(Number(e.target.value) as 720 | 1080)} disabled={!!busy}><option value={1080}>1080p</option><option value={720}>720p</option></select>
      <button className="small" disabled={!!busy} onClick={video}>{tr('Export video…')}</button>
      {busy && <span className="tiny muted">{busy}</span>}
      {saved && !busy && <button className="ghost small" onClick={() => import('../../lib/desktop').then((d) => d.showInFolder(saved)).catch(() => undefined)}>{tr('Show in folder')}</button>}
    </div>
  );
}
