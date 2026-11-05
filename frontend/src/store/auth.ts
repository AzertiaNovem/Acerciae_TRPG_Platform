import { create } from 'zustand';
import { api, setToken, getToken, ensureFileToken, rememberDesktopAccount, forgetActiveCredential, desktopAccounts, ApiError } from '../api/client';
import type { User } from '../types';
import { connectSockets, closeSockets } from '../api/ws';
import { bumpEpoch } from './session';
import { useLocale } from '../i18n';
import { resetUserStores } from './reset';
import { scheduleSweep, setAssetScope } from '../lib/assetCache';
import { apiBase, isDesktop } from '../lib/platform';

// The local asset cache belongs to one account on one server; it stays across sign-out and is emptied when another
// account signs in on this browser (setAssetScope). Expired entries are swept once per session.
const scopeAssets = (u: User) => { setAssetScope(`${apiBase()}|${u.id}`, isDesktop); scheduleSweep(); };

interface AuthState {
  user: User | null; loading: boolean; error: string | null;
  bootstrap: () => Promise<void>;
  login: (u: string, p: string) => Promise<void>;
  register: (u: string, p: string, d: string) => Promise<void>;
  logout: () => Promise<void>;
}
// Renew the file token well before it expires (renewal is a no-op while it is fresh).
setInterval(() => { if (getToken()) ensureFileToken().catch(() => undefined); }, 10 * 60 * 1000);

let initialSession: Promise<void> | undefined;
export const useAuth = create<AuthState>((set) => {
  async function showAccount(user: User) {
    await ensureFileToken().catch(() => '');
    useLocale.getState().setLanguage(user.ui_language || 'en');
    scopeAssets(user);
    set({ user, loading: false, error: null });
    connectSockets();
  }
  async function signIn(request: () => Promise<{ user: User; token: string }>) {
    set({ error: null });
    try {
      const { user, token } = await request();
      await rememberDesktopAccount(user, token);
      bumpEpoch();
      resetUserStores();
      setToken(token);
      await showAccount(user);
    } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  }
  async function bootstrap() {
    const token = getToken();
    if (!token) { set({ loading: false }); return; }
    try {
      const me = await api.me();
      const selected = desktopAccounts?.selected();
      if (isDesktop && (!selected || selected.name !== me.display_name || selected.username !== me.username)) {
        await rememberDesktopAccount(me, token);
      }
      await showAccount(me);
    } catch (e) {
      let reason = e;
      if (e instanceof ApiError && e.status === 401) {
        try { await forgetActiveCredential(); } catch (storageError) { reason = storageError; }
      }
      setToken(null);
      set({ user: null, loading: false, error: reason instanceof Error ? reason.message : String(reason) });
    }
  }
  return {
    user: null, loading: true, error: null,
    bootstrap: () => initialSession ??= bootstrap(),
    login: (username, password) => signIn(() => api.login(username, password)),
    register: (username, password, displayName) => signIn(() => api.register(username, password, displayName)),
    logout: async () => {
      set({ loading: true });
      bumpEpoch();
      closeSockets();
      try { await api.logout(); } catch { /* Local sign-out also works offline. */ }
      resetUserStores();
      try {
        await forgetActiveCredential();
        set({ user: null, loading: false });
        if (isDesktop) location.reload();
      } catch (e) {
        setToken(null);
        set({ user: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
});
