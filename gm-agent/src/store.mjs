// The client's own data store: one SQLite file per channel next to the state file (`<channel>.db`), through Node's
// built-in node:sqlite. The JSON state file stays the source of truth for the table (roster, timelines, guard); this
// holds what grows with a campaign:
//   lines    – a local copy of the chat as the Keeper account reads it, so a long history is fetched once;
//   chapters – compacted history: `scope` is "gm" (the Keeper's memory of a window) or "coplayer:<character id>" (what
//              that co-player remembers, built only from lines it witnessed); level 0 summarises lines, level 1+ merges
//              chapters;
//   usage    – one row per model call (input, cache reads and writes, output tokens);
//   kv       – small values;
//   phone    – casual mode's text messages (who to whom), so a thread can be read back (casual.mjs);
//   plans    – every version of the story plan in full (draft, critique, final), for `plan show --full` (planner.mjs).
// The run process owns campaign state; setup may also append usage rows through SQLite WAL.
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
CREATE TABLE IF NOT EXISTS plans (version INTEGER PRIMARY KEY, at INTEGER NOT NULL, trigger TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phone (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL DEFAULT 0, window_id TEXT NOT NULL, from_id TEXT NOT NULL,
  to_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS phone_pair ON phone(from_id, to_id, id);
`;

export const storePath = (stateDir, channelId) => path.join(stateDir, `${channelId}.db`);

export class Store {
  // `file` is a path, or ":memory:" (tests, read-only commands without a state directory).
  constructor(file = ":memory:") {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Upgrade existing channel databases without losing their earlier token history. The lock serializes setup/run.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(this.db.prepare("PRAGMA table_info(usage)").all().map((c) => c.name));
      for (const [name, type] of Object.entries({
        call_id: "TEXT NOT NULL DEFAULT ''", request_id: "TEXT NOT NULL DEFAULT ''", provider: "TEXT NOT NULL DEFAULT ''",
        phase: "TEXT NOT NULL DEFAULT ''", attempt: "INTEGER NOT NULL DEFAULT 1", duration_ms: "INTEGER",
        status: "TEXT NOT NULL DEFAULT 'completed'", usage_known: "INTEGER NOT NULL DEFAULT 1",
        estimated: "INTEGER NOT NULL DEFAULT 0", http_status: "INTEGER",
      })) if (!columns.has(name)) this.db.exec(`ALTER TABLE usage ADD COLUMN ${name} ${type}`);
      if (!columns.has("estimated")) this.db.exec("UPDATE usage SET estimated = 1 WHERE model = 'mock'");
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.q = {
      putLine: this.db.prepare("INSERT INTO lines(seq, id, window_id, json) VALUES(?, ?, ?, ?) ON CONFLICT(seq) DO UPDATE SET json = excluded.json, window_id = excluded.window_id, id = excluded.id"),
      lines: this.db.prepare("SELECT json FROM lines WHERE window_id = ? AND seq > ? AND seq <= ? ORDER BY seq"),
      firstSeq: this.db.prepare("SELECT min(seq) AS s FROM lines WHERE window_id = ?"),
      lastSeq: this.db.prepare("SELECT max(seq) AS s FROM lines WHERE window_id = ?"),
      addChapter: this.db.prepare("INSERT INTO chapters(scope, window_id, from_seq, to_seq, level, text, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)"),
      chapters: this.db.prepare("SELECT id, scope, window_id AS windowId, from_seq AS fromSeq, to_seq AS toSeq, level, text FROM chapters WHERE scope = ? AND window_id = ? ORDER BY from_seq, id"),
      dropChapter: this.db.prepare("DELETE FROM chapters WHERE id = ?"),
      usage: this.db.prepare("INSERT INTO usage(at, purpose, model, input, cache_read, cache_write, output, call_id, request_id, provider, phase, attempt, duration_ms, status, usage_known, estimated, http_status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      usageSince: this.db.prepare("SELECT count(*) AS calls, coalesce(sum(input),0) AS input, coalesce(sum(cache_read),0) AS cacheRead, coalesce(sum(cache_write),0) AS cacheWrite, coalesce(sum(output),0) AS output FROM usage WHERE at >= ?"),
      get: this.db.prepare("SELECT value FROM kv WHERE key = ?"),
      addPlan: this.db.prepare("INSERT INTO plans(version, at, trigger, json) VALUES(?, ?, ?, ?) ON CONFLICT(version) DO UPDATE SET at = excluded.at, trigger = excluded.trigger, json = excluded.json"),
      plan: this.db.prepare("SELECT version, at, trigger, json FROM plans WHERE version = ?"),
      latestPlan: this.db.prepare("SELECT version, at, trigger, json FROM plans ORDER BY version DESC LIMIT 1"),
      addPhone: this.db.prepare("INSERT INTO phone(seq, window_id, from_id, to_id, text, at) VALUES(?, ?, ?, ?, ?, ?)"),
      thread: this.db.prepare("SELECT seq, from_id AS \"from\", to_id AS \"to\", text, at FROM phone WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT ?"),
      phoneOf: this.db.prepare("SELECT seq, from_id AS \"from\", to_id AS \"to\", text, at FROM phone WHERE from_id = ? OR to_id = ? ORDER BY id DESC LIMIT ?"),
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
  recordUsage({ purpose = "", model = "", input = 0, cacheRead = 0, cacheWrite = 0, output = 0, at = Date.now(),
    callId = "", requestId = "", provider = "", phase = "", attempt = 1, durationMs = null, status = "completed",
    usageKnown = true, estimated = false, httpStatus = null }) {
    const n = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const result = this.q.usage.run(at, purpose, model, n(input), n(cacheRead), n(cacheWrite), n(output), callId,
      requestId, provider, phase, n(attempt), durationMs === null ? null : n(durationMs), status, usageKnown ? 1 : 0,
      estimated || model === "mock" ? 1 : 0, httpStatus);
    return Number(result.lastInsertRowid);
  }
  usageSince(at) { return { ...this.q.usageSince.get(at) }; }

  // Counters are observed totals, with missing/estimated calls explicitly counted alongside them.
  usageByPurpose(since = 0, purpose = "") {
    return this.db.prepare(`SELECT purpose, phase, provider, model, count(*) AS calls,
      sum(status = 'failed') AS failed, sum(usage_known = 0) AS unknown, sum(estimated) AS estimated,
      sum(input) AS input, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite, sum(output) AS output,
      sum(input + output) AS total, max(CASE WHEN usage_known = 1 THEN output END) AS maxOutput,
      avg(CASE WHEN usage_known = 1 THEN output END) AS averageOutput, sum(duration_ms) AS durationMs
      FROM usage WHERE at >= ? AND (? = '' OR purpose = ?) GROUP BY purpose, phase, provider, model
      ORDER BY total DESC, purpose, phase, provider, model`).all(since, purpose, purpose).map((r) => ({ ...r }));
  }

  usageCalls({ since = 0, purpose = "", limit = 50, beforeId = Number.MAX_SAFE_INTEGER } = {}) {
    return this.db.prepare(`SELECT id, at, call_id AS callId, request_id AS requestId, purpose, phase, attempt,
      provider, model, input, cache_read AS cacheRead, cache_write AS cacheWrite, output, input + output AS total,
      duration_ms AS durationMs, status, usage_known AS usageKnown, estimated, http_status AS httpStatus
      FROM usage WHERE at >= ? AND (? = '' OR purpose = ?) AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(since, purpose, purpose, beforeId, Math.max(1, Math.min(10000, limit))).map((r) => ({ ...r,
        usageKnown: Boolean(r.usageKnown), estimated: Boolean(r.estimated) }));
  }

  // ---- phone (casual mode)
  addPhone({ seq = 0, windowId, from, to, text, at = Date.now() }) { this.q.addPhone.run(seq | 0, windowId, from, to, String(text), at); }
  // Messages between two characters, oldest first (the newest `limit`).
  thread(a, b, limit = 40) { return this.q.thread.all(a, b, b, a, limit).map((r) => ({ ...r })).reverse(); }
  // Every message to or from one character, oldest first (the newest `limit`).
  phoneOf(id, limit = 30) { return this.q.phoneOf.all(id, id, limit).map((r) => ({ ...r })).reverse(); }

  // ---- story plans (planner.mjs)
  addPlan({ version, at = Date.now(), trigger = "", record }) { this.q.addPlan.run(version | 0, at, trigger, JSON.stringify(record)); }
  plan(version) { const r = this.q.plan.get(version | 0); return r ? { ...r, record: JSON.parse(r.json) } : null; }
  latestPlan() { const r = this.q.latestPlan.get(); return r ? { ...r, record: JSON.parse(r.json) } : null; }

  // ---- kv
  get(key, fallback = null) { const r = this.q.get.get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.q.set.run(key, JSON.stringify(value)); }
}

// Tokens as the provider bills them, weighted like the price list: cache reads at a tenth, writes and output in full.
export const billableTokens = (u) => Math.round((u.input - u.cacheRead - u.cacheWrite) + u.cacheRead * 0.1 + u.cacheWrite + u.output);
