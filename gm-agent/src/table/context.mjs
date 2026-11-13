// context: table is the explicit runtime context supplied by Table; no service singleton.
import { renderLine } from "../context/coplayerContext.mjs";
import { isPlayerCharacter } from "../roles/roster.mjs";
import { MAIN } from "../timelines.mjs";
import { renderTableNotes } from "../wishes.mjs";
import { renderCalendar } from "../calendar.mjs";
import { renderBonds } from "../bonds.mjs";

export function mainWindow(table) { return table.windows.find((w) => w.kind === "main") ?? table.windows[0]; }

export function windowName(table, id) { return table.windows.find((w) => w.id === id)?.name ?? "another window"; }

export function nameOf(table, id) { return table.characters.find((c) => c.id === id)?.name ?? id; }

export function isPc(table, id) { return isPlayerCharacter(table.characters.find((c) => c.id === id), table.roster); }

export function userOf(table, id) { return table.characters.find((c) => c.id === id)?.user_id ?? null; }

export function scene(table, windowId) {
    if (windowId === table.mainWindow()?.id) return table.timelines.main().windowId ? null : table.timelines.main();
    return table.timelines.activeOfWindow(windowId);
  }

export function windowOf(table, timeline) { return timeline?.windowId ?? (timeline?.id === MAIN ? table.mainWindow()?.id : null); }

export function primaryWindowId(table) { return table.windowOf(table.timelines.main()); }

export function sceneHistory(table, windowId) {
    const seen = new Set(), lines = [];
    let id = windowId, cutoff = Infinity;
    while (id && !seen.has(id)) {
      seen.add(id);
      lines.push(...table.history.lines(id).filter(m => m.seq <= cutoff));
      const win = table.windows.find(w => w.id === id);
      cutoff = Math.min(cutoff, win?.fork_seq ?? 0);
      id = win?.fork_parent_id;
    }
    return lines.sort((a,b) => a.seq-b.seq);
  }

export function state(table, windowId) {
    if (!table.windowState.has(windowId)) table.windowState.set(windowId, { lastLineAt: 0, lastHumanAt: 0, lastTurnAt: 0, lastTypingAt: 0, quietTurns: 0 });
    return table.windowState.get(windowId);
  }

export function isHuman(table, m) { return m.author_id !== table.me?.id && !table.botMessageIds.has(m.id); }

export function noteSeq(table, windowId, seq) {
    if (!Number.isFinite(seq)) return;
    table.windowSeq.set(windowId, Math.max(table.windowSeq.get(windowId) ?? 0, seq));
    table.lastSeq = Math.max(table.lastSeq, seq);
  }

export async function observeHistory(table, { controlsOnly = false } = {}) {
    const after = controlsOnly ? table.lastPlayerSeq : 0;
    const controls = [];
    for (const w of table.windows) {
      await table.history.sync(w.id).catch((e) => table.log(`history ${w.name}: ${e.message}`));
      const lines = table.history.lines(w.id, { after });
      if (!controlsOnly) for (const m of lines.slice(-20)) table.noteLine(m);
      for (const m of lines) {
        if (table.pauseCommand(m)) table.pauseLines.add(m.id);
        if (table.noteArt(m)) continue;
        if (m.seq > table.lastPlayerSeq && table.playerSpeech(m)) controls.push(m);
      }
    }
    for (const m of controls.sort((a, b) => a.seq - b.seq)) table.updatePause(m, { historical: true });
  }

export function calendarOn(table) { return Boolean(table.casual.on); }

export function calendarPaceCfg(table) { if (table.dailyOn()) return { minMinutes: table.cfg.daily.min_day_minutes, minLines: 0, maxDays: 1 }; return { minMinutes: table.cfg.calendarMinMinutes ?? 0, minLines: table.cfg.calendarMinLines ?? 0, maxDays: table.cfg.calendarMaxDays ?? 0 }; }

export async function buildGm(table, windowId, extra = {}) {
    const initiative = await table.initiativeOf(windowId);
    return table.gm.build({ windowId, initiative, roster: table.roster, characters: table.characters, windows: table.windows, timelines: table.timelines, sceneOf: (w) => table.scene(w), improv: table.improv, hide: table.hiddenLines(), awayOf: (id) => table.awayOf(id), daily: table.dailyOn() ? { questions: table.daily.questions } : null, calendar: table.calendarOn() ? renderCalendar(table.calendar, { pace: table.calendarPaceCfg(), now: table.now() }) : "", bonds: renderBonds(table.bonds, (id) => table.nameOf(id)), table: renderTableNotes(table.planner.table), ...extra });
  }

export function renderForGm(table, m) { return renderLine({ ...m, whisper_to_names: (m.whisper_to ?? []).map((id) => table.nameOf(id)) }, { markVisibility: true, timeline: table.timelines.ofLine(m).name, gm: table.profile?.vocab.gm }); }

export function renderForCoplayer(table, m) { return renderLine(m, { gm: table.profile?.vocab.gm }); }

export async function initiativeOf(table, windowId) {
    if (table.profile?.id !== "dnd2024" || !windowId) return null;
    if (!table.initiative.has(windowId)) table.initiative.set(windowId, await table.api.initiative(table.channelId, windowId).catch(() => null));
    return table.initiative.get(windowId);
  }

export function awayOf(table, id) {
    if (table.dailyOn()) return table.isPassive(id) ? Math.max(1, table.now() - (table.daily.lastSceneLineBy[id] ?? table.daily.lastSceneLineAt)) : null;
    if (!table.isPc(id)) return null;
    const last = table.lastLineBy.get(id);
    const gap = table.now() - (last ?? 0);
    return last !== undefined && gap > table.cfg.autonomyIdleMinutes * 60000 ? gap : null;
  }

export async function memoryIdle(table) { await table.memory.idle(); }
