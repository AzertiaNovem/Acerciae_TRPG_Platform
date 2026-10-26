import { t as tr } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { contextSocket } from '../../api/ws';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import type { VnScriptJob } from '../../types';
import { VN_BASE_INFO, VN_BASES, type VnBase } from './vn/templates';

const AUTO_PROJECT = 'Campaign log';

// GM tool: read the chat log of every window, have the model organise it into a visual-novel script,
// and build a draft presentation in the chosen look template. The draft stays private until published.
export default function VnScriptGenerator({ onOpen }: { onOpen: (presentationId: string) => void }) {
  const { channelId } = useNav();
  const { project, snapshot, loadProjects } = useStudio();
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState<{ mock: boolean; model: string; cloud_allowed: boolean; max_lines: number; note: string } | null>(null);
  const [jobs, setJobs] = useState<VnScriptJob[]>([]);
  const [source, setSource] = useState<'all' | 'public' | 'snapshot'>('all');
  const [base, setBase] = useState<VnBase>('adv');
  const [direction, setDirection] = useState('');
  const [cloudOk, setCloudOk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<VnScriptJob | null>(null);

  const load = () => { if (channelId) api.vnScripts(channelId).then(setJobs).catch(() => undefined); };
  useEffect(() => { if (!channelId) return; api.vnScriptStatus(channelId).then(setStatus).catch(() => undefined); load(); }, [channelId]);
  useEffect(() => contextSocket.on((m) => { if (m.type === 'studio.vnscript.progress') load(); }), [channelId]);
  // Polling covers reconnects and missed events while a job runs.
  useEffect(() => { if (!jobs.some((j) => j.status === 'pending' || j.status === 'running')) return; const t = setInterval(load, 2500); return () => clearInterval(t); }, [jobs, channelId]);

  const generate = async () => {
    if (!channelId) return;
    try {
      let snapshotId = snapshot?.id;
      if (source !== 'snapshot') {
        // Collect every chat window into a project, then freeze it. Sync only adds lines it has not seen.
        setBusy(tr('Collecting the chat log from every window…'));
        let pid = project?.id;
        if (!pid) {
          const all = await api.studioProjects(channelId);
          pid = all.find((p) => p.title === AUTO_PROJECT && p.source_kind !== 'import')?.id ?? (await api.studioCreateProject(channelId, { title: AUTO_PROJECT })).id;
        }
        await api.studioSync(channelId, pid, { mode: 'campaign' });
        setBusy(tr('Freezing a snapshot…'));
        const snap = await api.studioCreateSnapshot(channelId, pid, { title: source === 'all' ? 'All windows (GM)' : 'Player-visible lines', scope: source === 'all' ? 'gm_full' : 'pl_public' });
        snapshotId = snap.id;
        loadProjects(channelId);
      }
      if (!snapshotId) { toast(tr('Open a snapshot in the Library first'), 'error'); return; }
      setBusy(tr('Starting the script job…'));
      await api.createVnScript(channelId, { snapshot_id: snapshotId, template: { base }, instructions: direction.trim() || undefined, allow_cloud: status?.mock ? undefined : cloudOk });
      toast(tr('Script job started'), 'ai');
      load();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  const needsCloud = status && !status.mock;
  const blocked = !!needsCloud && (!status!.cloud_allowed || !cloudOk);

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>{tr('Generate a visual novel from the chat log')}</h3>
      <div className="tiny muted">{tr('The AI reads the lines, groups them into scenes (parallel chat windows become separate scenes), stages the characters and picks approved art and music. It never rewrites or adds lines. The result is a draft presentation you can edit before publishing.')}</div>
      {status && <div className={`tiny ${status.mock ? '' : 'muted'}`} style={{ marginTop: 4 }}>{status.mock ? <span className="pill">MOCK</span> : <span className="pill ai">{status.model}</span>} {tr(status.note)}</div>}
      <div className="vn-tpl-fields tiny">
        <label>{tr('Source')}<select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          <option value="all">{tr('All chat windows (GM only result)')}</option>
          <option value="public">{tr('Player-visible lines only')}</option>
          <option value="snapshot" disabled={!snapshot}>{tr('The snapshot open in the Library')}</option>
        </select></label>
        <label>{tr('Look template')}<select value={base} onChange={(e) => setBase(e.target.value as VnBase)}>{VN_BASES.map((b) => <option key={b} value={b}>{tr(VN_BASE_INFO[b].label)}</option>)}</select></label>
      </div>
      <label className="tiny" style={{ display: 'block', marginTop: 6 }}>{tr('Direction for the AI (optional)')}<textarea value={direction} maxLength={1000} onChange={(e) => setDirection(e.target.value)} placeholder={tr('e.g. Keep the investigation scenes tense; skip rules discussion.')} style={{ minHeight: 44, display: 'block', width: '100%', marginTop: 2 }} /></label>
      {source === 'all' && <div className="tiny muted" style={{ marginTop: 4 }}>{tr('Includes private windows and GM-only lines, so the draft is visible to GMs only. Choose player-visible lines to make something players can watch.')}</div>}
      {needsCloud && (
        status!.cloud_allowed
          ? <label className="tiny" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" checked={cloudOk} onChange={(e) => setCloudOk(e.target.checked)} /> {tr('Send these lines to the configured model')}</label>
          : <div className="tiny" style={{ marginTop: 6, color: 'var(--warn)' }}>{tr('Cloud processing is off for this campaign. Enable it in Library settings, or use the mock planner.')}</div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={generate} disabled={!!busy || blocked || (source === 'snapshot' && !snapshot)}>{busy ?? tr('Generate script')}</button>
      </div>
      {jobs.length > 0 && (
        <table className="simple" style={{ marginTop: 10 }}><tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                <b>{j.title}</b> <span className={`pill ${j.status === 'failed' ? 'danger' : j.status === 'completed' ? 'ok' : ''}`}>{tr(j.status)}</span> {j.provider === 'mock' && <span className="pill">MOCK</span>}
                <div className="tiny muted">{tr('snapshot v')}{j.snapshot_version} · {j.snapshot_scope}{j.stats ? ` · ${tr('{n} scenes', { n: j.stats.scenes })} · ${tr('{n} lines shown', { n: j.stats.shown })} · ${tr('{n} hidden', { n: j.stats.hidden })}` : ''}{j.status === 'running' && j.progress?.chunks_total ? ` · ${tr('part {a} of {b}', { a: j.progress.chunks_done ?? 0, b: j.progress.chunks_total })}` : ''}</div>
                {j.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{j.error}</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {j.presentation_id && <button className="small primary" onClick={() => onOpen(j.presentation_id!)}>{tr('open')}</button>}
                {j.status === 'completed' && <button className="small ghost" onClick={async () => setDetail(detail?.id === j.id ? null : await api.vnScript(channelId!, j.id))}>{tr('script')}</button>}
                {(j.status === 'pending' || j.status === 'running') && <button className="small ghost" onClick={async () => { await api.cancelVnScript(channelId!, j.id).catch(() => undefined); load(); }}>{tr('cancel')}</button>}
              </td>
            </tr>
          ))}
        </tbody></table>
      )}
      {detail?.script && (
        <div className="node" style={{ marginTop: 8 }}>
          {detail.script.notes?.map((n, i) => <div key={i} className="tiny muted">{n}</div>)}
          {detail.script.scenes.map((s) => (
            <div key={s.key} className="tiny" style={{ marginTop: 6 }}>
              <b>{s.title}</b> · {tr('{n} lines', { n: s.lines.filter((l) => !l.hidden).length })}{s.lines.some((l) => l.hidden) ? ` · ${tr('{n} hidden', { n: s.lines.filter((l) => l.hidden).length })}` : ''}
              {s.summary && <div className="muted">{s.summary}</div>}
              {!s.background_asset_id && s.background_brief && <div className="muted">{tr('Needs a background:')} {s.background_brief}</div>}
            </div>
          ))}
          {detail.script.asset_needs?.length > 0 && <div className="tiny" style={{ marginTop: 6 }}><b>{tr('Art the script asks for')}</b>{detail.script.asset_needs.map((n, i) => <div key={i} className="muted">{n.kind}: {n.brief}</div>)}</div>}
        </div>
      )}
    </div>
  );
}
