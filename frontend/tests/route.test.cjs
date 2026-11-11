const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// Addresses of the app's places (src/lib/route.ts).
const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
const { parseRoute, formatRoute, routeOf, historyMode, replaceNextRoute, takeReplaceHint } = mod.exports;
const S = '11111111-1111-4111-8111-111111111111', C = '22222222-2222-4222-8222-222222222222', W = '33333333-3333-4333-8333-333333333333', P = '44444444-4444-4444-8444-444444444444';
const base = `/servers/${S}/channels/${C}`;

test('every place has an address that reads back as the same place', () => {
  const places = [
    ['/', { page: 'none' }],
    ['/admin', { page: 'admin' }],
    [`/servers/${S}`, { page: 'server', server: S }],
    [`/servers/${S}/watch/${C}`, { page: 'watch', server: S, channel: C }],
    [base, { page: 'channel', server: S, channel: C }],
    [`${base}/windows/${W}`, { page: 'chat', server: S, channel: C, window: W }],
    [`${base}/characters/${P}/look`, { page: 'character', server: S, channel: C, character: P, tab: 'look' }],
    [`${base}/gm/settings`, { page: 'gm', server: S, channel: C, tab: 'settings' }],
    [`${base}/studio/vn`, { page: 'studio', server: S, channel: C, tab: 'vn' }],
  ];
  for (const [url, route] of places) {
    assert.deepEqual(parseRoute(url), route, url);
    assert.equal(formatRoute(route), url, url);
  }
});

test('a missing or unknown tab reads as the first one; anything else is no place', () => {
  assert.equal(parseRoute(`${base}/gm`).tab, 'overview');
  assert.equal(parseRoute(`${base}/gm/nonsense`).tab, 'overview');
  assert.equal(parseRoute(`${base}/studio`).tab, 'log');
  assert.equal(parseRoute(`${base}/characters/${P}`).tab, 'card');
  assert.equal(formatRoute({ page: 'gm', server: S, channel: C }), `${base}/gm/overview`);
  for (const junk of ['/servers/not-an-id', '/channels/' + C, '/foo', '/servers/../etc', '/admin/extra']) assert.equal(parseRoute(junk).page, 'none', junk);
  assert.deepEqual(parseRoute(`/servers/${S}/channels/oops`), { page: 'server', server: S });
  assert.deepEqual(parseRoute(`${base}/windows/oops`), { page: 'channel', server: S, channel: C });
  assert.deepEqual(parseRoute(`${base}/`), parseRoute(base), 'a trailing slash changes nothing');
});

test('the address follows what the shell shows, in its order of precedence', () => {
  const at = { serverId: S, channelId: C, windowId: W, channelRole: 'gm', adminOpen: false, spectateChannelId: null, characterSpaceId: null, characterTab: 'card', studioOpen: false, studioView: 'log', gmWorkspaceOpen: false, gmTab: 'overview' };
  const url = (over) => formatRoute(routeOf({ ...at, ...over }));
  assert.equal(url({}), `${base}/windows/${W}`);
  assert.equal(url({ gmWorkspaceOpen: true, gmTab: 'scenes' }), `${base}/gm/scenes`);
  assert.equal(url({ gmWorkspaceOpen: true, channelRole: 'player' }), `${base}/windows/${W}`, 'a player is shown the chat, not the GM workspace');
  assert.equal(url({ studioOpen: true, studioView: 'pdf', gmWorkspaceOpen: true }), `${base}/studio/pdf`);
  assert.equal(url({ characterSpaceId: P, characterTab: 'items', studioOpen: true }), `${base}/characters/${P}/items`);
  assert.equal(url({ spectateChannelId: C, characterSpaceId: P }), `/servers/${S}/watch/${C}`);
  assert.equal(url({ adminOpen: true, spectateChannelId: C }), '/admin');
  assert.equal(url({ windowId: null }), base);
  assert.equal(url({ channelId: null }), `/servers/${S}`);
  assert.equal(url({ serverId: null }), '/');
});

test('going somewhere adds a history entry; filling in a place being opened, or leaving no place, replaces it', () => {
  assert.equal(historyMode(`${base}/windows/${W}`, `${base}/windows/${W}`), 'none');
  assert.equal(historyMode(`${base}/windows/${W}`, `${base}/gm/overview`), 'push');
  assert.equal(historyMode(`${base}/gm/overview`, `${base}/gm/settings`), 'push');
  assert.equal(historyMode(`${base}/windows/${W}`, `/servers/${S}`), 'push', 'another server: a new entry first…');
  assert.equal(historyMode(`/servers/${S}`, `${base}/windows/${W}`), 'replace', '…then its channel and window fill it in');
  assert.equal(historyMode('/', `${base}/windows/${W}`), 'replace');
  assert.equal(historyMode('/somewhere/else', `${base}/windows/${W}`), 'replace');
  assert.equal(historyMode(`/servers/${S}/channels/${C.slice(0, 30)}`, `${base}/windows/${W}`), 'push', 'a prefix only counts at a segment boundary');
  // A change the app makes on its own is marked once, and the mark is used up.
  assert.equal(takeReplaceHint(), false);
  replaceNextRoute(); assert.equal(takeReplaceHint(), true); assert.equal(takeReplaceHint(), false);
});
