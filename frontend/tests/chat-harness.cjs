// The chat store (src/store/chat.ts) with stand-ins: an api whose requests wait until a test answers them, and an
// in-memory history in place of IndexedDB (lib/chatHistory).
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function chatStore({ kept = new Map() } = {}) {
  let epoch = 0;
  const pending = { messages: [], messagesAfter: [], recall: [] }, toasts = [], writes = [], drops = [];
  const wait = (kind, args) => new Promise((resolve, reject) => pending[kind].push({ ...args, resolve, reject }));
  const api = {
    messages: (ch, w, before, limit) => wait('messages', { ch, w, before, limit }),
    messagesAfter: (ch, w, after, limit) => wait('messagesAfter', { ch, w, after, limit }),
    recallMessage: (ch, id) => wait('recall', { ch, id }),
  };
  const history = {
    readHistory: async (w) => kept.get(w) ?? null,
    writeHistory: (w, entry) => { const e = entry(); if (e) { kept.set(w, e); writes.push(e); } },
    dropHistory: async (match) => { drops.push(match); for (const [w, e] of kept) if (w === match.windowId || e.channelId === match.channelId) kept.delete(w); },
  };
  // As the app is built: an ES5 spread of a Map iterator would be empty.
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/store/chat.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  const req = (name) => {
    if (name === 'zustand') return require('zustand');
    if (name === '../api/client') return { api };
    if (name === '../lib/chatHistory') return history;
    if (name === './ui') return { useUi: { getState: () => ({ toast: (text, kind) => toasts.push({ text, kind }) }) } };
    if (name === './session') return { sessionEpoch: () => epoch, isStale: (e) => e !== epoch };
    throw Error(name);
  };
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  // The next request of a kind, once the store has made it (it may first read the kept history).
  const next = async (kind) => {
    for (let i = 0; i < 100 && !pending[kind].length; i++) await new Promise((r) => setImmediate(r));
    return pending[kind].shift();
  };
  const idle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { ...mod.exports, store: mod.exports.useChat, pending, next, idle, toasts, writes, drops, kept, switchSession: () => ++epoch };
}
const msg = (id, seq, extra = {}) => ({ id, seq, channel_id: 'c', chat_window_id: 'w', author_id: 'u', content: `line ${id}`, kind: 'ic', created_at: '2026-01-01T00:00:00Z', recall_seconds_left: null, ...extra });
const tomb = (m) => ({ ...m, content: '', dice: null, reference_ids: [], recalled_at: '2026-11-07T00:00:00Z', recall_seconds_left: null });
module.exports = { chatStore, msg, tomb };
