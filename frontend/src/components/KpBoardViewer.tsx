import { t as tr, currentLocale } from '../i18n';
import { useKp } from '../store/kp';
import { useNav } from '../store/nav';
import type { KpStageBrief } from '../types';

const stage = (s: KpStageBrief | null | Record<string, never> | undefined): KpStageBrief | null => (s && 'id' in s && s.id ? (s as KpStageBrief) : null);

// The two pinned Keeper cards, opened. "Next" reads the script's flow: the running stage, the stage planned
// after it, what it needs, what the Keeper still holds. "Notes" gathers open threads, the timeline and the
// latest reviewed changes. Everything shown is data from the tables; only the summary sentence is phrased.
export default function KpBoardViewer({ slot, onClose }: { slot: 'next' | 'notes'; onClose: () => void }) {
  const board = useKp((s) => s.board);
  const setOpen = useNav((s) => s.setGmWorkspaceOpen);
  const next = board?.next; const notes = board?.notes;
  const cur = stage(next?.current); const nx = stage(next?.next);
  const list = (xs?: string[]) => (xs ?? []).filter(Boolean);
  return (
    <div className="doc-viewer kp-board-viewer">
      <header>
        <span className="pill gm">{slot === 'next' ? tr('Next per the script') : tr('Notes')}</span>
        <h3>{slot === 'next' ? (nx?.title ?? tr('What the script plans next')) : tr("Keeper's notes")}</h3>
        <button className="ghost small" onClick={() => { onClose(); setOpen(true); }} title={tr('Open the script knowledge in the GM workspace')}>{tr('Script ↗')}</button>
        <button className="ghost small" onClick={onClose}>✕</button>
      </header>
      <div className="body">
        {slot === 'next' && (
          <>
            {!next?.has_script && <div className="muted small">{tr('No module imported yet. Import the script in the GM workspace to see what it plans next.')}</div>}
            {next?.has_script && (
              <>
                <div className="small" style={{ marginBottom: 10 }}>{next.summary}</div>
                <div className="kp-stage"><span className="tiny muted">{tr('Now')}</span><div className="small">{cur ? <><b>{cur.title}</b>{cur.data?.location && <span className="muted"> · {cur.data.location}</span>}</> : <span className="muted">{tr('No scripted stage reached yet')}</span>}</div></div>
                {nx && (
                  <div className="kp-stage next">
                    <span className="tiny muted">{tr('Next')}</span>
                    <div className="small"><b>{nx.title}</b>{nx.data?.location && <span className="muted"> · {nx.data.location}</span>}</div>
                    {nx.body && <div className="small muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{nx.body}</div>}
                    {list(nx.data?.keeper_actions).length > 0 && <div style={{ marginTop: 6 }}><span className="tiny muted">{tr('What the Keeper does there')}</span><ul className="small kp-list">{list(nx.data?.keeper_actions).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div>}
                    {list(nx.data?.prerequisites).length > 0 && <div><span className="tiny muted">{tr('Needs first')}</span><ul className="small kp-list">{list(nx.data?.prerequisites).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div>}
                    {list(nx.data?.twists).length > 0 && <div><span className="tiny muted">{tr('Twists planted here')}</span><ul className="small kp-list">{list(nx.data?.twists).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div>}
                    {nx.citation && <div className="cit">{tr('p.')}{nx.citation.page}: “{nx.citation.excerpt.slice(0, 160)}”</div>}
                  </div>
                )}
                {!nx && cur && <div className="small muted">{tr('The script has no further stage after this one.')}</div>}
                {next.pending_clues.length > 0 && <div style={{ marginTop: 8 }}><span className="tiny muted">{tr('Still unrevealed')}</span><ul className="small kp-list">{next.pending_clues.map((c) => <li key={c.id}>{c.title}</li>)}</ul></div>}
                {next.pending_foreshadowing.length > 0 && <div><span className="tiny muted">{tr('Foreshadowing not yet paid off')}</span><ul className="small kp-list">{next.pending_foreshadowing.map((c) => <li key={c.id}>{c.title}</li>)}</ul></div>}
                <div className="tiny muted" style={{ marginTop: 8 }}>{next.stages_done}/{next.stages_total} {tr('stages done')}{next.updated_at ? ` · ${new Date(next.updated_at).toLocaleTimeString(currentLocale())}` : ''}</div>
              </>
            )}
          </>
        )}
        {slot === 'notes' && (
          <>
            <span className="tiny muted">{tr('Open threads')}</span>
            {(notes?.open_threads ?? []).length === 0 && <div className="small muted">{tr('None recorded.')}</div>}
            <ul className="small kp-list">{(notes?.open_threads ?? []).map((t) => <li key={t.fact_id}>{t.summary} <span className="tiny muted">[{tr(t.status)}]</span></li>)}</ul>
            <span className="tiny muted" style={{ display: 'block', marginTop: 8 }}>{tr('Timeline')}</span>
            <ul className="small kp-list">{(notes?.timeline ?? []).map((s) => <li key={s.id}><b>{s.sequence}</b> {s.title || s.location}{s.narrative_time && <span className="muted"> · {s.narrative_time}</span>} <span className="tiny muted">[{tr(s.status)}]</span></li>)}</ul>
            {(notes?.stages_done ?? []).length > 0 && <><span className="tiny muted" style={{ display: 'block', marginTop: 8 }}>{tr('Script stages played')}</span><ul className="small kp-list">{notes!.stages_done.map((s) => <li key={s.id}>{s.title}</li>)}</ul></>}
            <span className="tiny muted" style={{ display: 'block', marginTop: 8 }}>{tr('Latest reviewed changes')}</span>
            {(notes?.recent_changes ?? []).length === 0 && <div className="small muted">{tr('No automatic changes yet.')}</div>}
            <ul className="small kp-list">{(notes?.recent_changes ?? []).map((c) => <li key={c.id}><span className={`pill ${c.verdict === 'approved' ? 'ok' : 'danger'}`}>{tr(c.verdict)}</span> {c.op}{c.title ? `: ${c.title}` : ''}{c.status ? ` → ${c.status}` : ''} <span className="tiny muted">{c.reviewer_reason}</span></li>)}</ul>
          </>
        )}
      </div>
    </div>
  );
}
