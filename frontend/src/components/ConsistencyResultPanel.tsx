import { t as tr } from '../i18n';
import { useUi } from '../store/ui';
import { useDocuments } from '../store/documents';
import type { ConsistencyEvidence } from '../types';

export default function ConsistencyResultPanel() {
  const { consistency: r, setConsistency, showEvidence } = useUi();
  const expand = useDocuments((s) => s.expand);
  const focusEntry = useDocuments((s) => s.focusEntry);
  if (!r) return null;
  const cls = r.insufficient_evidence || r.score == null ? 'none' : r.score < 50 ? 'low' : r.score < 75 ? 'mid' : 'high';
  const open = (e: ConsistencyEvidence) => { if (e.document_id) { expand(e.document_id); focusEntry(e.entry_id); } };
  return (
    <div className="panel-float">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className={`score ${cls}`}>{r.insufficient_evidence ? tr("Insufficient Evidence") : `Consistency: ${r.score}%`}</div>
          <div className="tiny muted">{tr("Heuristic consistency score against records your character can access — not a probability of truth. ")}{r.llm_mode === 'mock' && '(mock LLM mode)'}</div>
        </div>
        <span className="grow" />
        <button className="ghost small" onClick={() => setConsistency(null)}>✕</button>
      </div>
      <p className="small" style={{ margin: '8px 0' }}>{r.rationale}</p>
      {r.conflicts.map((c, i) => (
        <div key={i} className="conflict">
          <div><b>{tr("Potential ")}{c.severity ?? tr("issue")}:</b> {c.description}</div>
          {c.quote && <div className="tiny muted">“{c.quote}”</div>}
          {c.evidence_fact_ids.length > 0 && <div className="tiny muted">{tr("Evidence: ")}{c.evidence_fact_ids.length}{tr(" record(s) below")}</div>}
        </div>
      ))}
      {r.evidence.length > 0 && (
        <>
          <div className="small muted" style={{ marginTop: 8 }}>{tr("Associated evidence — click to open the document entry, or view the original events.")}</div>
          {r.evidence.map((e) => (
            <div key={e.fact_id + e.role} className={`evidence-item ${e.role}`} onClick={() => open(e)}>
              <div className="row"><span className="pill">{e.document_type?.replace('_', ' ')}</span><span className={`tiny status-${e.status}`}>{e.status}</span>{e.scene_title && <span className="tiny muted">· {e.scene_title}</span>}<span className="grow" />
                {e.source_event_ids?.length > 0 && <button className="ghost small" onClick={(ev) => { ev.stopPropagation(); showEvidence(e.source_event_ids); }}>{tr("original events")}</button>}</div>
              <div className="small">{e.summary}</div>
            </div>
          ))}
        </>
      )}
      <div className="tiny muted" style={{ marginTop: 8 }}>{tr("Your draft was not changed and can still be sent as-is.")}</div>
    </div>
  );
}
