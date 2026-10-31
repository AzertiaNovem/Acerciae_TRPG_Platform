import { t as tr, currentLocale } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useUi } from '../../store/ui';
import type { BundleJob } from '../../types';
import { isDesktop } from '../../lib/platform';
import { lazy, Suspense } from 'react';
const DesktopVnTools = lazy(() => import('./DesktopVnTools'));

// The standalone visual novel is packed in the background: prepare it, follow the progress, then download it until
// it expires (the server deletes it afterwards). Each bundle is the requester's own view of the presentation.
function ZipDownload({ channelId, presentationId, primary }: { channelId: string; presentationId: string; primary?: boolean }) {
  const toast = useUi((s) => s.toast);
  const [job, setJob] = useState<BundleJob | null>(null);
  const [busy, setBusy] = useState(false);
  const active = job?.status === 'pending' || job?.status === 'running';
  useEffect(() => {
    let live = true;
    api.bundleJobs(channelId, presentationId).then((jobs) => { if (live) setJob(jobs[0] ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [channelId, presentationId]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { api.bundleJobs(channelId, presentationId).then((jobs) => setJob(jobs.find((j) => j.id === job!.id) ?? jobs[0] ?? null)).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [active, channelId, presentationId, job?.id]);
  const prepare = async (force: boolean) => { setBusy(true); try { setJob(await api.requestBundle(channelId, presentationId, force)); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const expired = job?.status === 'ready' && job.expires_at && new Date(job.expires_at).getTime() <= Date.now();
  if (job?.status === 'ready' && !expired && job.download_path) {
    const until = new Date(job.expires_at!).toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' });
    return (
      <span className="row" style={{ gap: 6 }}>
        <a className={`button small ${primary ? 'primary' : ''}`} href={api.bundleDownloadUrl(job.download_path)}>{tr('Download the visual novel (zip)')}</a>
        <span className="tiny muted" title={tr('The server deletes the file when it expires; prepare it again any time.')}>{tr('until {time}', { time: until })} · {Math.max(1, Math.round((job.bytes ?? 0) / 1048576))} MB</span>
        <button className="ghost small" onClick={() => prepare(true)} disabled={busy} title={tr('Pack it again with the latest changes')}>↻</button>
      </span>
    );
  }
  if (active) {
    const done = job!.progress?.files_done ?? 0, total = job!.progress?.files_total ?? 0;
    return <span className="tiny muted">{total ? tr('Packing the visual novel… {done}/{total} files', { done, total }) : tr('Packing the visual novel…')}</span>;
  }
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className={`small ${primary ? 'primary' : ''}`} onClick={() => prepare(job?.status === 'failed' || !!expired || job?.status === 'expired')} disabled={busy}>{tr('Prepare the download (zip)')}</button>
      {job?.status === 'failed' && <span className="tiny" style={{ color: 'var(--danger)' }}>{job.error}</span>}
      {(job?.status === 'expired' || expired) && <span className="tiny muted">{tr('The last download expired.')}</span>}
    </span>
  );
}

export default function BundleDownload(props: { channelId: string; presentationId: string; primary?: boolean }) {
  if (!isDesktop) return <ZipDownload {...props} />;
  return (
    <span className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
      <ZipDownload {...props} />
      <Suspense fallback={null}><DesktopVnTools channelId={props.channelId} presentationId={props.presentationId} /></Suspense>
    </span>
  );
}
