// The client's own data store: one SQLite file per channel next to the state file (`<channel>.db`), through Node's
// built-in node:sqlite. The JSON state file stays the source of truth for the table (roster, timelines, guard); this
// holds what grows with a campaign:
//   lines    – a local copy of the chat as the Keeper account reads it, so a long history is fetched once;
//   chapters – compacted history: `scope` is "gm" (the Keeper's memory of a window) or "coplayer:<character id>" (what
//              that co-player remembers, built only from lines it witnessed); level 0 summarises lines, level 1+ merges
//              chapters;
//   usage    – one row per model call (input, cache reads and writes, output tokens);
//   kv       – small values.
// The process that keeps the state file (the `run` lock) is the only writer.
import fs from "node:fs";
import path from "node:path";

// node:sqlite still prints an ExperimentalWarning on Node 22; the store does not need the console noise.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/sqlite/i.test(String(warning?.message ?? warning))) return undefined;
  return emitWarning.call(this, warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = emitWarning;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lines (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, window_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lines_window ON lines(window_id, seq);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, window_id TEXT NOT NULL DEFAULT '', from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chapters_scope ON chapters(scope, window_id, from_seq);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const storePath = (stateDir, channelId) => path.join(stateDir, `${channelId}.db`);

export class Store {
  // `file` is a path, or ":memory:" (tests, read-only commands without a state directory).
  constructor(file = ":memory:") {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.q = {
      putLine: this.db.prepare("INSERT INTO lines(seq, id, window_id, json) VALUES(?, ?, ?, ?) ON CONFLICT(seq) DO UPDATE SET json = excluded.json, window_id = excluded.window_id, id = excluded.id"),
      lines: this.db.prepare("SELECT json FROM lines WHERE window_id = ? AND seq > ? AND seq <= ? ORDER BY seq"),
      firstSeq: this.db.prepare("SELECT min(seq) AS s FROM lines WHERE window_id = ?"),
      lastSeq: this.db.prepare("SELECT max(seq) AS s FROM lines WHERE window_id = ?"),
      addChapter: this.db.prepare("INSERT INTO chapters(scope, window_id, from_seq, to_seq, level, text, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)"),
      chapters: this.db.prepare("SELECT id, scope, window_id AS windowId, from_seq AS fromSeq, to_seq AS toSeq, level, text FROM chapters WHERE scope = ? AND window_id = ? ORDER BY from_seq, id"),
      dropChapter: this.db.prepare("DELETE FROM chapters WHERE id = ?"),
      usage: this.db.prepare("INSERT INTO usage(at, purpose, model, input, cache_read, cache_write, output) VALUES(?, ?, ?, ?, ?, ?, ?)"),
      usageSince: this.db.prepare("SELECT count(*) AS calls, coalesce(sum(input),0) AS input, coalesce(sum(cache_read),0) AS cacheRead, coalesce(sum(cache_write),0) AS cacheWrite, coalesce(sum(output),0) AS output FROM usage WHERE at >= ?"),
      get: this.db.prepare("SELECT value FROM kv WHERE key = ?"),
      set: this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    };
  }

  static open(stateDir, channelId) { return new Store(storePath(stateDir, channelId)); }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  tx(fn) {
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- lines
  putLines(rows) {
    if (!rows?.length) return;
    this.tx(() => { for (const m of rows) if (Number.isFinite(m?.seq) && m.chat_window_id) this.q.putLine.run(m.seq, String(m.id ?? ""), m.chat_window_id, JSON.stringify(m)); });
  }
  // Lines of a window with fromSeq < seq <= toSeq, oldest first.
  lines(windowId, { after = 0, upTo = Number.MAX_SAFE_INTEGER } = {}) {
    return this.q.lines.all(windowId, after, upTo).map((r) => JSON.parse(r.json));
  }
  firstSeq(windowId) { return this.q.firstSeq.get(windowId)?.s ?? null; }
  lastSeq(windowId) { return this.q.lastSeq.get(windowId)?.s ?? null; }

  // ---- chapters
  chapters(scope, windowId = "") { return this.q.chapters.all(scope, windowId).map((r) => ({ ...r })); }
  addChapter({ scope, windowId = "", fromSeq, toSeq, level = 0, text }) {
    this.q.addChapter.run(scope, windowId, fromSeq, toSeq, level, text, new Date().toISOString());
  }
  // Replaces `ids` with one merged chapter, atomically.
  mergeChapters(ids, chapter) {
    this.tx(() => { for (const id of ids) this.q.dropChapter.run(id); this.addChapter(chapter); });
  }

  // ---- usage
  recordUsage({ purpose = "", model = "", input = 0, cacheRead = 0, cacheWrite = 0, output = 0, at = Date.now() }) {
    this.q.usage.run(at, purpose, model, input | 0, cacheRead | 0, cacheWrite | 0, output | 0);
  }
  usageSince(at) { return { ...this.q.usageSince.get(at) }; }

  // ---- kv
  get(key, fallback = null) { const r = this.q.get.get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.q.set.run(key, JSON.stringify(value)); }
}

// Tokens as the provider bills them, weighted like the price list: cache reads at a tenth, writes and output in full.
export const billableTokens = (u) => Math.round((u.input - u.cacheRead - u.cacheWrite) + u.cacheRead * 0.1 + u.cacheWrite + u.output);
