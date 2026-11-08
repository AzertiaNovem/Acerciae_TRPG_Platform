import { create } from 'zustand';
import { api, setToken, getToken, ensureFileToken, rememberDesktopAccount, forgetActiveCredential, desktopAccounts, ApiError } from '../api/client';
import type { User } from '../types';
import { connectSockets, closeSockets } from '../api/ws';
import { bumpEpoch } from './session';
import { useLocale } from '../i18n';
import { resetUserStores } from './reset';
import { scheduleSweep, setAssetScope } from '../lib/assetCache';
import { clearHistory, setHistoryScope } from '../lib/chatHistory';
import { apiBase, isDesktop } from '../lib/platform';

// The local asset cache belongs to one account on one server; it stays across sign-out and is emptied when another
// account signs in on this browser (setAssetScope). Expired entries are swept once per session.
const scopeAssets = (u: User) => { setAssetScope(`${apiBase()}|${u.id}`, isDesktop); setHistoryScope(`${apiBase()}|${u.id}`, isDesktop); scheduleSweep(); };

export type AuthPhase = 'restoring' | 'anonymous' | 'signing_in' | 'authenticated' | 'recoverable_error' | 'signing_out';
interface AuthState {
  phase: AuthPhase;
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
  let attempt = 0;
  let credentials: Promise<void> = Promise.resolve();
  const current = (id: number, token?: string | null) => id === attempt && (token === undefined || getToken() === token);
  const writeCredential = (id: number, write: () => Promise<unknown>) => {
    credentials = credentials.catch(() => undefined).then(async () => { if (current(id)) await write(); });
    return credentials;
  };
  async function showAccount(user: User, id: number, token: string) {
    await ensureFileToken().catch(() => '');
    if (!current(id, token)) return;
    useLocale.getState().setLanguage(user.ui_language || 'en');
    scopeAssets(user);
    set({ user, loading: false, error: null, phase: 'authenticated' });
    connectSockets();
  }
  async function signIn(request: () => Promise<{ user: User; token: string }>) {
    const id = ++attempt;
    initialSession = undefined;
    set({ error: null, phase: 'signing_in' });
    try {
      const { user, token } = await request();
      if (!current(id)) return;
      await writeCredential(id, () => rememberDesktopAccount(user, token));
      if (!current(id)) return;
      bumpEpoch();
      closeSockets();
      resetUserStores();
      setToken(token);
      await showAccount(user, id, token);
    } catch (e) { if (current(id)) set({ loading: false, phase: getToken() ? 'recoverable_error' : 'anonymous', error: e instanceof Error ? e.message : String(e) }); }
  }
  async function bootstrap() {
    const id = ++attempt, token = getToken();
    if (!token) { set({ user: null, loading: false, phase: 'anonymous' }); return; }
    set({ loading: true, error: null, phase: 'restoring' });
    try {
      const me = await api.me();
      if (!current(id, token)) return;
      const selected = desktopAccounts?.selected();
      if (isDesktop && (!selected || selected.name !== me.display_name || selected.username !== me.username)) {
        await writeCredential(id, () => rememberDesktopAccount(me, token));
      }
      if (!current(id, token)) return;
      await showAccount(me, id, token);
    } catch (e) {
      if (!current(id, token)) return;
      let reason = e;
      if (e instanceof ApiError && e.apiResponse && e.status === 401) {
        try { await writeCredential(id, () => forgetActiveCredential()); } catch (storageError) { reason = storageError; }
        finally { if (current(id)) setToken(null); }
      }
      // A network failure is not evidence that the saved session was revoked.
      if (current(id)) set({ user: null, loading: false, phase: getToken() ? 'recoverable_error' : 'anonymous', error: reason instanceof Error ? reason.message : String(reason) });
    }
  }
  return {
    user: null, loading: true, error: null, phase: 'restoring',
    bootstrap: () => {
      if (!initialSession) {
        const pending = bootstrap().finally(() => { if (initialSession === pending) initialSession = undefined; });
        initialSession = pending;
      }
      return initialSession;
    },
    login: (username, password) => signIn(() => api.login(username, password)),
    register: (username, password, displayName) => signIn(() => api.register(username, password, displayName)),
    logout: async () => {
      const id = ++attempt;
      initialSession = undefined;
      set({ loading: true, phase: 'signing_out' });
      bumpEpoch();
      closeSockets();
      try { await api.logout(); } catch { /* Local sign-out also works offline. */ }
      if (!current(id)) return;
      await clearHistory();
      if (!current(id)) return;
      resetUserStores();
      try {
        await writeCredential(id, () => forgetActiveCredential());
        if (!current(id)) return;
        setToken(null);
        set({ user: null, loading: false, error: null, phase: 'anonymous' });
        if (isDesktop) location.reload();
      } catch (e) {
        if (!current(id)) return;
        setToken(null);
        set({ user: null, loading: false, phase: 'anonymous', error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
});
