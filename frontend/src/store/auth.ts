import { create } from 'zustand';
import { api, setToken, getToken } from '../api/client';
import type { User } from '../types';
import { connectSockets, closeSockets } from '../api/ws';
import { bumpEpoch } from './session';
import { useLocale } from '../i18n';
import { resetUserStores } from './reset';

interface AuthState {
  user: User | null; loading: boolean; error: string | null; llmMode: string;
  bootstrap: () => Promise<void>;
  login: (u: string, p: string) => Promise<void>;
  register: (u: string, p: string, d: string) => Promise<void>;
  logout: () => Promise<void>;
}
export const useAuth = create<AuthState>((set) => ({
  user: null, loading: true, error: null, llmMode: 'unknown',
  bootstrap: async () => {
    try { const h = await api.health(); set({ llmMode: h.llm_mode }); } catch { /* backend down */ }
    if (!getToken()) { set({ loading: false }); return; }
    try { const me = await api.me(); useLocale.getState().setLanguage(me.ui_language || 'en'); set({ user: me, loading: false }); connectSockets(); }
    catch { setToken(null); set({ user: null, loading: false }); }
  },
  login: async (u, p) => {
    set({ error: null });
    try { const r = await api.login(u, p); bumpEpoch(); resetUserStores(); setToken(r.token); useLocale.getState().setLanguage(r.user.ui_language || 'en'); set({ user: r.user }); connectSockets(); }
    catch (e: any) { set({ error: e.message }); }
  },
  register: async (u, p, d) => {
    set({ error: null });
    try { const r = await api.register(u, p, d); bumpEpoch(); resetUserStores(); setToken(r.token); useLocale.getState().setLanguage(r.user.ui_language || 'en'); set({ user: r.user }); connectSockets(); }
    catch (e: any) { set({ error: e.message }); }
  },
  logout: async () => {
    // Invalidate in-flight requests first, then drop every per-user store before the token goes away.
    bumpEpoch();
    try { await api.logout(); } catch { /* ignore */ }
    setToken(null); closeSockets(); resetUserStores(); set({ user: null });
  },
}));
