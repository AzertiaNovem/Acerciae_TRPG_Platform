import { t as tr } from '../i18n';
import { useState, type ReactNode } from 'react';
import { useEscape } from '../hooks/useEscape';

// A destructive action that only goes ahead once the exact phrase ("Delete Server") is typed.
export default function TypedConfirm({ title, children, phrase, action, onConfirm, onCancel }: {
  title: string; children: ReactNode; phrase: string; action: string;
  onConfirm: () => Promise<void>; onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEscape(busy ? null : onCancel);
  const ok = typed === phrase;
  const confirm = async () => { if (!ok || busy) return; setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal col" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="small">{children}</div>
        <label className="field"><span>{tr('Type {phrase} to confirm.', { phrase })}</span>
          <input autoFocus value={typed} placeholder={phrase} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirm()} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy}>{tr('Cancel')}</button>
          <button className="danger" onClick={confirm} disabled={!ok || busy}>{action}</button>
        </div>
      </div>
    </div>
  );
}
