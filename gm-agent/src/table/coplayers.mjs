// coplayers: table is the explicit runtime context supplied by Table; no service singleton.
import { coplayerLog } from "../context/coplayerContext.mjs";
import { estimateTokens, CHUNK_LINES } from "../memory.mjs";
import { recall } from "../context/recall.mjs";
import { investigatorsFor } from "../context/profiles.mjs";
import { coplayerTurn } from "../coplayer.mjs";
import { playerRules } from "../pbta.mjs";
import { renderThread } from "../casual.mjs";
import { renderCorrectionsFor } from "../wishes.mjs";
import { renderImpulse } from "../planner.mjs";
import { describeCalendar, describeRoutine } from "../calendar.mjs";
import { renderBondsFor } from "../bonds.mjs";
import { impression } from "../context/traits.mjs";

export async function coplayerAct(table, windowId, coplayer, spotlight, { side = false, spark = false, whistle = false, gentle = false, attentionNote = "", dailyNote = "" } = {}) {
    const me = coplayer.characterId;
    const hidden = table.hiddenLines();
    // Everything this co-player witnessed (its seats, its timeline), from the local copy of the chat.
    const messages = [];
    for (const w of new Set(coplayer.seats.map((s) => s.windowId))) messages.push(...table.history.lines(w));
    const witnessed = coplayerLog(coplayer, messages.filter((m) => !hidden.has(m.id)), Infinity).filter((m) => !(m.character_id && table.isPc(m.character_id) && table.timelines.timelineAt(m.character_id, m.seq).id !== table.timelines.timelineAt(me, m.seq).id));
    // Since its last memory chapter, within its budget (compaction catches up beside the turn).
    const recallBudget = Math.min(table.cfg.recallTokens ?? 1200, Math.floor(table.memory.coplayerBudget * 0.05));
    let log = table.memory.coplayerRaw(coplayer, witnessed);
    while (log.length > CHUNK_LINES && estimateTokens(log.map((m) => table.renderForCoplayer(m)).join("\n")) > table.memory.coplayerBudget - recallBudget) log = log.slice(CHUNK_LINES);
    const included = new Set(log.map((m) => m.seq));
    const recalled = recall(witnessed.slice(-6).map((m) => m.content).join("\n"),
      witnessed.filter((m) => !included.has(m.seq)).map((m) => ({ match: m.content, text: table.renderForCoplayer(m), source: table.renderForCoplayer({ ...m, content: "", dice: null }) + " " })),
      recallBudget, { heading: "RELEVANT EARLIER LINES YOU WITNESSED" });
    const memories = table.memory.coplayerChapters(coplayer).map((c) => `[#${c.fromSeq}–#${c.toSeq}] ${c.text}`);
    const t = table.timelines.of(me);
    const timeline = t ? { name: t.name, narrativeTime: t.narrativeTime, location: t.location } : null;
    const card = await table.card(me);
    const pbta = table.pbta && playerRules(table.pbta.pack, card?.pbta?.book);
    let move;
    try {
      const companions = investigatorsFor(table.characters, table.roster, { except: me });
      const phone = table.casualOn() ? renderThread(table.store.phoneOf(me, 12), (id) => table.nameOf(id)) : "";
      const known = table.knownTo(me, witnessed);
      if ((spark || whistle || gentle) && (table.sparkCancelled() || table.overBudget())) return 0;
      move = await coplayerTurn(table.llm, { language: table.language, coplayer, card, pbta, profile: table.profile, attrs: table.attrs.get(me) ?? {}, companions, withYou: table.cfg.timelineAuto ? t.members.filter((id) => id !== me) : null, log, memories, recalled, spotlight, timeline, side, world: table.improv.on ? table.improv.world : "", improv: table.improv.on, casual: table.casualOn(), phone, impulse: renderImpulse(table.impulseFor(me)),
        spark, whistle, gentle, attentionNote, daily: table.dailyOn(), dailyNote: [dailyNote, table.passiveNote(windowId)].filter(Boolean).join("\n"), corrections: renderCorrectionsFor(table.planner.table, coplayer.name),
        ...(table.calendarOn() ? { today: describeCalendar(table.calendar, { time: t?.narrativeTime || table.calendar.time }), routine: describeRoutine(table.calendar), timePassed: table.timePassedFor(me, witnessed) } : {}), met: table.metBy(known.met), bonds: renderBondsFor(table.bonds, me, known.all, (id) => table.nameOf(id)) });
    } catch (e) { table.log(`co-player ${coplayer.name}: ${e.message}`); return 0; }
    if ((spark || whistle || gentle) && (table.sparkCancelled() || table.overBudget() || !["pass", "speak"].includes(move.action))) return 0;
    if (!spark && !whistle) table.memory.maintainCoplayer(coplayer, witnessed, (m) => table.renderForCoplayer(m));
    if (move.action === "text") {
      const to = table.characterByName(move.to);
      // To a companion co-player or an NPC: the phone log, where they answer in their own time.
      if (to && to.id !== me && (table.roster.isCoplayer(to.id) || table.roster.isNpc(to.id))) return table.aiText(me, to.id, move.text);
      // To a player character: it arrives in their phone at once.
      if (!to || !table.isPc(to.id) || !table.casual.phones[to.id]) return 0;
      table.store.addPhone({ windowId: table.casual.phones[to.id], from: me, to: to.id, text: move.text, at: table.now() });
      table.casual.last[to.id] = me;
      table.save();
      return table.post(table.casual.phones[to.id], { content: move.text, kind: "ic", character_id: me }, { count: false });
    }
    if (move.action === "speak") {
      const n = await table.post(windowId, { content: move.text, kind: move.kind, character_id: me });
      const turn = table.turnScope.getStore();
      if (n && move.kind === "ic" && turn && table.dailyOn()) for (const name of move.needsReplyFrom ?? []) {
        const target = (table.scene(windowId)?.members ?? []).find(id => id !== me && table.isPassive(id) && table.nameOf(id) === name);
        if (target) (turn.standinRequests ??= new Map()).set(target, { from: coplayer.name, text: move.text });
      }
      return n;
    }
    if (move.action === "roll" && table.pbta) {
      const [, moveId, modifier] = move.command.split(" ");
      if (/^[.。]/.test(move.text.trim())) return 0;
      const cue = witnessed.findLast(m => m.chat_window_id === windowId && m.visibility === "window" && m.character_id !== me);
      if (!cue) return table.post(windowId, { content: move.text, kind: "ic", character_id: me });
      const intent = await table.api.pbtaRuling(table.channelId, windowId, {
        op: "declare", source_id: cue.id, text: move.text, character_id: me,
        move_id: moveId, modifier: Number(modifier ?? 0), revision: table.pbta.revision,
      });
      table.noteLine(intent);
      // A retry must finish the originally declared move, even if the model now suggests another.
      const result = await table.api.pbtaRuling(table.channelId, windowId, {
        op: "move", character_id: me, source_id: intent.id, ...intent.declared_move,
      });
      table.noteLine(result);
      return 2;
    }
    if (move.action === "roll") {
      let n = 0;
      if (move.text) n += await table.post(windowId, { content: move.text, kind: "ic", character_id: me });
      return n + (await table.post(windowId, { content: move.command, kind: "ic", character_id: me }));
    }
    return 0;
  }

export function knownTo(table, me, witnessed) {
    const npcs = new Set(table.roster.npcs.map((n) => n.characterId));
    const met = [...new Set(witnessed.filter((m) => m.character_id && npcs.has(m.character_id)).map((m) => m.character_id).reverse())].reverse().slice(-12);
    return { met, all: new Set([...investigatorsFor(table.characters, table.roster).map((c) => c.id), ...met]) };
  }

export function metBy(table, ids) {
    const lines = ids.map((id) => { const c = table.characters.find((x) => x.id === id); return c ? `- ${c.name}${impression(c.role_card) ? ` ${impression(c.role_card)}` : ""}` : ""; }).filter(Boolean);
    return lines.length ? `PEOPLE YOU HAVE MET (what anyone would notice about them):\n${lines.join("\n")}` : "";
  }

export function timePassedFor(table, me, witnessed) {
    const own = witnessed.filter((m) => m.character_id === me).at(-1);
    if (!own) return "";
    const changes = table.calendar.log.filter((e) => e.seq >= own.seq && e.days > 0);
    if (!changes.length) return "";
    const days = changes.reduce((n, e) => n + e.days, 0);
    return `TIME HAS PASSED since you last spoke: ${days} day(s), ${changes[0].from || "(no date)"} → ${changes.at(-1).to}.`;
  }
