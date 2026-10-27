import { t as tr } from '../i18n';
import { useDocuments } from '../store/documents';
import { useHighlights } from '../store/highlights';
import { useNav } from '../store/nav';
import { useReminders } from '../store/reminders';
import { useKp } from '../store/kp';
import KpBoardViewer from './KpBoardViewer';
import ContextDocumentViewer from './ContextDocumentViewer';
import ReminderViewer from './ReminderViewer';
import type { DocumentSummary, KpStageBrief, Reminder } from '../types';

function Bubble({ d }: { d: DocumentSummary }) {
  const { seenVersion, pulse, expand } = useDocuments();
  const hlCount = useHighlights((s) => Object.values(s.byId).filter((h) => h.document_id === d.id).length);
  const unseen = Math.max(0, d.version - (seenVersion[d.id] ?? d.version));
  const pulsing = pulse[d.id] && Date.now() - pulse[d.id] < 1500;
  return (
    <div className={`bubble ${pulsing ? 'pulse' : ''} ${hlCount ? 'has-highlight' : ''}`} onClick={() => expand(d.id)} title={`${d.entry_count} entries · v${d.version}`}>
      <div className="title"><span>{tr(d.title)}{d.gm_only && <span className="pill gm" style={{ marginLeft: 6 }}>{tr("GM")}</span>}</span>
        <span className="row" style={{ gap: 4 }}>{hlCount > 0 && <span className="badge hl" title={tr("active highlights")}>✦{hlCount}</span>}{unseen > 0 && <span className="badge" title={tr("new changes since you looked")}>{d.recent_changes || unseen}</span>}</span></div>
      <div className="preview">{d.preview ?? `${d.entry_count} entries`}</div>
    </div>
  );
}

// A reminder bubble: what the players most likely forgot or need, anchored to quoted chat lines.
function ReminderBubble({ r }: { r: Reminder }) {
  const { open, pulse } = useReminders();
  const pulsing = pulse[r.id] && Date.now() - pulse[r.id] < 1500;
  const kind = r.kind === 'needed' ? tr('still open') : r.kind === 'plan' ? tr('plan') : r.kind === 'note' ? tr('note') : tr('you may have forgotten');
  return (
    <div className={`bubble reminder ${r.kind} ${pulsing ? 'pulse' : ''}`} onClick={() => open(r.id)} title={r.why}>
      <div className="title"><span>{r.title}</span><span className="tiny muted">{kind}</span></div>
      <div className="preview">{r.citations[0]?.quotes?.[0] ?? r.why}</div>
    </div>
  );
}

// The Keeper's two pinned cards: what the script plans next, and the notes.
function PinnedCards() {
  const board = useKp((s) => s.board);
  const pulse = useKp((s) => s.pulse);
  const open = useKp((s) => s.open);
  const pulsing = pulse && Date.now() - pulse < 1500;
  const nx = board?.next?.next && 'id' in board.next.next ? (board.next.next as KpStageBrief) : null;
  const cur = board?.next?.current && 'id' in board.next.current ? (board.next.current as KpStageBrief) : null;
  const threads = board?.notes?.open_threads?.length ?? 0;
  return (
    <>
      <div className={`bubble pinned ${pulsing ? 'pulse' : ''}`} onClick={() => open('next')} title={board?.next?.summary ?? ''}>
        <div className="title"><span>📌 {tr('Next per the script')}</span><span className="tiny muted">{cur ? tr('now: ') + cur.title : ''}</span></div>
        <div className="preview">{board?.next?.has_script ? (nx ? nx.title : tr('The script has no further stage after this one.')) : tr('No module imported yet.')}</div>
      </div>
      <div className={`bubble pinned notes ${pulsing ? 'pulse' : ''}`} onClick={() => open('notes')}>
        <div className="title"><span>📌 {tr('Notes')}</span><span className="tiny muted">{threads ? `${threads} ${tr('open')}` : ''}</span></div>
        <div className="preview">{board?.notes?.open_threads?.[0]?.summary ?? board?.notes?.timeline?.[0]?.title ?? tr('Open threads, timeline and reviewed changes.')}</div>
      </div>
    </>
  );
}

// Bottom-right dock. Players see reminder bubbles only: their group's knowledge is an index for the AI, never
// a page for them. The Keeper gets two pinned cards (next per the script, notes), their own reminders and the documents. Collapsible; never
// covers the send button.
export default function ContextBubbleDock() {
  const { list, expandedId, dockCollapsed, toggleDock, expand } = useDocuments();
  const reminders = useReminders((s) => s.list);
  const openReminder = useReminders((s) => s.openId);
  const openR = useReminders((s) => s.open);
  const openSlot = useKp((s) => s.openSlot);
  const openSlotSet = useKp((s) => s.open);
  const channel = useNav((s) => s.channel);
  const isGm = channel?.my_role === 'gm';
  const docs = isGm ? list : [];
  const count = reminders.length + docs.length + (isGm ? 2 : 0);
  const viewerOpen = !!openReminder || (isGm && !!openSlot);
  return (
    <div className="dock">
      {openReminder && !dockCollapsed && <ReminderViewer id={openReminder} onClose={() => openR(null)} />}
      {isGm && openSlot && !openReminder && !dockCollapsed && <KpBoardViewer slot={openSlot} onClose={() => openSlotSet(null)} />}
      {expandedId && !viewerOpen && !dockCollapsed && <ContextDocumentViewer documentId={expandedId} onClose={() => expand(null)} />}
      {!dockCollapsed && !expandedId && !viewerOpen && (
        <div className="bubbles">
          {isGm && <PinnedCards />}
          {reminders.map((r) => <ReminderBubble key={r.id} r={r} />)}
          {docs.map((d) => <Bubble key={d.id} d={d} />)}
          {!isGm && reminders.length === 0 && <div className="bubble quiet" title={tr('Reminders appear here when the AI notices something you may have forgotten.')}><div className="preview">{tr('Nothing to remind you of yet.')}</div></div>}
        </div>
      )}
      <button className="dock-toggle" onClick={toggleDock}>{dockCollapsed ? `▲ ${tr('Context')} (${count})` : tr("▼ Collapse")}</button>
    </div>
  );
}
