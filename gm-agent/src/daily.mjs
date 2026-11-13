// Daily-life rules without platform or model calls. All real timestamps are milliseconds;
// story instants use a campaign date and a minute since midnight.
import { parseIso, parseClock, formatClock } from './calendar.mjs';
export const DAILY_DEFAULTS = Object.freeze({ enabled: false, day_hours: 17, min_day_minutes: 180, silence_minutes: 120, night_start: '23:00', night_end: '07:00', pause_days: 7, sparks_per_day: 8, spark_max_lines: 6, max_lag_minutes: 120, pc_sparks: false, passive_minutes: 30, summaries: true });
export const dailyConfig = cfg => ({ ...DAILY_DEFAULTS, ...(cfg?.daily ?? cfg ?? {}) });
export const DAY = 86400000;
export function dailyState(value, now = Date.now()) {
  const s = value && typeof value === 'object' ? value : {};
  return { lastSceneLineAt: now, lastHumanAt: now, lastSceneLineBy: {}, anchor: null, frozen: null, dayStartSeq: 0, pendingDays: [], dayPlan: null, planAttempt: null, sparks: [], nextSparkAt: 0, lastSparker: null, topics: {}, passive: {}, passiveToday: [], rules: {}, questions: [], week: {}, ...s };
}
export function modeOf(s, now, cfg) {
  const c = dailyConfig(cfg);
  if (now - s.lastHumanAt >= c.pause_days * DAY) return 'paused';
  return now - s.lastSceneLineAt >= c.silence_minutes * 60000 ? 'unattended' : 'attended';
}
export function addStoryDays(date, days) {
  const d = parseIso(date);
  if (!d) return date;
  d.setUTCDate(d.getUTCDate() + days);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function instantNumber({ date, minute }) { return (parseIso(date)?.getTime() ?? 0) / 60000 + minute; }
export function timetableAt(anchor, now, dayHours = 17) {
  const elapsed = Math.max(0, now - anchor.realAt);
  const minutes = anchor.minute + Math.floor(elapsed * 1440 / (dayHours * 3600000));
  const daysPassed = Math.floor(minutes / 1440);
  return { date: addStoryDays(anchor.date, daysPassed), minute: minutes % 1440, daysPassed };
}
export function isNight(minute, cfg) {
  const c = dailyConfig(cfg), start = parseClock(c.night_start), end = parseClock(c.night_end);
  return start === end ? false : start > end ? minute >= start || minute < end : minute >= start && minute < end;
}
export function nightEnd(instant, cfg) {
  if (!isNight(instant.minute, cfg)) return { ...instant };
  const end = parseClock(dailyConfig(cfg).night_end);
  return { date: addStoryDays(instant.date, instant.minute >= end ? 1 : 0), minute: end };
}
export function sparkDue(s, now, cfg, pressure = 'none') {
  const c = dailyConfig(cfg);
  return modeOf(s, now, c) === 'unattended' && !!s.anchor && pressure !== 'spent' && c.sparks_per_day > 0 &&
    !isNight(timetableAt(s.anchor, now, c.day_hours).minute, c) &&
    s.sparks.filter(at => now - at < DAY).length < c.sparks_per_day && now >= s.nextSparkAt;
}
export function nextSparkAt(now, cfg, pressure = 'none', random = Math.random) {
  const c = dailyConfig(cfg), night = (parseClock(c.night_end) - parseClock(c.night_start) + 1440) % 1440;
  return now + DAY * (1 - night / 1440) / Math.max(1, c.sparks_per_day) * (0.75 + random() * 0.5) * (pressure === 'tight' ? 2 : 1);
}
export function pickSpark(candidates, lastSparker, random = Math.random) {
  const choices = candidates.filter(c => c.id !== lastSparker);
  if (!choices.length) return null;
  const windows = [...new Set(choices.map(c => c.windowId))];
  const windowId = windows[Math.min(windows.length - 1, Math.floor(random() * windows.length))];
  const scene = choices.filter(c => c.windowId === windowId);
  return scene[Math.min(scene.length - 1, Math.floor(random() * scene.length))];
}
export function awayCommand(text) {
  const match = String(text ?? '').trim().match(/^\/(away|离开|back|回来)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  if (/^(back|回来)$/i.test(match[1])) return { action: 'back' };
  const rule = (match[2] ?? '').trim().slice(0, 1000);
  return { action: rule.toLowerCase() === 'clear' ? 'clear' : 'away', text: rule };
}
export function threadPermission(thread, owners, { spark = false } = {}) {
  if (spark) return { mayAdvance: false, waiting: owners.map(o => o.name) };
  const blocking = owners.filter(o => !o.expired);
  const absent = blocking.filter(o => o.passive);
  const mayAdvance = !blocking.length || (thread.needs === 'all' ? !absent.length : blocking.some(o => !o.passive));
  return { mayAdvance, waiting: mayAdvance ? [] : absent.map(o => o.name) };
}
export { parseClock, formatClock };
