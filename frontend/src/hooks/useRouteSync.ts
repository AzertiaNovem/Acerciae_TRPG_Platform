import { useEffect } from 'react';
import { t as tr } from '../i18n';
import { useNav } from '../store/nav';
import { useStudio, type StudioView } from '../store/studio';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import { formatRoute, historyMode, parseRoute, routeOf, takeReplaceHint, type CharacterTab, type GmTab, type Route } from '../lib/route';

// The address bar follows the app (lib/route.ts): each place opened gets its own URL, Back and Forward move between
// them, a reload or a shared link opens the same place, and the page title names it.
const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const TITLE = document.title;
const appPath = (path: string) => (BASE && path.startsWith(BASE) ? path.slice(BASE.length) : path) || '/';
let firstLoad = true;   // a link someone opened (not a sign-in to another account on the desktop)

function current(): Route {
  const n = useNav.getState();
  return routeOf({
    serverId: n.serverId, channelId: n.channelId, windowId: n.windowId, channelRole: n.channel?.my_role,
    adminOpen: n.adminOpen, spectateChannelId: n.spectateChannelId, characterSpaceId: n.characterSpaceId, characterTab: n.characterTab,
    studioOpen: n.studioOpen, studioView: useStudio.getState().view, gmWorkspaceOpen: n.gmWorkspaceOpen, gmTab: n.gmTab,
  });
}

function title(r: Route): string {
  const n = useNav.getState();
  const channel = n.channel?.name ?? '';
  const name = r.page === 'admin' ? tr('Platform administration')
    : r.page === 'chat' ? n.windows.find((w) => w.id === r.window)?.name
    : r.page === 'character' ? n.characters.find((c) => c.id === r.character)?.name
    : r.page === 'gm' ? tr('GM workspace')
    : r.page === 'studio' ? tr('Log Studio')
    : r.page === 'watch' ? n.spectatable.find((c) => c.id === r.channel)?.name
    : r.page === 'server' ? n.servers.find((s) => s.id === r.server)?.name : '';
  const parts = [name, ['chat', 'character', 'gm', 'studio'].includes(r.page) ? channel : ''].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} — Acerciae` : TITLE;
}

/** Opens what `r` names, as far as this account may: true when all of it was found. */
async function applyRoute(r: Route): Promise<boolean> {
  const nav = useNav.getState;
  if (r.page === 'admin') {
    if (useAuth.getState().user?.is_admin !== true) return false;
    nav().setAdminOpen(true); return true;
  }
  if (nav().adminOpen) nav().setAdminOpen(false);
  if (r.page === 'none' || !r.server) return true;
  if (!nav().servers.some((s) => s.id === r.server)) return false;
  if (nav().serverId !== r.server) await nav().selectServer(r.server, r.page === 'watch' ? undefined : { channel: r.channel, window: r.window });
  if (nav().serverId !== r.server) return false;
  if (r.page === 'server') { nav().showChat(); return true; }
  if (r.page === 'watch') {
    if (!nav().spectatable.some((c) => c.id === r.channel)) await nav().loadSpectatable().catch(() => undefined);
    if (!nav().spectatable.some((c) => c.id === r.channel)) return false;
    nav().openSpectate(r.channel!); return true;
  }
  if (!nav().channels.some((c) => c.id === r.channel)) return false;
  if (nav().channelId !== r.channel) await nav().selectChannel(r.channel!, r.window);
  const s = nav();
  if (s.channelId !== r.channel) return false;
  switch (r.page) {
    case 'character':
      if (!s.characters.some((c) => c.id === r.character)) { s.showChat(); return false; }
      s.openCharacter(r.character!, r.tab as CharacterTab); return true;
    case 'gm':
      if (s.channel?.my_role !== 'gm') { s.showChat(); return false; }
      s.setGmWorkspaceOpen(true, r.tab as GmTab); return true;
    case 'studio':
      s.setStudioOpen(true); useStudio.getState().setView(r.tab as StudioView); return true;
    default: {
      const found = !!r.window && s.windows.some((w) => w.id === r.window);
      const w = found ? r.window! : s.windowId;
      if (w) s.selectWindow(w); else s.showChat();
      return !r.window || found;
    }
  }
}

export function useRouteSync() {
  useEffect(() => {
    let alive = true, applying = 0;
    const write = (mode?: 'replace') => {
      if (!alive || applying || useNav.getState().pending) return;   // written once the switch is done
      const hinted = takeReplaceHint();
      const r = current();
      const next = formatRoute(r);
      const here = appPath(location.pathname);
      let how = mode && here !== next ? mode : historyMode(here, next);
      if (how === 'push' && hinted) how = 'replace';
      if (how === 'push') history.pushState(null, '', BASE + next);
      else if (how === 'replace') history.replaceState(null, '', BASE + next + location.search + location.hash);
      document.title = title(r);
    };
    // Applies a URL (on start, and on Back or Forward); the address is written once it is done.
    const open = async (start: boolean) => {
      const r = parseRoute(appPath(location.pathname));
      const told = start ? firstLoad : true;
      applying++;
      let ok = true;
      try {
        if (start) await useNav.getState().loadServers(r);
        ok = await applyRoute(r);
      } catch { ok = false; }
      finally {
        applying--;
        if (start) firstLoad = false;
        if (alive && !applying) write('replace');
      }
      if (alive && !ok && told && r.page !== 'none') useUi.getState().toast(tr('That page is not available to this account.'), 'error');
    };
    const offNav = useNav.subscribe(() => write());
    const offStudio = useStudio.subscribe((s, prev) => { if (s.view !== prev.view) write(); });
    const onPop = () => { void open(false); };
    window.addEventListener('popstate', onPop);
    void open(true);
    return () => { alive = false; offNav(); offStudio(); window.removeEventListener('popstate', onPop); };
  }, []);
}
