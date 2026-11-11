// Where the app is, as a URL path, and back. Each place the user can open has its own address, so the browser's
// Back and Forward move between them, a reload stays put, and a link opens the same place for anyone who may see it:
//
//   /                                                         nothing open yet (the app picks the remembered place)
//   /admin                                                    the platform admin panel
//   /servers/{server}                                         a server with no channel open
//   /servers/{server}/watch/{channel}                         reading a channel's Main Chat without being a member
//   /servers/{server}/channels/{channel}                      a channel (its remembered chat window)
//   /servers/{server}/channels/{channel}/windows/{window}     a chat window
//   /servers/{server}/channels/{channel}/characters/{id}/{tab} a character's space (card, look, background, items)
//   /servers/{server}/channels/{channel}/gm/{tab}             the GM workspace (overview, module, script, scenes, knowledge, settings)
//   /servers/{server}/channels/{channel}/studio/{view}        the Log Studio (log, vn, pdf, voice, assets, published)
//
// Pure functions only: the app's base path is added by the caller (hooks/useRouteSync.ts).

export const GM_TABS = ['overview', 'module', 'script', 'scenes', 'knowledge', 'settings'] as const;
export const CHARACTER_TABS = ['card', 'look', 'background', 'items'] as const;
export const STUDIO_VIEWS = ['log', 'vn', 'pdf', 'voice', 'assets', 'published'] as const;
export type GmTab = typeof GM_TABS[number];
export type CharacterTab = typeof CHARACTER_TABS[number];

export type Page = 'none' | 'admin' | 'server' | 'watch' | 'channel' | 'chat' | 'character' | 'gm' | 'studio';
export interface Route { page: Page; server?: string; channel?: string; window?: string; character?: string; tab?: string }

// Ids are UUIDs; anything else in their place is not a route.
const isId = (s: string | undefined): s is string => !!s && /^[0-9a-fA-F-]{8,64}$/.test(s);
const pick = <T extends string>(list: readonly T[], value: string | undefined): T => (list as readonly string[]).includes(value ?? '') ? value as T : list[0];
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function parseRoute(path: string): Route {
  const p = path.split('/').filter(Boolean).map(decode);
  if (p[0] === 'admin' && p.length === 1) return { page: 'admin' };
  if (p[0] !== 'servers' || !isId(p[1])) return { page: 'none' };
  const server = p[1];
  if (p[2] === 'watch' && isId(p[3])) return { page: 'watch', server, channel: p[3] };
  if (p[2] !== 'channels' || !isId(p[3])) return { page: 'server', server };
  const channel = p[3];
  const [kind, id, extra] = p.slice(4);
  if (kind === 'windows' && isId(id)) return { page: 'chat', server, channel, window: id };
  if (kind === 'characters' && isId(id)) return { page: 'character', server, channel, character: id, tab: pick(CHARACTER_TABS, extra) };
  if (kind === 'gm') return { page: 'gm', server, channel, tab: pick(GM_TABS, id) };
  if (kind === 'studio') return { page: 'studio', server, channel, tab: pick(STUDIO_VIEWS, id) };
  return { page: 'channel', server, channel };
}

export function formatRoute(r: Route): string {
  const e = encodeURIComponent;
  if (r.page === 'admin') return '/admin';
  if (r.page === 'none' || !r.server) return '/';
  const server = `/servers/${e(r.server)}`;
  if (r.page === 'server' || !r.channel) return server;
  if (r.page === 'watch') return `${server}/watch/${e(r.channel)}`;
  const channel = `${server}/channels/${e(r.channel)}`;
  switch (r.page) {
    case 'chat': return r.window ? `${channel}/windows/${e(r.window)}` : channel;
    case 'character': return r.character ? `${channel}/characters/${e(r.character)}/${pick(CHARACTER_TABS, r.tab)}` : channel;
    case 'gm': return `${channel}/gm/${pick(GM_TABS, r.tab)}`;
    case 'studio': return `${channel}/studio/${pick(STUDIO_VIEWS, r.tab)}`;
    default: return channel;
  }
}

/** What the app shows, as a route: the same order of precedence as the page the shell renders. */
export interface RouteSource {
  serverId: string | null; channelId: string | null; windowId: string | null; channelRole?: string;
  adminOpen: boolean; spectateChannelId: string | null; characterSpaceId: string | null; characterTab: string;
  studioOpen: boolean; studioView: string; gmWorkspaceOpen: boolean; gmTab: string;
}
export function routeOf(s: RouteSource): Route {
  if (s.adminOpen) return { page: 'admin' };
  if (!s.serverId) return { page: 'none' };
  const server = s.serverId;
  if (s.spectateChannelId) return { page: 'watch', server, channel: s.spectateChannelId };
  if (!s.channelId) return { page: 'server', server };
  const channel = s.channelId;
  if (s.characterSpaceId) return { page: 'character', server, channel, character: s.characterSpaceId, tab: s.characterTab };
  if (s.studioOpen) return { page: 'studio', server, channel, tab: s.studioView };
  if (s.gmWorkspaceOpen && s.channelRole === 'gm') return { page: 'gm', server, channel, tab: s.gmTab };
  if (s.windowId) return { page: 'chat', server, channel, window: s.windowId };
  return { page: 'channel', server, channel };
}

/**
 * How a change of place enters the browser's history. Going somewhere else adds an entry (Back returns); filling in
 * a place that was still being opened (a server, then its channel and window) or leaving an address that was no
 * place at all replaces the current one, so Back never stops at a half-loaded step.
 */
export function historyMode(current: string, next: string): 'none' | 'replace' | 'push' {
  if (current === next) return 'none';
  if (parseRoute(current).page === 'none' || next.startsWith(current.replace(/\/$/, '') + '/')) return 'replace';
  return 'push';
}

// A change the app makes on its own (the open window or channel was deleted, a fallback after a failed load)
// replaces the current entry instead of adding one: Back should not lead to a place that is gone.
let replaceNext = false;
export function replaceNextRoute() { replaceNext = true; }
export function takeReplaceHint() { const r = replaceNext; replaceNext = false; return r; }
