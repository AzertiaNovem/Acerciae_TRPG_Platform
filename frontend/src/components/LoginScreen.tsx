import { useState } from 'react';
import { useAuth } from '../store/auth';

export default function LoginScreen() {
  const { login, register, error, llmMode } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [d, setD] = useState('');
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (mode === 'login') login(u, p); else register(u, p, d); };
  return (
    <div className="login">
      <form className="card col" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Acerciae</h2>
        <div className="muted small">AI-assisted CoC / BRP table. The AI is a silent chronicler, never a player.</div>
        <input placeholder="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        {mode === 'register' && <input placeholder="display name" value={d} onChange={(e) => setD(e.target.value)} />}
        <input placeholder="password" type="password" value={p} onChange={(e) => setP(e.target.value)} />
        {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
        <button className="primary" type="submit">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="ghost small" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}</button>
        <div className="tiny muted">Demo accounts: keeper / alice / bob / carol — password “password”. LLM mode: {llmMode}.</div>
      </form>
    </div>
  );
}
