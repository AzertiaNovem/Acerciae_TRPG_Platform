import { t as tr, currentLocale } from '../../i18n';
import StudioPolicyPanel from './StudioPolicyPanel';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import type { CampaignLog as Log } from '../../types';

// One channel, one log: every chat window, the whole campaign. It syncs itself from the chat whenever it is
// opened; nothing is imported. Everyone exports what they are allowed to read: the lossless Acerciae format,
// a SealDice-compatible JSON per chat window, plain text, HTML, or a zip with all of them.
export default function CampaignLog() {
  const { channelId, channel } = useNav();
  const { log, loadLog } = useStudio();
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const isGm = channel?.my_role === 'gm';
  useEffect(() => { if (channelId) loadLog(channelId).catch((e) => toast(e.message, 'error')); }, [channelId]);
  const refresh = async () => { if (!channelId) return; setBusy(true); try { await loadLog(channelId); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const exportUrl = (format: string, windowId?: string) => api.logExportUrl(channelId!, format, windowId);
  if (!channelId) return null;
  const l: Log | null = log;
  return (
    <div>
      {isGm && <StudioPolicyPanel />}
      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>{tr('The campaign log')}</h3><span className="pill">{l?.project.event_count ?? 0} {tr('lines')}</span><span className="grow" /><button className="small" onClick={refresh} disabled={busy}>{busy ? tr('Syncing…') : tr('Sync now')}</button></div>
        <div className="tiny muted" style={{ marginTop: 4 }}>{tr('This channel keeps one log of the entire campaign across every chat window. It is pulled from the chat itself whenever you open it; nothing is imported. You can export what you are allowed to read.')}</div>
        {l && <div className="tiny muted" style={{ marginTop: 4 }}>{l.last_event_at ? `${tr('Last line')}: ${new Date(l.last_event_at).toLocaleString(currentLocale())}` : tr('No lines yet.')}{l.synced_added ? ` · ${tr('{n} new lines pulled', { n: l.synced_added })}` : ''}</div>}
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <a className="button primary small" href={exportUrl('json')}>{tr('Download the whole log (lossless JSON)')}</a>
          <a className="button small" href={exportUrl('zip')}>{tr('Everything as a zip (JSON, text, SealDice per window)')}</a>
          <a className="button small" href={exportUrl('html')}>{tr('HTML')}</a>
          <a className="button small" href={exportUrl('txt')}>{tr('TXT')}</a>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>{tr('Chat windows')}</h3>
          <div className="tiny muted">{tr('A SealDice-compatible JSON per window, for story-painter and other SealDice tools.')}</div>
          <table className="simple" style={{ marginTop: 6 }}><tbody>
            {(l?.windows ?? []).map((w) => <tr key={w.id}><td><b>{w.name}</b><div className="tiny muted">{tr(w.kind)} · {w.line_count} {tr('lines')}{w.last_at ? ` · ${new Date(w.last_at).toLocaleDateString(currentLocale())}` : ''}</div></td><td className="row" style={{ flexWrap: 'wrap' }}><a className="button small" href={exportUrl('sealdice', w.id)}>{tr('SealDice JSON')}</a><a className="button small" href={exportUrl('json', w.id)}>{tr('JSON')}</a></td></tr>)}
            {(l?.windows ?? []).length === 0 && <tr><td className="muted small">{tr('No chat windows you can read.')}</td></tr>}
          </tbody></table>
        </div>
        <div className="card">
          <h3>{tr('Scenarios')}</h3>
          <table className="simple"><tbody>
            {(l?.scenarios ?? []).map((s) => <tr key={s.id}><td>{s.sequence}</td><td><b>{s.title}</b>{s.summary && <div className="tiny muted">{s.summary.slice(0, 160)}</div>}</td><td className="tiny muted">{s.line_count} {tr('lines')}</td><td><span className={`pill ${s.status === 'active' ? 'ok' : ''}`}>{tr(s.status)}</span></td></tr>)}
          </tbody></table>
          {isGm && (l?.project.speakers ?? []).length > 0 && <><h3 style={{ marginTop: 12 }}>{tr('Speakers')}</h3><table className="simple"><tbody>{l!.project.speakers!.map((sp) => <tr key={sp.speaker_key}><td>{sp.display_name}</td><td className="tiny muted">{sp.role}</td><td className="tiny muted">{sp.n} {tr('lines')}</td></tr>)}</tbody></table></>}
        </div>
      </div>
    </div>
  );
}
