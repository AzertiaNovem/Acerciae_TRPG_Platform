// social: table is the explicit runtime context supplied by Table; no service singleton.
import { investigatorsFor } from "../context/profiles.mjs";
import { directTurn } from "../director.mjs";
import { coplayerSelf } from "../coplayer.mjs";
import { playerRules } from "../pbta.mjs";
import { hashText, worldMessages } from "../improv.mjs";
import { PHONE_LOG, PHONE_PREFIX, coplayerPhoneReply, dueAt, pairKey, parseAddress, renderThread } from "../casual.mjs";
import { WISH_WINDOW, addToInbox, renderCorrectionsFor } from "../wishes.mjs";
import { renderImpulse } from "../planner.mjs";
import { describeCalendar, describeRoutine } from "../calendar.mjs";
import { renderBondsFor } from "../bonds.mjs";
import { names, chunk, HOUR } from "./shared.mjs";

export function isPhone(table, windowId) { return Boolean(windowId) && Object.values(table.casual.phones).includes(windowId); }

export function phoneOwner(table, windowId) { return Object.keys(table.casual.phones).find((id) => table.casual.phones[id] === windowId) ?? null; }

export function casualOn(table) { return table.casual.on && !table.splitWarning; }

export async function setCasual(table, on) {
    table.casual.on = Boolean(on);
    // A casual game keeps a date: with none yet, the next turn boundary asks the planner to choose the first one.
    if (table.casual.on && !table.calendar.date && table.planner.arc && table.plannerMode() !== "off") table.planner.asked = { why: "casual mode is on: choose the story's first date", at: table.now() };
    table.save();
    table.log(`casual mode ${table.casual.on ? "on" : "off"}${table.casual.on && table.splitWarning ? `, but not here: phones would not be private (${table.splitWarning})` : ""}`);
    if (table.casual.on) await table.ensureTableWindows();
  }

export function isPlannerWindow(table, windowId) { return Boolean(windowId) && windowId === table.planner.window; }

export function isTableWindow(table, windowId) { return table.isPhone(windowId) || table.isPlannerWindow(windowId) || (Boolean(windowId) && windowId === table.casual.log); }

export function plannerWindowWanted(table) { return table.cfg.planner?.wishWindow !== false && table.plannerMode() !== "off"; }

export async function ensureTableWindows(table) {
    if (!table.ready || table.ensuringWindows) return;
    table.ensuringWindows = true;
    try {
      if (table.plannerWindowWanted()) await table.ensurePlannerWindow();
      if (table.casual.on) { await table.ensurePhones(); await table.ensurePhoneLog(); }
    } finally { table.ensuringWindows = false; }
  }

export async function ensurePlannerWindow(table) {
    const { rows } = await table.channelMemberRows();
    if (!rows) return;
    const players = rows.filter((r) => r.role === "player").map((r) => r.id ?? r.user_id).filter(Boolean);
    let w = table.windows.find((x) => x.id === table.planner.window);
    if (!w) {
      w = await table.api.createWindow(table.channelId, { name: WISH_WINDOW, kind: "private", members: players.map((user_id) => ({ user_id })) });
      table.planner.window = w.id;
      table.save();
      table.windows = [...table.windows, w];
      table.log(`planner window: opened "${w.name}"`);
      await table.post(w.id, { content: `🧭 This window is for the story planner, out of character. Tell it where you would like the story to go, or what went against your setting ("Harriet would never leave a friend behind", "there is no magic in this world"). It reads what you write here the next time it plans, answers here, and the GM keeps to it. No scene is played here. Send /pause to pause hosting until the next player message in the channel.${table.cfg.illustrations?.enabled !== false && (table.cfg.illustrations?.requestsPerHour ?? 4) > 0 ? " Send /draw (or /画) and a moment from earlier play to have a picture of it drawn here." : ""}`, kind: "ooc" }, { count: false, allowPaused: true });
      return;
    }
    const seated = new Set((w.members ?? []).map((m) => m.user_id));
    for (const user_id of players.filter((u) => !seated.has(u))) {
      await table.api.addWindowMember(table.channelId, w.id, { user_id });
      table.log(`planner window: seated a new player (${rows.find((r) => (r.id ?? r.user_id) === user_id)?.display_name ?? user_id})`);
    }
  }

export async function ensurePhoneLog(table) {
    if (!table.casualOn() || (table.casual.log && table.windows.some((w) => w.id === table.casual.log))) return;
    const w = await table.api.createWindow(table.channelId, { name: PHONE_LOG, kind: "private", members: [] });
    table.casual.log = w.id;
    table.save();
    table.windows = [...table.windows, w];
    table.log(`casual: opened "${w.name}"`);
    await table.post(w.id, { content: "📒 Texts between co-players and NPCs, for the GM only. Every line is one text: the sender, then → and the recipient.", kind: "narration" }, { count: false, allowPaused: true });
  }

export function onWishLine(table, m) {
    if (!table.isHuman(m) || m.visibility !== "window" || !String(m.content ?? "").trim()) return undefined;
    addToInbox(table.planner.inbox, { seq: m.seq, who: m.author_name || m.character_name || "a player", text: m.content, at: Date.parse(m.created_at) || table.now() });
    table.save();
    return undefined;
  }

export function welcomeNewcomers(table, list) {
    const main = table.primaryWindowId();
    if (!main) return;
    for (const c of list) table.log(`new player: ${c.player_name ?? c.user_id} with ${c.name}`);
    table.schedule(main, { mode: "arrival", delay: table.cfg.debounceMs, arrival: { names: list.map((c) => c.name), ids: list.map(c => c.id), newcomer: true } });
  }

export async function ensurePhones(table) {
    if (!table.casual.on || !table.ready || table.ensuringPhones) return;
    if (table.splitWarning) {
      if (!table.casualRefusedNoted) { table.casualRefusedNoted = true; table.log(`casual mode stays off on this channel: phones would not be private (${table.splitWarning}). Use an isolated channel with one player per group.`); }
      return;
    }
    table.ensuringPhones = true;
    try {
      const users = await table.channelUsers();
      for (const c of table.characters.filter((x) => table.isPc(x.id) && x.user_id && (!users || users.has(x.user_id)))) {
        const known = table.casual.phones[c.id];
        if (known && table.windows.some((w) => w.id === known)) continue;
        const w = await table.api.createWindow(table.channelId, { name: `${PHONE_PREFIX}${c.name}`.slice(0, 80), kind: "private", members: [{ user_id: c.user_id, character_id: c.id }] });
        table.casual.phones[c.id] = w.id;
        table.windows = [...table.windows, w];
        table.save();
        table.log(`casual: opened "${w.name}"`);
        await table.post(w.id, { content: `📱 ${c.name}'s phone. Text anyone in the story: start with @ and their name ("@Name …"). Without @, your message goes to whoever you texted last.`, kind: "narration" }, { count: false, allowPaused: true });
      }
    } catch (e) { table.log(`phones: ${e.message}`); } finally { table.ensuringPhones = false; }
  }

export function onPhoneLine(table, m) {
    if (!table.casualOn() || !table.isHuman(m) || m.visibility !== "window" || m.kind === "ooc" || !m.character_id) return undefined;
    const from = m.character_id;
    table.speakers.delete(m.chat_window_id);   // a text never moves anyone between scenes
    if (from !== table.phoneOwner(m.chat_window_id)) return undefined;
    const contacts = table.characters.filter((c) => c.id !== from && (table.isPc(c.id) || table.roster.isCoplayer(c.id) || table.roster.isNpc(c.id))).map((c) => ({ id: c.id, name: c.name }));
    const { to: named, body, addressed } = parseAddress(m.content, contacts);
    const to = named ?? (addressed ? null : table.casual.last[from] ?? null);
    if (!to || !body) {
      const hint = addressed ? "(No one by that name in your contacts. Write @ and their name: someone you have met in the story.)" : "(Who is this for? Start the message with @ and their name.)";
      table.post(m.chat_window_id, { content: hint, kind: "narration" }, { count: false }).catch(() => {});
      return undefined;
    }
    table.casual.last[from] = to;
    table.store.addPhone({ seq: m.seq, windowId: m.chat_window_id, from, to, text: body, at: table.now() });
    // A newer message supersedes a reply still on its way from that contact.
    table.casual.pending = table.casual.pending.filter((p) => !(p.from === to && p.to === from));
    table.save();
    if (table.isPc(to)) return table.relayText(from, to, body, m.id);
    return table.schedule(m.chat_window_id, { mode: "phone", phone: { fromId: from, toId: to } });
  }

export async function relayText(table, from, to, text, source = null) {
    const w = table.casual.phones[to];
    if (!w) { await table.post(table.casual.phones[from], { content: `(${table.nameOf(to)} has no phone yet.)`, kind: "narration" }, { count: false }); return 0; }
    table.casual.last[to] = from;
    table.save();
    table.lastPosted = null;
    const n = await table.post(w, { content: text, kind: "ic", character_id: from }, { count: false });
    if (source && table.lastPosted) table.phoneCopies.set(source, [table.lastPosted.id]);
    if (table.phoneCopies.size > 200) table.phoneCopies.delete(table.phoneCopies.keys().next().value);
    return n;
  }

export async function phoneTurn(table, windowId, { fromId, toId }) {
    if (!table.casualOn() || !fromId || !toId) return;
    const thread = renderThread(table.store.thread(fromId, toId, 30), (id) => table.nameOf(id));
    const max = table.cfg.casualMaxDelayMinutes ?? 240;
    const cp = table.roster.coplayers.find((c) => c.characterId === toId);
    if (cp) {
      const memories = table.memory.coplayerChapters(cp).map((c) => `[#${c.fromSeq}–#${c.toSeq}] ${c.text}`);
      const today = table.calendarOn() ? describeCalendar(table.calendar, { time: table.timelines.of(toId)?.narrativeTime || table.calendar.time }) : "";
      const known = new Set([...investigatorsFor(table.characters, table.roster).map((c) => c.id), fromId]);
      const card = await table.card(toId);
      const tableInfo = table.pbta
        ? [JSON.stringify(playerRules(table.pbta.pack, card?.pbta?.book))]
        : [today ? `TODAY IN THE STORY: ${today}` : "", today && describeRoutine(table.calendar) ? `${describeRoutine(table.calendar)} (common knowledge)` : "", renderBondsFor(table.bonds, toId, known, (id) => table.nameOf(id)), renderCorrectionsFor(table.planner.table, cp.name)];
      const self = [coplayerSelf({ coplayer: cp, card, world: table.improv.on ? table.improv.world : "", profile: table.profile, attrs: table.attrs.get(toId) ?? {} }), memories.length ? `WHAT YOU REMEMBER:\n${memories.join("\n\n")}` : "", ...tableInfo].filter(Boolean).join("\n\n");
      let r;
      try { r = await coplayerPhoneReply(table.llm, { language: table.language, self: [self, renderImpulse(table.impulseFor(toId))].filter(Boolean).join("\n\n"), name: cp.name, from: table.nameOf(fromId), thread, maxDelay: max, pc: table.profile.vocab.pc }); }
      catch (e) { table.log(`co-player ${cp.name} (phone): ${e.message}`); return; }
      if (r.reply) table.queueText({ windowId, from: toId, to: fromId, text: r.reply, minutes: r.delay });
      else table.log(`casual: ${cp.name} leaves ${table.nameOf(fromId)}'s message on read`);
    } else {
      const ctx = await table.buildGm(windowId);
      const last = table.store.thread(fromId, toId, 1).at(-1);
      let plan;
      try { plan = await directTurn(table.llm, { language: table.language, profile: table.profile, context: ctx.parts, pbta:table.pbta, newest: null, mode: "phone", auto: table.cfg.timelineAuto, forks: table.forks, improv: table.improv.on, casual: true, phone: { from: table.nameOf(fromId), to: table.nameOf(toId), thread, text: last?.text ?? "" } }); }
      catch (e) { table.log(`phone turn: ${e.message}`); return; }
      // Only messages and the GM's own notes: nothing happens in a scene because of a text.
      for (const a of plan.actions.filter((x) => ["text", "note", "truth", "world_change"].includes(x.type))) {
        if (a.type === "note") await table.post(table.mainWindow().id, { content: a.text, kind: "narration", visibility: "gm_only" }, { count: false });
        else await table.act(windowId, a, ctx, { mode: "phone", parent: "phone" });
      }
      if (!plan.actions.some((x) => x.type === "text")) table.log(`casual: ${table.nameOf(toId)} leaves ${table.nameOf(fromId)}'s message unanswered`);
    }
    await table.deliverDue();
  }

export async function sendText(table, a) {
    const from = table.characterByName(a.from);
    const to = table.characterByName(a.to);
    if (!from || !table.roster.isNpc(from.id)) { table.log(`text from "${a.from}" skipped: the GM texts only as a real NPC`); return 0; }
    if (to && table.roster.isCoplayer(to.id)) return table.aiText(from.id, to.id, a.text, a.delay_minutes);   // to a co-player: the phone log
    if (!to || !table.isPc(to.id) || !table.casual.phones[to.id]) { table.log(`text to "${a.to}" skipped: not a player character with a phone`); return 0; }
    table.queueText({ windowId: table.casual.phones[to.id], from: from.id, to: to.id, text: a.text, minutes: a.delay_minutes });
    await table.deliverDue();
    return 0;
  }

export async function aiText(table, from, to, text, minutes = 0) {
    if (!table.casualOn() || !table.casual.log || !String(text ?? "").trim() || from === to) return 0;
    table.queueText({ windowId: table.casual.log, from, to, text, minutes });
    await table.deliverDue();
    return 0;
  }

export function answerAiText(table, p) {
    const key = pairKey(p.from, p.to);
    const chain = (table.casual.chain[key] ?? 0) + 1;
    table.casual.chain[key] = chain;
    const now = table.now();
    table.casual.aiTexts = table.casual.aiTexts.filter((t) => now - t < HOUR);
    const away = now - table.lastHumanAt > table.cfg.autonomyIdleMinutes * 60000;
    const why = chain >= (table.cfg.casualAiChain ?? 4) ? "the exchange is long enough until someone writes" : table.casual.aiTexts.length >= (table.cfg.casualAiTextsPerHour ?? 12) ? "the hourly cap on texts between AI characters" : away ? "everyone is away" : table.overBudget() ? "the daily token budget" : "";
    if (why) { table.log(`casual: ${table.nameOf(p.to)} does not answer ${table.nameOf(p.from)} now (${why})`); return; }
    table.casual.aiTexts.push(now);
    table.enqueuePhone(table.casual.log, { fromId: p.from, toId: p.to });
  }

export function enqueuePhone(table, windowId, phone) {
    if (table.generation.signal.aborted) return;
    table.pending++;
    table.queue = table.queue.then(table.generation.task(() => table.phoneTurn(windowId, phone))).catch((e) => table.log(`phone turn failed: ${e.message}`)).then(() => { table.pending--; });
    return table.queue;
  }

export function queueText(table, { windowId, from, to, text, minutes = 0 }) {
    if (table.generation.signal.aborted) return;
    const at = dueAt(table.now(), minutes, table.cfg.casualMaxDelayMinutes ?? 240);
    table.casual.pending.push({ windowId, from, to, text: String(text).slice(0, 2000), dueAt: at });
    table.save();
    if (at > table.now()) table.log(`casual: ${table.nameOf(from)} → ${table.nameOf(to)} in ${Math.round((at - table.now()) / 60000)} min`);
  }

export async function deliverDue(table) {
    if (!table.casual.on || !table.casual.pending.length) return 0;
    const now = table.now();
    const due = table.casual.pending.filter((p) => p.dueAt <= now);
    if (!due.length) return 0;
    table.casual.pending = table.casual.pending.filter((p) => p.dueAt > now);
    table.save();
    for (const p of due) {
      const logged = p.windowId === table.casual.log;
      const signal = table.generation.signal;
      await table.post(p.windowId, { content: logged ? `→ ${table.nameOf(p.to)}: ${p.text}` : p.text, kind: "ic", character_id: p.from }, { count: false, allowPaused: true });
      table.store.addPhone({ windowId: p.windowId, from: p.from, to: p.to, text: p.text, at: now });
      table.casual.last[p.to] = p.from;   // a reply without @ goes back to whoever texted last
      if (logged && !signal.aborted) table.answerAiText(p);
    }
    table.save();
    return due.length;
  }

export async function declare(table, text, secret = false) {
    const t = String(text ?? "").trim();
    if (!t || table.worldUnsupported) return false;
    try {
      for (const part of chunk(t, 3900)) await table.api.declareWorld(table.channelId, { text: part, secret });
      table.log(`world ${secret ? "secret " : ""}declared: ${t.slice(0, 100)}`);
      return true;
    } catch (e) {
      if (e.status === 404 || e.status === 405) { table.worldUnsupported = true; table.log("this platform keeps no world record; world changes stay in the GM's notes"); }
      else table.log(`world declaration failed: ${e.message}`);
      return false;
    }
  }

export function hiddenLines(table) { return new Set([...table.improv.published.ids, ...table.pauseLines, ...table.artLines]); }

export async function setWorld(table, { on, world, secrets }) {
    if (on !== undefined) table.improv.on = Boolean(on);
    if (world !== undefined) table.improv.world = String(world);
    if (secrets !== undefined) table.improv.secrets = String(secrets);
    table.save();
    await table.publishWorld();
    await table.seedWorld();
    table.log(`improvisation ${table.improv.on ? "on" : "off"}: world ${table.improv.world.length} characters, secrets ${table.improv.secrets.length}, hidden truths ${table.improv.truths.length}`);
  }

export async function seedWorld(table) {
    const im = table.improv;
    if (!im.on) return;
    im.declared ??= {};
    for (const [key, text, secret] of [["world", im.world, false], ["secrets", im.secrets, true]]) {
      if (!text || im.declared[key] === hashText(text)) continue;
      if (await table.declare(text, secret)) { im.declared[key] = hashText(text); table.save(); }
    }
  }

export async function publishWorld(table) {
    const { on, world, published } = table.improv;
    if (!on || !world || published.hash === hashText(world)) return 0;
    const main = table.mainWindow();
    if (!main) return 0;
    const ids = [];
    try {
      for (const content of worldMessages(world)) {
        const m = await table.api.postMessage(table.channelId, main.id, { content, kind: "narration", visibility: "window" });
        table.botMessageIds.add(m.id);
        table.noteLine(m);
        ids.push(m.id);
      }
    } catch (e) {
      table.log(`posting the world setting failed (${e.message}); it is posted again when run starts`);
      table.improv.published.ids.push(...ids);
      table.save();
      return 0;
    }
    table.improv.published = { hash: hashText(world), ids: [...published.ids, ...ids].slice(-100) };
    table.save();
    await table.seedWorld();
    table.log(`world setting posted in "${main.name}" (${ids.length} message${ids.length === 1 ? "" : "s"})`);
    return ids.length;
  }
