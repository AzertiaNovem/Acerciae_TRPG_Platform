// The story's calendar: what date it is in the fiction, so the GM, the planner and the co-players share one sense of
// time (weekdays, seasons, "three days ago"). A date is always YYYY-MM-DD (a world with its own calendar numbers its
// years and months the same way), shown with its weekday: "1923-10-02 (Tuesday)".
//
// The first date is the story planner's to choose, from the era, the World setting and the plots, with a time of day
// that fits; a year outside the channel's era is moved into it. With it, the planner sets the `routine`: what everyday
// life is busy with on that date, from the world's own calendar (the World setting may describe one: a school year, a
// fishing season, holidays), and the routine events coming up. The routine is common knowledge: the GM and every
// co-player read it.
//
// Afterwards the GM moves the date on as time passes in play (the `date` action, or `advance_days` on a scenario
// change), and the final review after a session moves it on between sessions. It never runs backwards. Each timeline
// keeps its own time of day (timelines.mjs); the date is the campaign's. State key `calendar`; each change in its log
// says who made it (`by`: "operator", "planner", "final review", or "keeper" for the GM: the stored value is kept,
// so older state files read the same; changedBy shows it as "GM").
//
// The GM is held to a pace (config `calendar`): after the date moves (by anyone), the GM may move it on again
// only once enough real time and enough player lines of play have passed, and never by more than a few days at once.
// The time of day moves freely within the day. The operator and the final review are not held to it.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LOG_KEPT = 12;
const MAX_UPCOMING = 3;
export const MAX_ADVANCE_DAYS = 3650;
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) : t; };
// Who made a change, as shown to the GM and the operator: the stored "keeper" reads "GM".
export const changedBy = (by) => (by === "keeper" ? "GM" : String(by ?? ""));

// A UTC date for "YYYY-MM-DD", or null (also for impossible dates such as 1925-02-30).
export function parseIso(s) {
  const m = String(s ?? "").trim().match(ISO);
  if (!m) return null;
  const d = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3])));
  d.setUTCFullYear(Number(m[1]));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}
const isoOf = (d) => `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };

export function calendarState(x) {
  const c = x && typeof x === "object" ? x : {};
  return {
    date: parseIso(c.date) ? String(c.date).trim() : "",
    time: clip(c.time, 80),
    log: Array.isArray(c.log) ? c.log.filter((e) => e && e.to).slice(-LOG_KEPT) : [],
    routine: routineState(c.routine),
    since: sinceState(c.since),
  };
}

// When the date last moved and how many player lines of play there have been since (the pace); null until it moves.
function sinceState(s) {
  const at = Number(s?.at);
  return s && typeof s === "object" && Number.isFinite(at) ? { at, lines: Math.max(0, Math.trunc(Number(s.lines)) || 0) } : null;
}

function routineState(r) {
  if (!r || typeof r !== "object" || !clip(r.text, 400)) return null;
  const upcoming = (Array.isArray(r.upcoming) ? r.upcoming : []).map((u) => ({ when: clip(u?.when, 80), what: clip(u?.what, 200) })).filter((u) => u.what).slice(0, MAX_UPCOMING);
  return { text: clip(r.text, 400), upcoming, date: parseIso(r.date) ? r.date : "" };
}

// "1923-10-02 (Tuesday)"; "" for anything that is not a real YYYY-MM-DD date.
export function dateLabel(date) {
  const d = parseIso(date);
  return d ? `${isoOf(d)} (${WEEKDAYS[d.getUTCDay()]})` : "";
}

// "1923-10-02 (Tuesday), morning"; "" until the first date is set.
export function describeCalendar(cal, { time = cal?.time } = {}) {
  if (!cal?.date) return "";
  return `${dateLabel(cal.date)}${time ? `, ${time}` : ""}`;
}

// The years an era allows, from the channel's era text ("1920s", "1923", "1890-1899", "1890s–1910s"), or null.
export function eraYears(era) {
  const nums = [...String(era ?? "").matchAll(/(\d{3,4})(s)?/g)].map((m) => ({ y: Number(m[1]), decade: Boolean(m[2]) }));
  if (!nums.length) return null;
  return { from: Math.min(...nums.map((n) => n.y)), to: Math.max(...nums.map((n) => n.y + (n.decade ? 9 : 0))) };
}

// The planner's first date, kept inside the era: the year moves to the nearest allowed one (29 February becomes the
// 28th when that year has none). Returns {date, moved}, or null when `date` is not a real date.
export function fitEra(date, era) {
  const d = parseIso(date);
  if (!d) return null;
  const range = eraYears(era);
  const y = d.getUTCFullYear();
  if (!range || (y >= range.from && y <= range.to)) return { date: isoOf(d), moved: false };
  const year = String(Math.min(range.to, Math.max(range.from, y))).padStart(4, "0");
  const [, mm, dd] = isoOf(d).split("-");
  return { date: isoOf(parseIso(`${year}-${mm}-${dd}`) ?? parseIso(`${year}-${mm}-28`)), moved: true };
}

// Moves the calendar on. `days` ≥ 0 (clipped to `maxDays`); `date` (YYYY-MM-DD) sets the date (an earlier one is
// refused, and so is one more than `maxDays` ahead); `time` sets the time of day (cleared when days pass without one).
// Before the first date, days cannot pass. With `pace` ({minMinutes, minLines}), a day or more passes only once that
// much real time and that many player lines have gone by since the date last moved (calendarPace). Returns {changed,
// days, from, to} (and `clipped`, the days asked for, when fewer passed) or {changed: false, refused} (`pace: true`
// when the pace held it back).
export function advanceCalendar(cal, { days, date, time, by = "keeper", why = "", seq = 0, now = Date.now(), maxDays = MAX_ADVANCE_DAYS, pace = null } = {}) {
  const before = describeCalendar(cal);
  let n = Number(days);
  n = Number.isFinite(n) ? Math.round(n) : 0;
  if (n < 0) return { changed: false, refused: "the calendar never runs backwards" };
  const asked = n;
  n = Math.min(n, maxDays);
  const target = String(date ?? "").trim();
  const cur = parseIso(cal.date);
  let next = null;
  if (target) {
    next = parseIso(target);
    if (!next) return { changed: false, refused: `"${clip(target, 40)}" is not a date: dates are YYYY-MM-DD` };
    if (cur) {
      const diff = Math.round((next - cur) / 86400000);
      if (diff < 0) return { changed: false, refused: `${dateLabel(target)} is before ${dateLabel(cal.date)}: the calendar never runs backwards` };
      if (diff > maxDays) return { changed: false, refused: `${diff} days is more than ${maxDays} at once` };
      n = diff;
    } else n = 0;   // the first date
  } else if (n && cur) next = addDays(cur, n);
  else if (n) return { changed: false, refused: "the story has no date yet" };
  if (n > 0 && pace) {
    const p = calendarPace(cal, { now, ...pace });
    if (!p.ok) return { changed: false, refused: `the date moved on too recently: it may move on again after ${p.wait}`, pace: true };
  }
  if (next) cal.date = isoOf(next);
  if (time !== undefined && time !== null && String(time).trim()) cal.time = clip(time, 80);
  else if (n) cal.time = "";
  const after = describeCalendar(cal);
  if (after === before && (cal.date || !time)) return { changed: false };
  if (!cal.date) return { changed: true, days: 0, from: "", to: "" };   // a time of day before the first date
  if (n > 0 || !cur) cal.since = { at: now, lines: 0 };
  cal.log = [...cal.log, { at: new Date(now).toISOString(), seq, from: before, to: after, days: n, by, why: clip(why, 200) }].slice(-LOG_KEPT);
  return { changed: true, days: n, from: before, to: after, ...(!target && asked > n ? { clipped: asked } : {}) };
}

// A player's line of play: it counts toward the pace.
export function noteCalendarLine(cal) {
  if (cal?.since) cal.since.lines += 1;
}

// What is still to pass before the date may move on again: `minMinutes` of real time and `minLines` player lines since
// it last moved. {ok: true}, or {ok: false, minutes, lines, wait: "12 more min and 5 more player lines"}. A date that
// has not moved since the pace was kept has nothing to wait for.
export function calendarPace(cal, { now = Date.now(), minMinutes = 0, minLines = 0 } = {}) {
  const s = cal?.since;
  if (!s) return { ok: true };
  const minutes = Math.max(0, Math.ceil((s.at + Math.max(0, minMinutes) * 60000 - now) / 60000));
  const lines = Math.max(0, minLines - s.lines);
  if (!minutes && !lines) return { ok: true };
  return { ok: false, minutes, lines, wait: [minutes ? `${minutes} more min` : "", lines ? `${lines} more player line${lines === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") };
}

// The pace line of the GM's Calendar section. Only two states (may move on now / not yet), so the section stays
// the same from turn to turn and the prompt cache holds.
function paceLine(cal, pace, now) {
  if (!pace || !cal.date) return "";
  const { minMinutes = 0, minLines = 0, maxDays = 0 } = pace;
  const most = maxDays ? `at most ${maxDays} day${maxDays === 1 ? "" : "s"} at once` : "";
  if (!minMinutes && !minLines) return most ? `Pace: the date moves on ${most}.` : "";
  return calendarPace(cal, { now, minMinutes, minLines }).ok
    ? `Pace: the date may move on now${most ? `, ${most}` : ""}; play the day out rather than skip ahead.`
    : `Pace: the date moved on only recently and may not move on again yet. Keep play within the current day: move only the time of day${most ? `; later, ${most}` : ""}.`;
}

// The planner's routine for the current date (null clears it). Returns the stored routine.
export function setRoutine(cal, { text, upcoming = [] } = {}) {
  cal.routine = routineState({ text, upcoming, date: cal.date });
  return cal.routine;
}

// "Everyday life now: … Coming up: …", marked with the date it was set for once the calendar has moved on.
export function describeRoutine(cal) {
  const r = cal?.routine;
  if (!r) return "";
  const stale = r.date && r.date !== cal.date ? ` (as of ${dateLabel(r.date)})` : "";
  return `Everyday life now${stale}: ${r.text}${r.upcoming.length ? ` Coming up: ${r.upcoming.map((u) => `${u.what}${u.when ? ` (${u.when})` : ""}`).join("; ")}.` : ""}`;
}

// The GM's section (part C): today, everyday life, the pace ({minMinutes, minLines, maxDays}; none when not given),
// and the last few changes.
export function renderCalendar(cal, { pace = null, now = Date.now() } = {}) {
  const recent = cal.log.slice(-3).map((e) => `- ${e.from || "(no date)"} → ${e.to}${e.days ? ` (+${e.days} d)` : ""}, by ${changedBy(e.by)}${e.why ? `: ${e.why}` : ""}`);
  return [
    "## Calendar (the story's date, YYYY-MM-DD; keep to it: weekdays, seasons, how long ago things happened. Move it on with date when time passes; it never runs backwards)",
    `Today in the story: ${cal.date ? describeCalendar(cal) : `no date set yet (the story planner chooses the first one)${cal.time ? `; time of day: ${cal.time}` : ""}`}`,
    ...(cal.routine ? [describeRoutine(cal)] : []),
    ...(paceLine(cal, pace, now) ? [paceLine(cal, pace, now)] : []),
    ...(recent.length ? ["Latest changes:", ...recent] : []),
  ].join("\n");
}
