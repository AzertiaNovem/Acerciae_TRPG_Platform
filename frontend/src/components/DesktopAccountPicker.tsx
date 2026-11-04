import { useState } from 'react';
import { createPortal } from 'react-dom';
import { desktopAccounts } from '../api/client';
import { useEscape } from '../hooks/useEscape';
import { t } from '../i18n';

export default function DesktopAccountPicker({ signedIn = false }: { signedIn?: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEscape(open ? () => setOpen(false) : null);
  const directory = desktopAccounts?.read();
  if (!directory?.accounts.length) return null;

  const current = directory.accounts.find(a => a.slot === directory.active);
  function choose(slot: string | null) {
    try {
      desktopAccounts!.select(slot);
      location.reload(); // Recreate every store, socket and open dialog for the selected session.
    } catch (e) { setError(String(e)); }
  }
  const choices = <>
    <div className="section-label">{t('Switch account')}</div>
    {directory.accounts.map(a =>
      <button type="button" className="pick-row" key={a.slot} disabled={signedIn && directory.active === a.slot} onClick={() => choose(a.slot)}>
        <span className="grow">{a.name} · @{a.username}<br/><small>{a.server}</small></span>
        {signedIn && directory.active === a.slot && '✓'}
      </button>
    )}
    {error && <span role="alert">{error}</span>}
  </>;
  if (!signedIn) return <div className="col">{choices}</div>;
  return <>
    <button type="button" className="grow ghost small" aria-haspopup="dialog" aria-expanded={open} title={t('Switch account')}
      aria-label={t('Switch account')} onClick={() => setOpen(true)}>{current?.name} ▾<br/><small>@{current?.username}</small></button>
    {open && createPortal(
      <div className="modal-backdrop" onClick={() => setOpen(false)}>
        <div className="modal col" role="dialog" aria-modal="true" aria-label={t('Switch account')} onClick={e => e.stopPropagation()}>
          {choices}
          <button type="button" onClick={() => choose(null)}>{t('Add account')}</button>
          <button type="button" className="ghost" onClick={() => setOpen(false)}>{t('Close')}</button>
        </div>
      </div>, document.body)}
  </>;
}
