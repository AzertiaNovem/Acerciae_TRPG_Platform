import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useHighlights } from '../store/highlights';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { Highlight } from '../types';

// Renders an entry's markdown and, when highlights target it, wraps it (or the given text range) in a
// fluorescent span with a fade-in. Highlight state is read from its own store so that document bodies
// do not re-render when unrelated highlights arrive.
function HighlightedTextImpl({ entryId, content }: { entryId: string; content: string }) {
  const highlights = useHighlights((s) => {
    const seen = new Set<string>();   // per-character rows of the same highlight collapse into one for the GM
    return Object.values(s.byId).filter((h) => h.target_entry_id === entryId && !seen.has(h.reason + h.kind) && seen.add(h.reason + h.kind));
  });
  const channelId = useNav((s) => s.channelId);
  const showEvidence = useUi((s) => s.showEvidence);
  const dismiss = useHighlights((s) => s.dismiss);
  const [open, setOpen] = useState(false);
  if (highlights.length === 0) return <div className="md"><ReactMarkdown>{content}</ReactMarkdown></div>;
  const top = [...highlights].sort((a, b) => b.priority - a.priority)[0];
  const range = top.text_range;
  const inner = range && range.end > range.start && range.end <= content.length
    ? <>{content.slice(0, range.start)}<span className={`hl-text ${top.kind}`}>{content.slice(range.start, range.end)}</span>{content.slice(range.end)}</>
    : <span className={`hl-text ${top.kind}`}><ReactMarkdown components={{ p: ({ children }) => <>{children}</> }}>{content}</ReactMarkdown></span>;
  return (
    <div className="md" style={{ position: 'relative' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="hl-dot" title="Highlighted by the chronicler" />
      {inner}
      {open && (
        <div className="hl-reason" onClick={(e) => e.stopPropagation()}>
          {highlights.map((h: Highlight) => (
            <div key={h.id} style={{ marginBottom: 6 }}>
              <div><b>{h.kind === 'consistency' ? 'Consistency check' : h.kind === 'potential_association' ? 'Potential association' : 'Related to the current conversation'}</b></div>
              <div>{h.reason}</div>
              <div className="row" style={{ marginTop: 4 }}>
                {h.source_event_ids?.length > 0 && <button className="ghost small" onClick={() => showEvidence(h.source_event_ids)}>jump to original event</button>}
                <button className="ghost small" onClick={() => channelId && dismiss(channelId, h.id)}>dismiss</button>
                <span className="tiny muted">fades {new Date(h.expires_at).toLocaleTimeString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const HighlightedText = memo(HighlightedTextImpl);
export default HighlightedText;
