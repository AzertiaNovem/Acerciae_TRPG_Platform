import { t as tr } from '../i18n';
import { useState } from 'react';
import { useEscape } from '../hooks/useEscape';
import type { Scene } from '../types';

// Asked before the campaign enters a new scenario: the move is campaign-wide and closes the current scenario for good.
export default function ScenarioConfirm({ current, next, onConfirm, onCancel }: {
  current: Scene | undefined;
  next: { title?: string; location?: string; narrative_time?: string };
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEscape(busy ? null : onCancel);
  const confirm = async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  const where = [next.location, next.narrative_time].filter((x) => x && x.trim()).join(' · ');
  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal col" role="alertdialog" aria-modal="true" aria-label={tr('Enter a new scenario?')} onClick={(e) => e.stopPropagation()}>
        <h3>{tr('Enter a new scenario?')}</h3>
        <div className="col" style={{ gap: 6 }}>
          <div><span className="tiny muted">{tr('Current scenario')}</span><div>{current ? current.title : <span className="muted">{tr('none yet')}</span>}</div></div>
          <div><span className="tiny muted">{tr('New scenario')}</span><div><b>{next.title?.trim() || tr('Untitled scenario')}</b>{where && <div className="tiny muted">{where}</div>}</div></div>
        </div>
        <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
          <li>{tr('Every chat window moves to the new scenario.')}</li>
          {current && <li>{tr('The current scenario closes and is summarized; from then on it can only be consulted.')}</li>}
          <li>{tr('This cannot be undone.')}</li>
        </ul>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy}>{tr('Cancel')}</button>
          <button className="primary" autoFocus onClick={confirm} disabled={busy}>{tr('Enter scenario')}</button>
        </div>
      </div>
    </div>
  );
}
