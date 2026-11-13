// actions: table is the explicit runtime context supplied by Table; no service singleton.
import { recall } from "../context/recall.mjs";
import { investigatorsFor } from "../context/profiles.mjs";
import { prepareActor } from "../pbta.mjs";
import { generateNpc, saveCharacter } from "../roles/cardgen.mjs";
import { MAIN } from "../timelines.mjs";
import { addTruth } from "../improv.mjs";
import { calendarPace, describeCalendar } from "../calendar.mjs";
import { norm } from "./shared.mjs";

export async function act(table, windowId, a, ctx, { mode, parent = mode, scope = null, evidenceThrough } = {}) {
    table.generation.signal.throwIfAborted();
    if (mode === "spark" && !["narrate", "npc", "note", "text"].includes(a.type)) return 0;
    switch (a.type) {
      case "question_done":
        if (table.dailyOn()) { table.daily.questions = table.daily.questions.filter(q => q.id !== a.id); table.save(); }
        return 0;
      case "time_skip": {
        const scene = table.scene(windowId);
        const time = typeof a.time === "string" && a.time.trim().slice(0, 120);
        if (!scene || !time || scene.narrativeTime === time) return 0;
        if (!await table.readClock(windowId, time)) return 0;
        table.timelines.relocate(scene.id, { narrativeTime: time });
        table.save();
        return table.postHandoff(windowId, time, evidenceThrough);
      }
      case "narrate": return table.post(windowId, { content: a.text, kind: "narration" });
      case "note": return table.post(windowId, { content: a.text, kind: "narration", visibility: "gm_only" });
      case "truth":
        if (table.improv.on && addTruth(table.improv, a.text)) { table.log(`hidden truth recorded: ${a.text.slice(0, 100)}`); table.save(); table.declare(a.text, true); }
        return 0;
      case "world_change": table.declare(a.text, a.secret === true || a.secret === "true"); return 0;
      case "planner_note": return table.plannerNote(a);
      case "date": {
        if (!table.calendarOn()) return 0;
        // While the planner is on, the story's first date is its to choose (from the era, the world and its plots).
        const first = !table.calendar.date && a.date && table.plannerMode() !== "off";
        if (first) table.log(`calendar: the GM's first date "${a.date}" left to the story planner`);
        if (a.time && !await table.readClock(windowId, a.time, { newDay: Number(a.advance_days) > 0 || a.date > table.calendar.date, apply: false })) a = { ...a, time: undefined };
        const change = table.moveCalendar({ days: a.advance_days, date: first ? undefined : a.date, time: a.time, why: a.reason ?? a.text, by: "keeper" });
        const held = await table.calendarHeld(windowId, change);
        if (change.changed && change.from && change.to) {
          const scene = table.scene(windowId);
          if (scene && a.time) { table.timelines.relocate(scene.id, { narrativeTime: a.time }); table.save(); }
          return held + await table.postHandoff(windowId, change.to, evidenceThrough);
        }
        return held;
      }
      case "bond": table.recordBond(a, "keeper"); return 0;
      case "dice": return table.gmDice(windowId, a);
      case "text": return table.casualOn() ? table.sendText(a) : 0;
      case "npc":
      case "new_npc": {
        const who = table.characterByName(a.name);
        if (table.roster.coplayerByName(a.name) || who?.kind === "pc") { table.log(`the GM tried to voice ${a.name}, a ${table.roster.isCoplayer(who?.id) || !who ? "co-player" : "player character"}; skipped`); return 0; }
        let npc = table.roster.npcByName(a.name);
        if (!npc && a.type === "npc") {
          // Not posted: a misspelled or invented name must not create a character by accident. The note tells the next
          // round how to bring a new person in.
          table.log(`the GM named an unknown NPC (${a.name}); skipped instead of creating a character`);
          await table.post(windowId, { content: `Not posted: ${a.name} is not in the cast, and npc only voices someone in it. If this is a new person who passes the three tests for new people, introduce them with new_npc (name, brief, first line); otherwise use a cast member or keep them unnamed in narration.`, kind: "narration", visibility: "gm_only" }, { count: false });
          return 0;
        }
        if (!npc) npc = await table.createNpc(a.name, a.brief, ctx.text);
        if (!npc || !a.text) return 0;
        if (table.pbta && a.move_id) {
          const sheet = table.characters.find(c => c.id === npc.characterId);
          const move = table.pbta.pack.moves.find(m => m.id === a.move_id);
          if (!sheet || !move || /^[.。]/.test(a.text.trim())) return 0;
          await prepareActor(table.api, table.llm, table.channelId, {
            rules: table.pbta, language: table.language, world: table.improv.world, existing: sheet,
            npc: true, requiredBook: move.book,
          });
          const line = await table.api.postMessage(table.channelId, windowId, {
            content: a.text, kind: "ic", character_id: npc.characterId,
          });
          table.noteLine(line);
          const result = await table.api.pbtaRuling(table.channelId, windowId, {
            op: "move", source_id: line.id, character_id: npc.characterId, move_id: move.id,
            modifier: a.modifier ?? 0, revision: table.pbta.revision,
          });
          table.noteLine(result);
          return 2;
        }
        return table.post(windowId, { content: a.text, kind: "ic", character_id: npc.characterId });
      }
      case "illustrate": return table.illustrateMoment(windowId, a);
      case "event_done": return table.eventDone(windowId, a);
      case "whisper": {
        const target = table.characterByName(a.to);
        if (!target) return table.post(windowId, { content: `(whisper for ${a.to}) ${a.text}`, kind: "narration", visibility: "gm_only" });
        return table.post(windowId, { content: a.text, kind: "narration", visibility: "whisper", whisper_to: [target.id] });
      }
      case "ask":
      case "mark":
      case "move": {
        if (!table.pbta) return 0;
        const target = table.characters.find(c => c.id === a.character_id);
        if (!target || (scope && target.kind === "pc" && !scope.has(target.id))) return 0;
        if (a.type === "move" && target.kind === "npc" && !target.role_card?.pbta?.book) {
          const move = table.pbta.pack.moves.find(m => m.id === a.move_id);
          if (!move) return 0;
          await prepareActor(table.api, table.llm, table.channelId, {
            rules: table.pbta, language: table.language, world: table.improv.world, existing: target,
            npc: true, requiredBook: move.book,
          });
        }
        const result = await table.api.pbtaRuling(table.channelId, windowId, { ...a, op: a.type, revision: table.pbta.revision });
        table.noteLine(result);
        table.cards.delete(target.id);
        return 1;
      }
      case "request_roll": return table.pbta ? 0 : table.requestRoll(windowId, a, scope);
      case "split": return table.cfg.timelineAuto ? 0 : table.legacySplit(windowId, a);
      case "rejoin": return table.cfg.timelineAuto ? 0 : table.legacyRejoin(a);
      case "timeline": {
        const t = table.timelines.byName(a.timeline) ?? table.timelines.main();
        if (a.narrative_time && !await table.readClock(table.windowOf(t), a.narrative_time)) a = { ...a, narrative_time: undefined };
        const changed = a.narrative_time && a.narrative_time !== t.narrativeTime;
        table.updateTimeline(a);
        const w = table.windowOf(t);
        return changed && w ? table.postHandoff(w, t.narrativeTime, evidenceThrough) : 0;
      }
      case "advance_scenario":
      case "enter_scenario": return table.changeScenario(windowId, a, mode, parent, evidenceThrough);
      default: return 0;
    }
  }

export async function requestRoll(table, windowId, a, scope = null) {
    const command = String(a.command ?? "").trim();
    const target = table.characterByName(a.who);
    if (!table.profile.roll.test(command) || !target) return a.text ? table.post(windowId, { content: a.text, kind: "narration" }) : 0;
    // Only someone in this scene (or a player writing here from elsewhere) can be asked to roll for it.
    if (scope && (table.isPc(target.id) || table.roster.isCoplayer(target.id)) && !scope.has(target.id)) {
      return table.post(windowId, { content: `Roll request for ${target.name} not posted: they are not in this scene.`, kind: "narration", visibility: "gm_only" });
    }
    let n = 0;
    if (table.roster.isCoplayer(target.id) || table.roster.isNpc(target.id)) {
      // The client rolls for the characters it plays; the platform rolls against their own sheets.
      if (a.text) n += await table.post(windowId, { content: a.text, kind: "narration" });
      n += await table.post(windowId, { content: command, kind: "ic", character_id: target.id });
      return n;
    }
    // A player's roll is asked for, never made, and asked in the player's own scene.
    const home = table.isPc(target.id) ? table.windowOf(table.timelines.of(target.id)) : null;
    return table.post(home ?? windowId, { content: `${a.text ? `${a.text}\n` : ""}→ ${target.name}: ${command}`, kind: "narration" });
  }

export async function gmDice(table, windowId, a) {
    const command = String(a.command ?? "").trim();
    if (!table.profile.gmDice?.test(command)) { table.log(`dice "${command}" skipped: not a command the GM may run`); return 0; }
    let n = 0;
    if (a.text) n += await table.post(windowId, { content: a.text, kind: "narration" });
    n += await table.post(windowId, { content: command, kind: "narration" });
    table.initiative.delete(windowId);
    return n;
  }

export async function scenarioVerdict(table, windowId, mode, parent = mode) {
    if (mode === "manual") return { ok: true };
    if (!table.cfg.scenarioAuto) return { ok: false, reason: "automatic scenario changes are off" };
    if (windowId !== table.primaryWindowId()) return { ok: false, reason: table.forks ? "only from the primary scene" : "only from the Main Chat" };
    if (!["human", "followup"].includes(mode) || !["human", "relay"].includes(parent)) return { ok: false, reason: "only right after a player's or co-player's line, never in an autonomous turn" };
    const short = table.timelines.active().find((t) => t.id !== MAIN && t.span !== "long");
    if (short) return { ok: false, reason: `the party is briefly split ("${short.name}"): bring them together first` };
    const minutes = (table.now() - (table.scenario?.since ?? 0)) / 60000;
    // The story planner's "move on" lifts the pace guard (not the other rules).
    if (table.planner.arc?.verdict?.moveOn) return { ok: true, planner: true };
    if (minutes < table.cfg.scenarioMinMinutes) return { ok: false, reason: `the current scenario began ${Math.floor(minutes)} min ago (at least ${table.cfg.scenarioMinMinutes})` };
    const scenes = (await table.api.scenes(table.channelId).catch(() => [])) ?? [];
    const cur = scenes.find((s) => s.id === table.channel.current_scene_id || s.id === table.scenario?.id);
    const events = Number(cur?.event_count ?? 0);
    if (cur && events < table.cfg.scenarioMinLines) return { ok: false, reason: `only ${events} lines in the current scenario (at least ${table.cfg.scenarioMinLines})` };
    return { ok: true, scenes };
  }

export async function changeScenario(table, windowId, a, mode, parent = mode, evidenceThrough) {
    const v = await table.scenarioVerdict(windowId, mode, parent);
    if (!v.ok) return table.post(windowId, { content: `Scenario change refused: ${v.reason}.`, kind: "narration", visibility: "gm_only" });
    // A scenario change that jumps days ahead keeps to the calendar's pace: refused whole, so the new scene's time and
    // the date never disagree.
    if (table.calendarOn() && Number(a.advance_days) > 0 && mode !== "manual") {
      const { minMinutes, minLines } = table.calendarPaceCfg();
      const p = calendarPace(table.calendar, { now: table.now(), minMinutes, minLines });
      if (!p.ok) return table.post(windowId, { content: `Scenario change refused: the date moved on too recently to jump ahead again (${p.wait} first). Change the scenario within the same day (advance_days 0), or let the day play out.`, kind: "narration", visibility: "gm_only" });
    }
    if (a.narrative_time && !await table.readClock(windowId, a.narrative_time, { newDay: Number(a.advance_days) > 0, apply: false })) a = { ...a, narrative_time: undefined };
    // The scenario that ends here, for its pictures: the timelines a player is in, read before anything moves.
    const ending = table.endingScenario(v.scenes);
    try {
      let res;
      if (a.type === "enter_scenario") {
        const scenes = v.scenes ?? (await table.api.scenes(table.channelId));
        const target = scenes.find((s) => s.status === "active" && s.id !== table.channel.current_scene_id && (norm(s.title) === norm(a.scenario) || s.id === a.scenario));
        if (!target) return table.post(windowId, { content: `Scenario change refused: no prepared scenario "${a.scenario}".`, kind: "narration", visibility: "gm_only" });
        res = await table.api.enterScenario(table.channelId, target.id);
      } else {
        res = await table.api.advanceScenario(table.channelId, { title: a.title ?? "", location: a.location ?? "", narrative_time: a.narrative_time ?? "" });
      }
      const scene = res?.scene;
      table.channel.current_scene_id = scene?.id ?? table.channel.current_scene_id;
      table.scenario = { id: table.channel.current_scene_id, since: table.now(), fromSeq: table.lastSeq + 1 };
      const oldTime = table.timelines.main().narrativeTime;
      table.timelines.relocate(MAIN, { location: scene?.location || a.location, narrativeTime: scene?.narrative_time || a.narrative_time });
      const moved = Number(a.advance_days) > 0 && table.calendarOn() ? table.moveCalendar({ days: a.advance_days, why: `scenario: ${scene?.title ?? a.title ?? a.scenario ?? ""}`, by: "keeper" }) : null;
      if (a.narrative_time) await table.readClock(windowId, a.narrative_time);
      const held = moved ? await table.calendarHeld(windowId, moved) : 0;
      table.beatClosed();   // the planner's "move on" is spent; the next plan opens the next beat
      table.save();
      table.log(`scenario: ${scene?.title ?? a.title ?? a.scenario} (${a.reason ?? "the story moved on"})`);
      // Outside this turn: a recall that rolls the turn back keeps the scenario change, and so its pictures.
      const pictures = await ending;
      table.pictureChain = table.pictureChain.then(() => table.turnScope.exit(() => table.generation.tasks.exit(() => table.illustrateScenario(pictures)))).catch((e) => table.log(`scenario pictures: ${e.message}`));
      table.illustrating = table.pictureChain.then(() => table.draining);
      const time = table.timelines.main().narrativeTime;
      const advancedDay = Boolean(moved?.changed);
      if ((time && time !== oldTime) || advancedDay) return held + await table.postHandoff(windowId, advancedDay ? describeCalendar(table.calendar, { time }) : time, evidenceThrough);
      return held;
    } catch (e) {
      return table.post(windowId, { content: `Scenario change failed: ${e.message}`, kind: "narration", visibility: "gm_only" });
    }
  }

export async function createNpc(table, name, brief, gmContext) {
    if (!String(name ?? "").trim()) return null;
    let saved;
    if (table.pbta) {
      saved = await table.api.createCharacter(table.channelId, { kind: "npc", name, description: brief || name });
    } else {
      const generated = await generateNpc(table.llm, { language: table.language, era: table.channel.era, rules: table.rules, name, brief, gmContext: gmContext.slice(-6000), profile: table.profile, pointsMode: Boolean(table.channel.point_buy), log: table.log });
      generated.name = name;
      generated.brief = brief || generated.persona;
      saved = await saveCharacter(table.api, table.channelId, generated, { kind: "npc", rules: table.rules, llm: table.llm, language: table.language, pointsMode: Boolean(table.channel.point_buy), profile: table.profile, level: 1 });
    }
    const entry = { characterId: saved.id, name: saved.name, brief: brief || saved.persona };
    table.roster.npcs.push(entry);
    table.save();
    table.log(`new NPC: ${saved.name}`);
    await table.refresh();
    return entry;
  }

export function characterByName(table, name) {
    const n = norm(name);
    return table.characters.find((c) => norm(c.name) === n) ?? table.characters.find((c) => n && norm(c.name).split(/\s+/)[0] === n.split(/\s+/)[0]);
  }

export function investigatorByName(table, name) {
    const n = norm(name);
    const inv = investigatorsFor(table.characters, table.roster);
    const exact = inv.find((c) => norm(c.name) === n);
    if (exact) return exact.id;
    const first = inv.filter((c) => n && norm(c.name).split(/\s+/)[0] === n.split(/\s+/)[0]);
    return first.length === 1 ? first[0].id : null;
  }

export async function card(table, characterId) {
    if (!table.cards.has(characterId)) {
      const space = await table.api.characterSpace(table.channelId, characterId).catch(() => null);
      table.cards.set(characterId, space?.character?.role_card ?? null);
      table.attrs.set(characterId, space?.attrs && typeof space.attrs === "object" ? space.attrs : {});
    }
    return table.cards.get(characterId);
  }

// Posts one line and counts it (1) after the pause between lines; 0 when nothing was posted, or with `count: false`.
export async function post(table, windowId, body, { count = true, allowPaused = false } = {}) {
    const m = await sendLine(table, windowId, body, { allowPaused });
    if (!m || !count) return 0;
    await table.sleep(table.cfg.postDelayMs);
    return 1;
  }

// Posts one line and returns the platform's message, or null when nothing was posted (hosting paused, a spark's line
// limit, PbtA dice text, a refused request). No pause after it. Use the returned message rather than `lastPosted`:
// phone texts are delivered on their own timer and may be posted in between.
export async function sendLine(table, windowId, body, { allowPaused = false } = {}) {
    if (!allowPaused && table.generation.signal.aborted) return null;
    const spark = table.turnScope.getStore();
    if (spark?.mode === "spark" && (table.sparkCancelled() || spark.dailyPosted >= spark.lineLimit)) return null;
    if (table.pbta && /^[.。][a-z]/i.test(String(body.content).trim())) return null;
    try {
      const m = await table.api.postMessage(table.channelId, windowId, { visibility: "window", ...body });
      if (spark?.mode === "spark") spark.dailyPosted++;
      table.botMessageIds.add(m.id);
      if (table.botMessageIds.size > 2000) table.botMessageIds.delete(table.botMessageIds.values().next().value);
      const turn = table.turnScope.getStore();
      if (turn?.running) turn.posted.push({ id: m.id, seq: m.seq, kind: m.kind, windowId });
      table.lastPosted = m;
      table.noteLine(m);
      table.noteArt(m);
      if (table.cfg.verbose) table.log(`posted ${body.kind}${body.visibility && body.visibility !== "window" ? `/${body.visibility}` : ""} in "${table.windowName(windowId)}": ${body.content.slice(0, 100)}`);
      return m;
    } catch (e) {
      table.log(`post failed (${e.code || e.status}): ${e.message}`);
      return null;
    }
  }
