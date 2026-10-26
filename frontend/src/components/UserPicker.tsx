import { t as tr } from '../i18n';
import { useEffect, useMemo, useState } from 'react';

export interface Candidate { id: string; label: string; sublabel?: string }

// Search box + buttons for choosing people. Local candidates are filtered as you type; `search` adds remote
// matches (debounced). In "select" mode clicking toggles a selection shown as chips; in "action" mode each
// candidate gets a button (e.g. Invite / Add) that runs `onAction`.
export default function UserPicker(props: {
  candidates?: Candidate[];
  search?: (q: string) => Promise<Candidate[]>;
  exclude?: string[];
  mode: 'select' | 'action';
  selected?: string[];
  onToggle?: (c: Candidate) => void;
  actionLabel?: string;
  onAction?: (c: Candidate) => Promise<void> | void;
  placeholder?: string;
  emptyText?: string;
  autoFocus?: boolean;
}) {
  const { candidates = [], search, exclude = [], mode, selected = [], onToggle, actionLabel = 'Add', onAction, placeholder = 'Search by name or username…', emptyText = 'No one matches.' } = props;
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [known, setKnown] = useState<Record<string, Candidate>>({});

  useEffect(() => {
    if (!search || !query.trim()) { setRemote([]); return; }
    let live = true;
    const t = setTimeout(() => { search(query.trim()).then((r) => { if (live) setRemote(r); }).catch(() => undefined); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [query, search]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const seen = new Set<string>(exclude);
    const out: Candidate[] = [];
    for (const c of [...candidates.filter((c) => !q || c.label.toLowerCase().includes(q) || (c.sublabel ?? '').toLowerCase().includes(q)), ...remote]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id); out.push(c);
    }
    return out.slice(0, 30);
  }, [candidates, remote, q, exclude]);

  const remember = (c: Candidate) => setKnown((k) => ({ ...k, [c.id]: c }));
  const nameOf = (id: string) => known[id] ?? candidates.find((c) => c.id === id) ?? remote.find((c) => c.id === id);

  const act = async (c: Candidate) => {
    if (mode === 'select') { remember(c); onToggle?.(c); return; }
    setBusy(c.id);
    try { await onAction?.(c); } finally { setBusy(null); }
  };

  return (
    <div className="picker">
      {mode === 'select' && selected.length > 0 && (
        <div className="chips">
          {selected.map((id) => { const c = nameOf(id); return (
            <span key={id} className="chip">{c?.label ?? id.slice(0, 8)}<button className="chip-x" title={tr("Remove")} onClick={() => c ? onToggle?.(c) : onToggle?.({ id, label: id })}>×</button></span>
          ); })}
        </div>
      )}
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} autoFocus={props.autoFocus} />
      <div className="picker-list">
        {shown.length === 0 && <div className="tiny muted" style={{ padding: '4px 2px' }}>{q ? emptyText : search && candidates.length === 0 ? tr("Type to search.") : emptyText}</div>}
        {shown.map((c) => {
          const on = selected.includes(c.id);
          return mode === 'select' ? (
            <button key={c.id} className={`pick ${on ? 'on' : ''}`} onClick={() => act(c)} title={on ? tr("Click to remove") : tr("Click to add")}>
              <span>{on ? '✓' : '+'}</span><span className="grow">{c.label}</span>{c.sublabel && <span className="tiny muted">{c.sublabel}</span>}
            </button>
          ) : (
            <div key={c.id} className="pick-row">
              <span className="grow">{c.label} {c.sublabel && <span className="tiny muted">{c.sublabel}</span>}</span>
              <button className="small" disabled={busy === c.id} onClick={() => act(c)}>{busy === c.id ? '…' : actionLabel}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const userCandidate = (u: { id: string; username: string; display_name: string }, extra?: string): Candidate =>
  ({ id: u.id, label: u.display_name, sublabel: `@${u.username}${extra ? ` · ${extra}` : ''}` });
