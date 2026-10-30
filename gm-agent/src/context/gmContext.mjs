// The Keeper's context, shared by the GM and every real NPC: everything the Keeper account may read, including the
// platform's AI tips (the pinned board, Keeper reminders, script knowledge, the six documents, highlights, module
// hints), and every chat line in every window. Co-players never get this (see coplayerContext.mjs).
import { renderLine } from "./coplayerContext.mjs";

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const json = (v, n) => clip(JSON.stringify(v ?? null), n);

export class GmContext {
  constructor(api, channelId, { contextLines = 60, log = () => {} } = {}) {
    this.api = api;
    this.channelId = channelId;
    this.contextLines = contextLines;
    this.log = log;
    this.docCache = new Map();   // document id → {version, markdown}
    this.liveTips = [];          // tips pushed on /ws/context since the last turn
  }

  // A push on the context socket: refresh what changed, keep the newest tips for the next turn.
  onContextEvent(ev) {
    if (ev.type === "document.updated") this.docCache.delete(ev.document_id);
    if (ev.type === "knowledge.reset") this.docCache.clear();
    if (ev.type === "reminder.created" && ev.reminder) this.liveTips.push(`reminder: ${ev.reminder.title} — ${ev.reminder.why ?? ""}`);
    if (ev.type === "highlight.created" && ev.highlight) this.liveTips.push(`highlight: ${ev.highlight.reason ?? ""}`);
    if (ev.type === "proposal.pending") this.liveTips.push("a memory proposal waits for the Keeper's review");
    this.liveTips = this.liveTips.slice(-10);
  }

  async safe(what, fn) {
    try { return await fn(); } catch (e) { if (e.status !== 403 && e.status !== 404) this.log(`gm context: ${what}: ${e.message}`); return null; }
  }

  async documents() {
    const list = (await this.safe("documents", () => this.api.documents(this.channelId))) ?? [];
    const out = [];
    for (const d of list) {
      if (!d.entry_count) continue;
      let cached = this.docCache.get(d.id);
      if (!cached || cached.version !== d.version) {
        const full = await this.safe(`document ${d.doc_type}`, () => this.api.document(this.channelId, d.id));
        cached = { version: d.version, markdown: full?.markdown ?? d.preview ?? "" };
        this.docCache.set(d.id, cached);
      }
      out.push(`### ${d.title || d.doc_type} (v${d.version})\n${clip(cached.markdown, 2500)}`);
    }
    return out;
  }

  // Everything the GM model reads for one turn in `windowId`.
  async build({ windowId, roster, characters, windows }) {
    const ch = this.channelId;
    const [channel, scenes, board, reminders, script, highlights, hints, proposals, docs] = await Promise.all([
      this.safe("channel", () => this.api.channel(ch)),
      this.safe("scenes", () => this.api.scenes(ch)),
      this.safe("board", () => this.api.kpBoard(ch)),
      this.safe("reminders", () => this.api.reminders(ch)),
      this.safe("script knowledge", () => this.api.scriptKnowledge(ch)),
      this.safe("highlights", () => this.api.highlights(ch)),
      this.safe("module hints", () => this.api.moduleHints(ch)),
      this.safe("proposals", () => this.api.proposals(ch)),
      this.documents(),
    ]);
    const messages = await this.chat(windowId, windows);
    const charName = new Map(characters.map((c) => [c.id, c.name]));
    for (const m of messages) if (m.whisper_to?.length) m.whisper_to_names = m.whisper_to.map((id) => charName.get(id) ?? id);
    const current = (scenes ?? []).find((s) => s.id === channel?.current_scene_id);
    const tips = this.liveTips.splice(0);

    const sections = [];
    sections.push(`## Campaign\nname: ${channel?.name ?? ""}\nera: ${channel?.era || "(not set)"}\ndescription: ${clip(channel?.description, 600)}\nstory: ${channel?.story_status ?? "ongoing"}\ncurrent scenario: ${current ? `${current.title}${current.location ? ` @ ${current.location}` : ""}${current.narrative_time ? ` (${current.narrative_time})` : ""}` : "(none)"}`);
    const closed = (scenes ?? []).filter((s) => s.status === "closed" && s.summary).slice(-4);
    if (closed.length) sections.push(`## Earlier scenarios\n${closed.map((s) => `- ${s.title}: ${clip(s.summary, 500)}`).join("\n")}`);
    const pcs = characters.filter((c) => c.kind === "pc");
    sections.push([
      "## Cast",
      "Player characters (real people play them; never speak or decide for them):",
      ...(pcs.length ? pcs.map((c) => `- ${c.name} (played by ${c.player_name ?? "a player"})`) : ["- (none yet)"]),
      "Co-players (AI investigators that play alongside the players; they act on their own turn, so never speak or decide for them either):",
      ...(roster.coplayers.length ? roster.coplayers.map((c) => `- ${c.name}`) : ["- (none)"]),
      "Real NPCs (you voice them):",
      ...(roster.npcs.length ? roster.npcs.map((c) => `- ${c.name}: ${clip(c.brief, 200)}`) : ["- (none yet; introduce them with new_npc)"]),
    ].join("\n"));
    if (board && (board.next || board.notes)) sections.push(`## Keeper board (platform AI)\nnext: ${json(board.next, 2500)}\nnotes: ${json(board.notes, 2500)}`);
    if (reminders?.length) sections.push(`## Keeper reminders (platform AI)\n${reminders.slice(0, 8).map((r) => `- [${r.kind}] ${r.title}: ${clip(r.why, 300)}`).join("\n")}`);
    if (script?.length) {
      const flow = script.filter((k) => k.kind === "flow").sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const rest = script.filter((k) => k.kind !== "flow" && k.status !== "done").slice(0, 30);
      sections.push(`## Script knowledge (from the module)\n${flow.map((k) => `- stage ${k.position ?? ""} [${k.status}] ${k.title}: ${clip(k.body, k.status === "active" ? 1200 : 250)}`).join("\n")}\n${rest.map((k) => `- ${k.kind} [${k.status}] ${k.title}: ${clip(k.body, 250)}`).join("\n")}`);
    }
    if (docs.length) sections.push(`## Keeper documents (platform AI)\n${docs.join("\n\n")}`);
    if (highlights?.length) sections.push(`## Highlights (platform AI)\n${highlights.slice(0, 10).map((h) => `- ${clip(h.reason, 200)}`).join("\n")}`);
    if (hints?.length) sections.push(`## Module hints (platform AI)\n${hints.slice(0, 6).map((h) => `- ${clip(h.reason ?? h.description ?? JSON.stringify(h), 200)}`).join("\n")}`);
    if (proposals?.length) sections.push(`## Pending memory proposals\n${proposals.length} waiting for the Keeper's review in the web app.`);
    if (tips.length) sections.push(`## Just pushed by the platform\n${tips.map((t) => `- ${clip(t, 300)}`).join("\n")}`);
    sections.push(`## Chat windows\n${windows.map((w) => `- ${w.name} (${w.kind})${w.id === windowId ? " ← this turn" : ""}: ${(w.members ?? []).map((m) => m.character_name || m.display_name).join(", ")}`).join("\n")}`);
    const others = windows.filter((w) => w.id !== windowId);
    for (const w of others) {
      const lines = messages.filter((m) => m.chat_window_id === w.id).slice(-8);
      if (lines.length) sections.push(`## Recent lines in "${w.name}"\n${lines.map((m) => renderLine(m, { markVisibility: true })).join("\n")}`);
    }
    const here = messages.filter((m) => m.chat_window_id === windowId);
    const win = windows.find((w) => w.id === windowId);
    sections.push(`## Chat in "${win?.name ?? "this window"}" (newest last)\n${here.map((m) => renderLine(m, { markVisibility: true })).join("\n") || "(no lines yet)"}`);
    return { text: sections.join("\n\n"), newest: here[here.length - 1] ?? null, current };
  }

  async chat(windowId, windows) {
    const out = [];
    for (const w of windows) {
      const limit = w.id === windowId ? this.contextLines : 8;
      const rows = await this.safe(`messages ${w.name}`, () => this.api.messages(this.channelId, w.id, limit));
      if (rows) out.push(...rows);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }
}
