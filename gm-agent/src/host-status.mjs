// Private GM state for the authenticated host UI, including story plans; credentials are excluded.
// Each section is built on its own, so one that cannot be read reports its error instead of hiding the rest.
import { openWindows } from "./roles/roster.mjs";
import { billableTokens } from "./store.mjs";
import { calendarPace, describeCalendar } from "./calendar.mjs";
import { MAIN } from "./timelines.mjs";
import { describeModels } from "./llm/routes.mjs";

const HOUR = 3600000;
const at = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const parsed = (s) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const clip = (s, n = 200) => { const v = String(s ?? ""); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

const usageCache = new WeakMap();
export function usageSnapshot(store, now = Date.now()) {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const since = day.getTime(), cached = usageCache.get(store);
  if (cached && cached.daySince === since && now >= cached.atMs && now - cached.atMs < 15000) return cached.value;
  const range = start => {
    const byPurpose = store.usageByPurpose(start);
    const summary = { calls: 0, failed: 0, unknown: 0, estimated: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
    for (const row of byPurpose) for (const key of Object.keys(summary)) summary[key] += row[key] ?? 0;
    summary.billable = billableTokens(summary);
    return { since: new Date(start).toISOString(), summary, byPurpose };
  };
  // Two indexed aggregates cover both ranges without loading individual calls or the entire history.
  const periods = { today: range(since), week: range(now - 7 * 86400000) };
  const value = { at: new Date(now).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: periods.today.summary, week: periods.week.summary, byPurpose: periods.today.byPurpose, periods };
  usageCache.set(store, { atMs: now, daySince: since, value });
  return value;
}

export function tableSnapshot(table, { cfg = table.cfg, channel = table.channel, realtime = null, now = Date.now() } = {}) {
  const errors = {};
  const section = (name, fn) => { try { return fn(); } catch (e) { errors[name] = clip(e.message); return null; } };
  const windows = table.windows ?? [];
  const wname = (id) => windows.find((w) => w.id === id)?.name ?? id;
  const cname = (id) => table.characters?.find((c) => c.id === id)?.name ?? id;

  const snapshot = {
    at: new Date(now).toISOString(),
    channel: section("channel", () => ({
      id: channel?.id ?? table.channelId, name: channel?.name ?? "", rule: table.profile?.id ?? channel?.rule_system ?? "coc7e",
      gm: channel?.my_role ? channel.my_role === "gm" : null, knowledge: channel?.knowledge_mode ?? null, language: table.language ?? "",
      warning: table.splitWarning || null,
    })),
    activity: section("activity", () => {
      const lastLineAt = Math.max(0, ...[...(table.windowState?.values() ?? [])].map((s) => s.lastLineAt || 0));
      const idleMs = cfg.autonomyIdleMinutes * 60000;
      return {
        turns: table.turns ?? 0, pendingTurns: table.pending ?? 0, paused: Boolean(table.generation?.paused),
        lastHumanAt: at(table.lastHumanAt), lastLineAt: at(lastLineAt),
        away: !table.lastHumanAt || now - table.lastHumanAt > idleMs,
        autonomousLastHour: (table.autonomousTurns ?? []).filter((t) => now - t < HOUR).length,
        splitInProgress: Boolean(table.journal), openingTurnsOwed: table.owedArrivals?.length ?? 0,
      };
    }),
    realtime: realtime ? { streams: [...(realtime.streams ?? [])], connected: [...(realtime.connected ?? [])] } : null,
    cast: section("cast", () => ({
      players: (table.characters ?? []).filter((c) => table.isPc?.(c.id)).map((c) => ({ name: c.name, player: c.player_name ?? null, timeline: table.timelines?.of(c.id)?.handle ?? null })),
      coplayers: (table.roster?.coplayers ?? []).map((c) => {
        const windowDetails = [...new Set(openWindows(c))].map(id => {
          const window = windows.find(w => w.id === id);
          return { id, name: window?.name ?? id, status: !window ? "missing" : window.archived_at ? "archived" : table.timelines?.retired?.(id) ? "ended" : "active" };
        });
        return { characterId: c.characterId, name: c.name, windows: windowDetails.map(w => w.name), windowDetails,
          seats: c.seats?.length ?? 0, timeline: table.timelines?.of(c.characterId)?.handle ?? null };
      }),
      npcs: (table.roster?.npcs ?? []).map((n) => n.name).slice(0, 60), npcCount: table.roster?.npcs?.length ?? 0,
      windows: windows.filter((w) => !w.archived_at).length,
    })),
    timelines: section("timelines", () => {
      const list = table.timelines?.list ?? [];
      const active = list.filter((t) => t.status === "active"), past = list.filter((t) => t.status !== "active").slice(-6).reverse();
      return [...active, ...past].map((t) => ({
        handle: `T${t.handle}`, name: t.name, status: t.status, primary: t.id === MAIN, span: t.id === MAIN ? null : t.span, opened: t.opened !== false,
        window: t.windowId ? wname(t.windowId) : t.id === MAIN ? wname(table.mainWindow?.()?.id) : null,
        members: t.members.map(cname), time: t.narrativeTime || "", place: t.location || "",
        mergedInto: t.mergedInto ? table.timelines.get(t.mergedInto)?.name ?? null : null,
      }));
    }),
    usage: section("usage", () => {
      const usage = usageSnapshot(table.store, now);
      return { ...usage, budget: cfg.dailyTokenBudget || 0, overBudget: Boolean(cfg.dailyTokenBudget) && usage.today.billable >= cfg.dailyTokenBudget };
    }),
    memory: section("memory", () => {
      const db = table.store.db;
      const chapters = db.prepare("SELECT scope LIKE 'coplayer:%' AS cp, count(*) AS n FROM chapters GROUP BY 1").all();
      return { lines: db.prepare("SELECT count(*) AS n FROM lines").get().n, gmChapters: chapters.find((x) => !x.cp)?.n ?? 0, coplayerChapters: chapters.find((x) => x.cp)?.n ?? 0, gmTokens: cfg.gmContextTokens, coplayerTokens: cfg.coplayerContextTokens };
    }),
    planner: section("planner", () => {
      const p = table.planner, arc = p.arc, notes = p.table ?? [];
      return {
        on: Boolean(p.on), mode: !p.on ? "off" : table.improv?.on ? "full" : "pace", busy: Boolean(table.memory?.jobs?.has("planner")),
        version: arc?.version ?? null, updatedAt: parsed(arc?.updatedAt), trigger: arc?.trigger ?? null, beat: arc?.beat?.title ?? null,
        moveOn: Boolean(arc?.verdict?.moveOn), threads: arc?.threads?.length ?? 0, impulses: (p.impulses ?? []).map((i) => i.name),
        window: p.window ? wname(p.window) : null, inbox: p.inbox?.length ?? 0,
        corrections: notes.filter((n) => n.kind === "correction").length, wishes: notes.filter((n) => n.kind === "wish").length,
        session: p.session ? { lines: p.session.lines, startedAt: at(p.session.startedAt) } : null, between: Boolean(p.between),
        model: [cfg.planner.provider, cfg.planner.model].filter(Boolean).join(" "), effort: cfg.planner.effort, finalReview: Boolean(cfg.planner.finalReview),
        plan: arc ?? null, pendingVersion: p.pending?.arc?.version ?? null,
      };
    }),
    daily: section("daily", () => table.dailyStatus?.() ?? { on: false }),
    calendar: section("calendar", () => {
      if (!table.calendarOn?.()) return { on: false };
      const pace = table.calendarPaceCfg(), held = calendarPace(table.calendar, { minMinutes: pace.minMinutes, minLines: pace.minLines, now });
      return { on: true, date: describeCalendar(table.calendar) || null, routine: table.calendar.routine?.text ?? null, lastBy: table.calendar.log?.at(-1)?.by ?? null, mayMove: held.ok, wait: held.ok ? null : held.wait, maxDays: pace.maxDays };
    }),
    casual: section("casual", () => {
      const c = table.casual;
      return c?.on ? { on: true, phones: Object.keys(c.phones ?? {}).length, pendingTexts: c.pending?.length ?? 0, log: c.log ? wname(c.log) : null } : { on: false };
    }),
    improv: section("improv", () => {
      const im = table.improv;
      return im?.on ? { on: true, world: im.world?.length ?? 0, secrets: im.secrets?.length ?? 0, truths: im.truths?.length ?? 0, published: Boolean(im.published?.hash) } : { on: false };
    }),
    bonds: section("bonds", () => (table.bonds ?? []).slice(0, 40).map((b) => ({ a: cname(b.a), b: cname(b.b), kind: b.kind, secret: Boolean(b.secret) }))),
    settings: section("settings", () => ({
      model: [cfg.llm.provider, cfg.llm.model].filter(Boolean).join(" "), effort: cfg.llm.effort, cacheTtl: cfg.llm.cacheTtl,
      models: describeModels(cfg),   // which provider and model each function runs on (llm/routes.mjs)
      autonomy: cfg.autonomy, timelineAuto: cfg.timelineAuto, sceneForks: cfg.sceneForks, scenarioAuto: cfg.scenarioAuto, maxActive: cfg.timelineMaxActive,
    })),
  };
  if (Object.keys(errors).length) snapshot.errors = errors;
  return snapshot;
}
