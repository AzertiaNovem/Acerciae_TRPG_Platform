import { t as tr } from '../i18n';
import { useState } from 'react';
import { useAuth } from '../store/auth';
import { isDesktop, normalizeServer, serverUrl, setServerUrl } from '../lib/platform';
import { useOpenStudio } from '../openstudio/ui/state';

export default function LoginScreen() {
  const { login, register, error } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [d, setD] = useState('');
  // The desktop app connects to a server of the user's choice (the public one by default).
  const [server, setServer] = useState(serverUrl());
  const [serverError, setServerError] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isDesktop) { try { setServerUrl(server); setServer(normalizeServer(server)); setServerError(''); } catch (err: any) { setServerError(err.message); return; } }
    if (mode === 'login') login(u, p); else register(u, p, d);
  };
  return (
    <div className="login">
      <form className="card col" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>{tr("Acerciae")}</h2>
        <div className="muted small">{tr("AI-assisted CoC / BRP table. The AI is a silent chronicler, never a player.")}</div>
        {isDesktop && <label className="col tiny muted" style={{ gap: 4 }}>{tr('Server')}<input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://trpg.missazertia.com" spellCheck={false} autoCapitalize="off" /></label>}
        {serverError && <div className="small" style={{ color: 'var(--danger)' }}>{tr(serverError)}</div>}
        <input placeholder={tr("username")} value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        {mode === 'register' && <input placeholder={tr("display name")} value={d} onChange={(e) => setD(e.target.value)} />}
        <input placeholder={tr("password")} type="password" value={p} onChange={(e) => setP(e.target.value)} />
        {error && <div className="small" style={{ color: 'var(--danger)' }}>{tr(error)}</div>}
        <button className="primary" type="submit">{mode === 'login' ? tr("Sign in") : tr("Create account")}</button>
        <button type="button" className="ghost small" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? tr("Need an account? Register") : tr("Have an account? Sign in")}</button>
        <div className="tiny muted">{tr("Demo accounts (when the server seeds them): keeper / alice / bob / carol — password “password”.")}</div>
        {isDesktop && <button type="button" className="ghost small" onClick={() => useOpenStudio.getState().setOpen(true)} title={tr('Make HTML, PDF and visual novels from game logs on this computer, without an account')}>{tr('Open Log Studio (offline, no account) →')}</button>}
      </form>
    </div>
  );
}
