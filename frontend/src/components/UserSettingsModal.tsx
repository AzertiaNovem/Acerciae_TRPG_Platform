import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import { sessionEpoch } from '../store/session';
import { LANGUAGE_LABELS, t, useLocale } from '../i18n';

// Normalize user-selected raster images locally; no remote URLs, SVG or embedded metadata are stored.
async function avatarFromFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw Error(t('Choose a PNG, JPEG or WebP image under 5 MB.'));
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 8192 || bitmap.height > 8192) throw Error(t('Image dimensions are too large.'));
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d'); if (!context) throw Error(t('Could not read this image.'));
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 256, 256);
    const png = canvas.toDataURL('image/png');
    return png.length <= 175000 ? png : canvas.toDataURL('image/jpeg', 0.85);
  } finally { bitmap.close(); }
}
export default function UserSettingsModal({ onClose }: { onClose: () => void }) {
  const user = useAuth((s) => s.user)!;
  const [username, setUsername] = useState(user.username);
  const [name, setName] = useState(user.display_name);
  const [language, setLanguage] = useState(user.ui_language || 'en');
  const [atmosphere, setAtmosphere] = useState(!!user.atmosphere_enabled);
  const [avatar, setAvatarState] = useState(api.ownAvatarUrl(user));
  // avatar_data is sent only when the picture changed: a data URI replaces it, '' removes it.
  const [avatarChanged, setAvatarChanged] = useState(false);
  const setAvatar = (v: string) => { setAvatarState(v); setAvatarChanged(true); };
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);
  useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.focus(); return () => { uploadSequence.current++; previous?.focus(); }; }, []);
  const close = () => { if (!busy) onClose(); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); const epoch = sessionEpoch();
    try {
      const updated = await api.updateMe({ username, display_name: name.trim(), ui_language: language, ...(avatarChanged ? { avatar_data: avatar } : {}), atmosphere_enabled: atmosphere });
      if (epoch !== sessionEpoch()) return;
      useAuth.setState({ user: updated }); useLocale.getState().setLanguage(updated.ui_language);
      useUi.getState().toast(t('User settings saved')); onClose();
    } catch (e: any) { setError(t(e.message)); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={close}>
    <div className="modal col" role="dialog" aria-modal="true" aria-labelledby="user-settings-title" ref={dialog} tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const items = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled)'));
        const first = items[0], last = items[items.length-1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <h3 id="user-settings-title">{t('User settings')}</h3>
      <form className="col" onSubmit={save}>
        <fieldset disabled={busy} className="profile-fields col">
          <div className="row">
            <div className="avatar profile-avatar">{avatar ? <img src={avatar} alt={t('Avatar preview')} /> : name.slice(0,2).toUpperCase()}</div>
            <div className="col grow">
              <div className="field"><span>{t('Avatar')}</span><button type="button" className="small" onClick={() => fileInput.current?.click()}>{t('Upload avatar')}</button><input hidden ref={fileInput} aria-label={t('Avatar')} type="file" accept="image/png,image/jpeg,image/webp" onChange={async (e) => {
                const file=e.target.files?.[0]; e.target.value=''; if (!file) return;
                const sequence=++uploadSequence.current; setReading(true); setError('');
                try { const data=await avatarFromFile(file); if (sequence === uploadSequence.current) setAvatar(data); }
                catch(e:any) { if (sequence === uploadSequence.current) setError(e.message); }
                finally { if (sequence === uploadSequence.current) setReading(false); }
              }} /></div>
              <button type="button" className="ghost small" disabled={!avatar || reading} onClick={() => setAvatar('')}>{t('Remove avatar')}</button>
            </div>
          </div>
          <p className="tiny muted">{t('Your image is cropped to a square and saved at 256 × 256 pixels.')}</p>
          <label className="field"><span>{t('Username')}</span><input required autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.\-]{3,32}" value={username} onChange={(e)=>setUsername(e.target.value)} /></label>
          <p className="tiny muted">{t('Use 3–32 letters, digits, underscores, dots or hyphens. Use your new username next time you sign in.')}</p>
          <label className="field"><span>{t('Display name')}</span><input required maxLength={60} value={name} onChange={(e)=>setName(e.target.value)} /></label>
          <label className="field"><span>{t('Interface language')}</span><select value={language} onChange={(e)=>setLanguage(e.target.value)}>{(user.languages || Object.keys(LANGUAGE_LABELS)).map((code)=><option key={code} value={code}>{LANGUAGE_LABELS[code] || code}</option>)}</select></label>
          <p className="tiny muted">{t('This changes your interface only. Server AI output language stays unchanged.')}</p>
          <label className="row"><input type="checkbox" checked={atmosphere} onChange={e => setAtmosphere(e.target.checked)} />{t('Show channel atmosphere backgrounds')}</label>
          <p className="tiny muted">{t('Requires the server atmosphere feature. Follows your device’s light/dark theme and screen orientation; displayed translucently.')}</p>
        </fieldset>
        {error && <div role="alert" className="profile-error">{error}</div>}
        <div className="row"><button className="primary" disabled={busy || reading || !name.trim()}>{t(busy ? 'Saving…' : 'Save')}</button><button type="button" className="ghost" disabled={busy} onClick={close}>{t('Cancel')}</button></div>
      </form>
    </div>
  </div>;
}
