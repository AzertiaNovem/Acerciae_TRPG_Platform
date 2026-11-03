import { create } from 'zustand';
import { api, setToken, getToken, ensureFileToken } from '../api/client';
import type { User } from '../types';
import { connectSockets, closeSockets } from '../api/ws';
import { bumpEpoch } from './session';
import { useLocale } from '../i18n';
import { resetUserStores } from './reset';
import { scheduleSweep, setAssetScope } from '../lib/assetCache';
import { apiBase } from '../lib/platform';

// The local asset cache belongs to one account on one server; it stays across sign-out and is emptied when another
// account signs in on this browser (setAssetScope). Expired entries are swept once per session.
const scopeAssets = (u: User) => { setAssetScope(`${apiBase()}|${u.id}`); scheduleSweep(); };

interface AuthState {
  user: User | null; loading: boolean; error: string | null;
  bootstrap: () => Promise<void>;
  login: (u: string, p: string) => Promise<void>;
  register: (u: string, p: string, d: string) => Promise<void>;
  logout: () => Promise<void>;
}
// Renew the file token well before it expires (renewal is a no-op while it is fresh).
setInterval(() => { if (getToken()) ensureFileToken().catch(() => undefined); }, 10 * 60 * 1000);

export const useAuth = create<AuthState>((set) => ({
  user: null, loading: true, error: null,
  bootstrap: async () => {
    if (!getToken()) { set({ loading: false }); return; }
    try { const me = await api.me(); await ensureFileToken().catch(() => ''); useLocale.getState().setLanguage(me.ui_language || 'en'); scopeAssets(me); set({ user: me, loading: false }); connectSockets(); }
    catch { setToken(null); set({ user: null, loading: false }); }
  },
  login: async (u, p) => {
    set({ error: null });
    try { const r = await api.login(u, p); bumpEpoch(); resetUserStores(); setToken(r.token); await ensureFileToken().catch(() => ''); useLocale.getState().setLanguage(r.user.ui_language || 'en'); scopeAssets(r.user); set({ user: r.user }); connectSockets(); }
    catch (e: any) { set({ error: e.message }); }
  },
  register: async (u, p, d) => {
    set({ error: null });
    try { const r = await api.register(u, p, d); bumpEpoch(); resetUserStores(); setToken(r.token); await ensureFileToken().catch(() => ''); useLocale.getState().setLanguage(r.user.ui_language || 'en'); scopeAssets(r.user); set({ user: r.user }); connectSockets(); }
    catch (e: any) { set({ error: e.message }); }
  },
  logout: async () => {
    // Invalidate in-flight requests first, then drop every per-user store before the token goes away.
    bumpEpoch();
    try { await api.logout(); } catch { /* ignore */ }
    setToken(null); closeSockets(); resetUserStores(); set({ user: null });
  },
}));
