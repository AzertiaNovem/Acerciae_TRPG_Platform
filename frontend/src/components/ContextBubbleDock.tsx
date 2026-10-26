import { t as tr } from '../i18n';
import { useDocuments } from '../store/documents';
import { useHighlights } from '../store/highlights';
import { useNav } from '../store/nav';
import ContextDocumentViewer from './ContextDocumentViewer';
import type { DocumentSummary } from '../types';

function Bubble({ d }: { d: DocumentSummary }) {
  const { seenVersion, pulse, expand } = useDocuments();
  const hlCount = useHighlights((s) => Object.values(s.byId).filter((h) => h.document_id === d.id).length);
  const unseen = Math.max(0, d.version - (seenVersion[d.id] ?? d.version));
  const pulsing = pulse[d.id] && Date.now() - pulse[d.id] < 1500;
  return (
    <div className={`bubble ${pulsing ? 'pulse' : ''} ${hlCount ? 'has-highlight' : ''}`} onClick={() => expand(d.id)} title={`${d.entry_count} entries · v${d.version}`}>
      <div className="title"><span>{d.title}{d.gm_only && <span className="pill gm" style={{ marginLeft: 6 }}>{tr("GM")}</span>}</span>
        <span className="row" style={{ gap: 4 }}>{hlCount > 0 && <span className="badge hl" title={tr("active highlights")}>✦{hlCount}</span>}{unseen > 0 && <span className="badge" title={tr("new changes since you looked")}>{d.recent_changes || unseen}</span>}</span></div>
      <div className="preview">{d.preview ?? `${d.entry_count} entries`}</div>
    </div>
  );
}

// Bottom-right dock. Collapsible; never covers the send button because it sits above the composer's
// right edge and can be fully collapsed into a single pill.
export default function ContextBubbleDock() {
  const { list, expandedId, dockCollapsed, toggleDock, expand } = useDocuments();
  const channel = useNav((s) => s.channel);
  const visible = list.filter((d) => !d.gm_only || channel?.my_role === 'gm');
  return (
    <div className="dock">
      {expandedId && !dockCollapsed && <ContextDocumentViewer documentId={expandedId} onClose={() => expand(null)} />}
      {!dockCollapsed && !expandedId && <div className="bubbles">{visible.map((d) => <Bubble key={d.id} d={d} />)}</div>}
      <button className="dock-toggle" onClick={toggleDock}>{dockCollapsed ? `▲ ${tr('Context')} (${visible.length})` : tr("▼ Collapse")}</button>
    </div>
  );
}
