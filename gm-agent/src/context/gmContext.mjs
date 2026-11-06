// The GM's context, shared by the GM and every real NPC: everything the GM account may read, including the
// platform's AI tips (the pinned board, GM reminders, script knowledge, the six documents, highlights, module
// hints), and every chat line in every window. Co-players never get this (see coplayerContext.mjs).
import { renderLine } from "./coplayerContext.mjs";
import { renderProfile } from "./profiles.mjs";
import { impression } from "./traits.mjs";
import { isPlayerCharacter } from "../roles/roster.mjs";
import { improvSections } from "../improv.mjs";
import { CHUNK_LINES, estimateTokens } from "../memory.mjs";
import { historyParts } from "../llm/parts.mjs";
import { recall, clipTokens } from "./recall.mjs";

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const json = (v, n) => clip(JSON.stringify(v ?? null), n);
export const duration = (ms) => (ms >= 86400000 ? `${Math.round(ms / 86400000)} d` : ms >= 3600000 ? `${Math.round(ms / 3600000)} h` : `${Math.max(1, Math.round(ms / 60000))} min`);

export class GmContext {
  // `history` and `memory` (memory.mjs) hold the chat and its compacted chapters; `budget` is GM_CONTEXT_TOKENS.
  constructor(api, channelId, { history, memory, budget = 60000, recallTokens = 1200, log = () => {} } = {}) {
    this.api = api;
    this.profile = null;         // the rules profile (rules/*.mjs); the table sets it. Null: the CoC words.
    this.channelId = channelId;
    this.history = history;
    this.memory = memory;
    this.budget = budget;
    this.recallBudget = Math.min(recallTokens, Math.floor(budget * 0.05));
    this.docRevision = 0;
    this.log = log;
    this.docCache = new Map();   // document id → {version, full}; retain omitted entries for local recall
    this.liveTips = [];          // tips pushed on /ws/context since the last turn
  }

  // A push on the context socket: refresh what changed, keep the newest tips for the next turn.
  onContextEvent(ev) {
    if (ev.type === "document.updated" || ev.type === "knowledge.reset") this.docRevision++;
    if (ev.type === "document.updated") this.docCache.delete(ev.document_id);
    if (ev.type === "knowledge.reset") this.docCache.clear();
    if (ev.type === "reminder.created" && ev.reminder) this.liveTips.push(`reminder: ${ev.reminder.title} — ${ev.reminder.why ?? ""}`);
    if (ev.type === "highlight.created" && ev.highlight) this.liveTips.push(`highlight: ${ev.highlight.reason ?? ""}`);
    if (ev.type === "proposal.pending") this.liveTips.push(`a memory proposal waits for the ${this.profile?.vocab.gm ?? "GM"}'s review`);
    this.liveTips = this.liveTips.slice(-10);
  }

  async safe(what, fn) {
    try { return await fn(); } catch (e) { if (e.status !== 403 && e.status !== 404) this.log(`gm context: ${what}: ${e.message}`); return null; }
  }

  // The GM documents, each within its share of the budget. The API lists entries oldest first; when a document is
  // too long the newest entries are kept (a long campaign's latest developments matter most).
  async documents(candidates = []) {
    const list = await this.safe("documents", () => this.api.documents(this.channelId));
    if (!list) return [];
    const active = new Set(list.filter((d) => d.entry_count).map((d) => d.id));
    for (const id of this.docCache.keys()) if (!active.has(id)) this.docCache.delete(id);
    const share = Math.max(800, Math.round(this.budget * 0.05));
    const out = [];
    for (const d of [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      if (!d.entry_count) continue;
      let cached = this.docCache.get(d.id);
      if (!cached || cached.version !== d.version) {
        const revision = this.docRevision;
        const full = await this.safe(`document ${d.doc_type}`, () => this.api.document(this.channelId, d.id));
        cached = { version: d.version, full };
        // A failed fetch must not pin a preview as the full document until the next version.
        if (full && revision === this.docRevision) this.docCache.set(d.id, cached);
      }
      const omitted = [];
      const text = newestFirst(cached.full, d.preview, share, omitted);
      out.push(`### ${d.title || d.doc_type} (v${d.version})\n${text}`);
      candidates.push(...omitted.map((e) => ({ match: e, text: `[GM document: ${d.title || d.doc_type}, v${d.version}] ${e}` })));
    }
    return out;
  }

  // Everything the GM model reads for one turn in `windowId`, as parts laid out stable-first (llm/parts.mjs):
  //   A (cached) – campaign, world setting, cast, scenarios, every window's chapters: changes rarely;
  //   B (cached) – this window's older lines since its last chapter, in frozen chunks of CHUNK_LINES;
  //   C (cached) – hidden truths, timelines, the GM board and documents: changes every few turns;
  //   D          – what changes every turn: the scenario's event count, reminders, tips, windows, the newest lines.
  // `sceneOf(windowId)` gives the active timeline played in a window (the main timeline for the Main Chat), or null.
  // `improv` (improv.mjs): in improvisation mode the module's script knowledge and hints are left out, and the world
  // setting and hidden truths are added. `hide` holds message ids left out of the chat (the posted world setting).
  // `awayOf(characterId)` is how long a player character's player has been away (ms), or null when they are around.
  // `storyPlan` is the planner's rendered section (planner.mjs) for part C; `peek` leaves the live tips for the GM (the
  // planner reads the context too, in the background). `calendar` and `bonds` are the rendered calendar.mjs and
  // bonds.mjs sections, and `table` the players' wishes and corrections (wishes.mjs), also for part C.
  async build({ windowId, roster, characters, windows, timelines, sceneOf = () => null, improv = null, hide = null, awayOf = () => null, storyPlan = "", peek = false, calendar = "", bonds = "", table = "", initiative = null }) {
    const ch = this.channelId;
    const candidates = [];
    const P = this.profile;
    const gm = P?.vocab.gm ?? "GM", pcs = P?.vocab.pcs ?? "investigators";
    const module = !improv?.on;
    await this.history.sync(windowId);
    const [channel, scenes, board, reminders, script, highlights, hints, proposals, docs, world] = await Promise.all([
      this.safe("channel", () => this.api.channel(ch)),
      this.safe("scenes", () => this.api.scenes(ch)),
      this.safe("board", () => this.api.kpBoard(ch)),
      this.safe("reminders", () => this.api.reminders(ch)),
      module ? this.safe("script knowledge", () => this.api.scriptKnowledge(ch)) : null,
      this.safe("highlights", () => this.api.highlights(ch)),
      module ? this.safe("module hints", () => this.api.moduleHints(ch)) : null,
      this.safe("proposals", () => this.api.proposals(ch)),
      this.documents(candidates),
      this.safe("world", () => this.api.world(ch)),
    ]);
    const charName = new Map(characters.map((c) => [c.id, c.name]));
    const current = (scenes ?? []).find((s) => s.id === channel?.current_scene_id);
    const tips = peek ? [...this.liveTips] : this.liveTips.splice(0);
    const nameOf = (id) => charName.get(id) ?? id;
    const windowName = (id) => windows.find((w) => w.id === id)?.name ?? id;
    // Every line carries the timeline it comes from, so a story told in one window is never taken as happening now.
    const render = (m) => {
      if (m.whisper_to?.length && !m.whisper_to_names) m.whisper_to_names = m.whisper_to.map(nameOf);
      return renderLine(m, { markVisibility: true, timeline: timelines ? timelines.ofLine(m).name : "", gm });
    };
    const shown = (m) => !hide?.has(m.id);
    const linesOf = (w) => this.history.lines(w).filter(shown);

    // ---- A: the campaign, rarely changing
    const a = [];
    a.push(`## Campaign\nname: ${channel?.name ?? ""}\nera: ${channel?.era || "(not set)"}\ndescription: ${clip(channel?.description, 600)}\nstory: ${channel?.story_status ?? "ongoing"}\ncurrent scenario: ${current ? `${current.title}${current.location ? ` @ ${current.location}` : ""}${current.narrative_time ? ` (${current.narrative_time})` : ""}` : "(none)"}`);
    const [worldSection, hiddenSection] = improvSections(improv);
    if (worldSection) a.push(worldSection);
    const prepared = (scenes ?? []).filter((s) => s.status === "active" && s.id !== channel?.current_scene_id);
    if (prepared.length) a.push(`## Prepared scenarios (enter_scenario)\n${prepared.map((s) => `- ${s.title}${s.location ? ` @ ${s.location}` : ""}${s.narrative_time ? ` (${s.narrative_time})` : ""}${s.summary ? `: ${clip(s.summary, 200)}` : ""}`).join("\n")}`);
    const closed = (scenes ?? []).filter((s) => s.status === "closed" && s.summary).slice(-8);
    if (closed.length) a.push(`## Earlier scenarios\n${closed.map((s) => `- ${s.title}: ${clip(s.summary, 800)}`).join("\n")}`);
    const pcList = characters.filter((c) => isPlayerCharacter(c, roster));
    const coplayers = characters.filter((c) => roster.isCoplayer(c.id));
    a.push([
      "## Cast",
      "Player characters (real people play them; never speak or decide for them), with their basic details and background:",
      ...(pcList.length ? pcList.map((c) => renderProfile(c, `played by ${c.player_name ?? "a player"}`, P)) : ["- (none yet)"]),
      `Co-players (AI ${pcs} that play alongside the players; they act on their own turn, so never speak or decide for them either), with their basic details and background:`,
      ...(coplayers.length ? coplayers.map((c) => renderProfile(c, "", P)) : ["- (none)"]),
      "Real NPCs (you voice them; known cast, not everyone currently active), with gender, age and what is most striking about them:",
      ...(roster.npcs.length ? roster.npcs.map((c) => { const look = impression(characters.find((x) => x.id === c.characterId)?.role_card); return `- ${c.name}${look ? ` ${look}` : ""}: ${clip(c.brief, 200)}`; }) : [`- (none yet; a new person who could bond with the ${pcs}, has more than one sentence to say and is one specific person enters with new_npc)`]),
    ].join("\n"));
    // Every window's chapters (the story so far, compacted), windows in a fixed order.
    const chaptered = windows.map((w) => ({ w, chapters: this.memory.gmChapters(w.id) })).filter((x) => x.chapters.length);
    if (chaptered.length) {
      a.push(["## The story so far (compacted chapters, oldest first; the lines since each window's last chapter follow below)",
        ...chaptered.map(({ w, chapters }) => `### In "${w.name}"\n${chapters.map((c) => `[#${c.fromSeq}–#${c.toSeq}] ${c.text}`).join("\n\n")}`)].join("\n"));
    }

    // ---- B: this window's lines since its last chapter, frozen in chunks; the rest goes to D
    const raw = this.memory.gmRaw(windowId, linesOf(windowId));
    let frozen = raw.slice(0, Math.floor(raw.length / CHUNK_LINES) * CHUNK_LINES);
    const tail = raw.slice(frozen.length);
    // Over budget (compaction has not caught up yet): the oldest lines wait for their chapter.
    while (frozen.length && estimateTokens([...frozen, ...tail].map(render).join("\n")) > this.budget - this.recallBudget) frozen = frozen.slice(CHUNK_LINES);
    const win = windows.find((w) => w.id === windowId);

    // ---- C: changes every few turns
    const c = [];
    if (hiddenSection) c.push(hiddenSection);
    if (table) c.push(table);
    if (storyPlan) c.push(storyPlan);
    if (calendar) c.push(calendar);
    if (bonds) c.push(bonds);
    if (timelines) {
      // Every active thread, always; then the most recent merged ones for context.
      const listed = [...timelines.active(), ...timelines.list.filter((t) => t.status !== "active" && t.mergedInto).slice(-6)];
      c.push([
        "## Timelines",
        `${pcs.charAt(0).toUpperCase()}${pcs.slice(1)} may be living different threads of the story. A line is tagged with the timeline it comes from: a character telling the table about events speaks from its own timeline, so those events happened there, not now in this scene. Knowledge crosses timelines only when a character who was there tells it.`,
        ...listed.map((t) => `- T${t.handle ?? "?"} ${t.name} [${t.status}${t.mergedInto ? ` into ${timelines.get(t.mergedInto)?.name ?? t.mergedInto}` : ""}${t.status === "active" && t.id !== "main" ? `, ${t.span} split` : ""}]${t.windowId ? ` in window "${windowName(t.windowId)}"` : ""}: ${t.members.map(nameOf).join(", ") || "(no one now)"}${t.narrativeTime ? `; time: ${t.narrativeTime}` : ""}${t.location ? `; place: ${t.location}` : ""}${t.notes ? `\n    notes: ${clip(t.notes, 600)}` : ""}`),
      ].join("\n"));
    }
    if (board && (board.next || board.notes)) c.push(`## ${gm} board (platform AI)\nnext: ${json(board.next, 2500)}\nnotes: ${json(board.notes, 2500)}`);
    if (script?.length) {
      const flow = script.filter((k) => k.kind === "flow").sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
      const rest = script.filter((k) => k.kind !== "flow" && k.status !== "done").slice(0, 30);
      c.push(`## Script knowledge (from the module)\n${flow.map((k) => `- stage ${k.position ?? ""} [${k.status}] ${k.title}: ${clip(k.body, k.status === "active" ? 1200 : 250)}`).join("\n")}\n${rest.map((k) => `- ${k.kind} [${k.status}] ${k.title}: ${clip(k.body, 250)}`).join("\n")}`);
    }
    const worldNow = worldRecordSection(world, Math.max(800, Math.round(this.budget * 0.08)));
    if (worldNow) c.push(worldNow);
    if (docs.length) c.push(`## ${gm} documents (platform AI)\n${docs.join("\n\n")}`);

    // ---- D: every turn
    const d = [];
    if (current) d.push(`## Now\nThe current scenario "${current.title}" has ${current.event_count ?? 0} events so far.`);
    if (reminders?.length) d.push(`## ${gm} reminders (platform AI)\n${reminders.slice(0, 8).map((r) => `- [${r.kind}] ${r.title}: ${clip(r.why, 300)}`).join("\n")}`);
    if (highlights?.length) d.push(`## Highlights (platform AI)\n${highlights.slice(0, 10).map((h) => `- ${clip(h.reason, 200)}`).join("\n")}`);
    if (hints?.length) d.push(`## Module hints (platform AI)\n${hints.slice(0, 6).map((h) => `- ${clip(h.reason ?? h.description ?? JSON.stringify(h), 200)}`).join("\n")}`);
    if (proposals?.length) d.push(`## Pending memory proposals\n${proposals.length} waiting for the ${gm}'s review in the web app.`);
    if (tips.length) d.push(`## Just pushed by the platform\n${tips.map((t) => `- ${clip(t, 300)}`).join("\n")}`);
    // Who is really in each window's scene, who is a member but elsewhere, and which windows' scenes are over.
    const who = (id) => { const ms = awayOf(id); return ms ? `${nameOf(id)} (player away ${duration(ms)})` : nameOf(id); };
    const describe = (w) => {
      if (timelines?.retired(w.id)) return "(scene over: merged into another thread)";
      const scene = sceneOf(w.id);
      const memberChars = (w.members ?? []).filter((m) => m.character_id).map((m) => m.character_id);
      if (!scene) return [...memberChars.map(who), ...roster.coplayersIn(w.id).map((x) => x.name)].join(", ") || `(no ${pcs})`;
      const here = scene.members.map(who);
      const away = memberChars.filter((id) => !scene.members.includes(id)).map((id) => `${nameOf(id)} (in ${timelines.of(id).name})`);
      return `${here.join(", ") || "(no one)"}${away.length ? `; members elsewhere: ${away.join(", ")}` : ""}`;
    };
    d.push(`## Chat windows\n${windows.map((w) => `- ${w.name} (${w.kind})${w.id === windowId ? " ← this turn" : ""}: ${describe(w)}`).join("\n")}`);
    // D&D: this window's Initiative order, when a fight is on (the platform keeps it; the dice action moves it).
    if (initiative?.entries?.length) {
      const turn = Number(initiative.turn) || 0;
      d.push([`## Initiative in "${win?.name ?? "this window"}" (round ${initiative.round || 1}; use dice ".init next" after each turn)`,
        ...initiative.entries.map((e, i) => `- ${e.name} ${e.total}${i === turn ? " ← now" : ""}${e.character_id ? "" : " (yours)"}`)].join("\n"));
    }
    // Windows whose scene is over are left out, except the last few merged threads: the GM needs what just
    // happened there when the party reunites (their chapters stay in A in any case).
    const included = new Set([...frozen, ...tail].map((m) => m.seq));
    const recentMerged = new Set((timelines?.list ?? []).filter((t) => t.status !== "active" && t.windowId).slice(-3).map((t) => t.windowId));
    for (const w of windows.filter((x) => x.id !== windowId && (!timelines?.retired(x.id) || recentMerged.has(x.id)))) {
      const lines = this.memory.gmRaw(w.id, linesOf(w.id)).slice(-8);
      for (const m of lines) included.add(m.seq);
      if (lines.length) d.push(`## Recent lines in "${w.name}"\n${lines.map(render).join("\n")}`);
    }
    d.push(`## Chat in "${win?.name ?? "this window"}" (newest last${frozen.length ? "; earlier lines above" : ""})\n${tail.map(render).join("\n") || (frozen.length ? "(see above)" : "(no lines yet)")}`);

    // Recover specific facts omitted by compaction/document budgets, without asking another model to search.
    for (const w of windows) for (const m of linesOf(w.id)) {
      if (!included.has(m.seq)) candidates.push({ match: m.content, text: `[Window: ${w.name}] ${render(m)}`, source: `[Window: ${w.name}] ${render({ ...m, content: "", dice: null })} ` });
    }
    const recalled = recall(raw.slice(-6).map((m) => m.content).join("\n"), candidates, this.recallBudget);
    if (recalled) d.unshift(recalled);
    const parts = [
      { text: `${a.join("\n\n")}\n\n`, cache: true },
      ...historyParts(frozen, render, `## Chat in "${win?.name ?? "this window"}", earlier lines since its last chapter`, CHUNK_LINES),
      ...(c.length ? [{ text: `${c.join("\n\n")}\n\n`, cache: true, cacheTtl: "5m" }] : []),
      { text: d.join("\n\n") },
    ];
    const here = [...frozen, ...tail];
    return { parts, text: parts.map((p) => p.text).join(""), newest: here.at(-1) ?? null, current, world, render, lines: (w) => linesOf(w) };
  }
}

// The platform's living world record: every entity with something known about it now, within `budget` tokens (the
// most recently changed kept), in the record's own order, then the latest changes.
function worldRecordSection(world, budget) {
  const known = (world?.entities ?? []).filter((e) => (e.status && e.status !== "unknown") || e.state || e.location);
  if (!known.length) return "";
  const line = (e) => `- [${e.kind}] ${e.name}${e.status && e.status !== "unknown" ? ` — ${e.status}` : ""}${e.state ? `: ${String(e.state).replace(/\s+/g, " ").trim()}` : ""}${e.location?.name ? ` (at ${e.location.name})` : ""}${e.state_by === "gm" ? " [set by you]" : ""}`;
  const keep = new Set();
  let used = 0;
  for (const e of [...known].sort((a, b) => String(b.state_updated_at ?? "").localeCompare(String(a.state_updated_at ?? "")))) {
    const t = estimateTokens(line(e));
    if (used + t > budget && keep.size) break;
    keep.add(e.id); used += t;
  }
  const changes = (world.recent_changes ?? []).slice(0, 8).map((c) => `- ${c.name}: ${c.status}${c.state ? `, ${String(c.state).replace(/\s+/g, " ").trim()}` : ""}${c.location_name ? ` (at ${c.location_name})` : ""} (${c.actor === "gm" ? "you" : "from play"})`);
  const dropped = known.length - keep.size;
  return [`## The world now (the platform's record of what is true at present; keep to it, change it with world_change)`, ...known.filter((e) => keep.has(e.id)).map(line), ...(dropped ? [`(${dropped} more entities not shown)`] : []), ...(changes.length ? ["Latest changes:", ...changes] : [])].join("\n");
}

// A document's entries within `budget` tokens, newest kept, in their own order, with a note of how many were left out.
function newestFirst(full, preview, budget, omitted = []) {
  let entries = (full?.entries ?? []).filter((e) => !e.removed);
  if (!entries.length) {
    const md = String(full?.markdown ?? preview ?? "");
    if (estimateTokens(md) <= budget) return md;
    // Older platform versions expose markdown only. Keep a bounded recent tail and make earlier pieces searchable.
    const chars = Array.from(md);
    entries = [];
    for (let i = 0; i < chars.length; i += 600) entries.push({ content_md: chars.slice(i, i + 600).join(""), created_version: i });
  }
  const order = entries.map((e, i) => ({ e, i, v: Number(e.updated_version ?? e.created_version ?? 0) }));
  const keep = new Map();
  let remaining = Math.max(0, budget - 40); // section labels and the omitted-entry note count too
  for (const x of [...order].sort((p, q) => q.v - p.v || q.i - p.i)) {
    const value = String(x.e.content_md ?? x.e.summary ?? "").replace(/\s+/g, " ").trim();
    const line = `${x.e.section ? `[${x.e.section}] ` : ""}${value}`;
    const cost = estimateTokens(line) + 2;
    if (cost <= remaining) { keep.set(x.i, line); remaining -= cost; }
    else {
      if (!keep.size) { keep.set(x.i, clipTokens(line, remaining)); omitted.push(value); }
      break;
    }
  }
  const lines = [];
  for (const x of order) {
    if (!keep.has(x.i)) { omitted.push(String(x.e.content_md ?? x.e.summary ?? "")); continue; }
    lines.push(`- ${keep.get(x.i)}`);
  }
  const dropped = entries.length - keep.size;
  return clipTokens(`${lines.join("\n")}${dropped ? `\n(${dropped} older entries not shown)` : ""}`, budget);
}
