// Story timelines. The platform has scenarios for the whole campaign, but no idea that part of the party may be living
// another thread: co-players split off on their own, a player's private scene, a story told later about something that
// happened elsewhere. The client keeps that here, in its state file.
//
// Every investigator (player character or co-player) is in exactly one active timeline; the main timeline always
// exists. A timeline may be bound to a window (a co-players-only side window). A line belongs to the timeline of its
// window when the window is bound, else to its speaker's timeline: so even in one window, lines can come from
// different timelines, and the GM is told which.
// `notes` are the GM's own and are shown only to the GM.

export const MAIN = "main";
const norm = (s) => String(s ?? "").trim().toLowerCase();

export class Timelines {
  constructor(list = [], { now = Date.now } = {}) {
    this.now = now;
    this.list = Array.isArray(list) ? list.map((t) => ({ ...t, members: [...(t.members ?? [])] })) : [];
    if (!this.get(MAIN)) this.list.unshift(this.blank(MAIN, "Main story"));
  }

  blank(id, name) {
    return { id, name, status: "active", members: [], windowId: null, returnTo: [], narrativeTime: "", location: "", notes: "", createdAt: new Date(this.now()).toISOString(), mergedInto: null };
  }

  toJSON() { return this.list; }
  get(id) { return this.list.find((t) => t.id === id); }
  main() { return this.get(MAIN); }
  active() { return this.list.filter((t) => t.status === "active"); }
  byName(name) { return this.list.find((t) => t.id === name) ?? this.active().find((t) => norm(t.name) === norm(name)) ?? this.list.find((t) => norm(t.name) === norm(name)); }
  of(characterId) { return this.active().find((t) => t.members.includes(characterId)) ?? this.main(); }
  // The timeline a window is bound to: the active one if any, else the last one that was (for older lines).
  ofWindow(windowId) {
    const bound = this.list.filter((t) => t.windowId && t.windowId === windowId);
    return bound.find((t) => t.status === "active") ?? bound.at(-1) ?? null;
  }
  ofLine(message) {
    const bound = this.ofWindow(message.chat_window_id);
    if (bound) return bound;
    if (message.character_id) return this.of(message.character_id);
    return this.main();
  }

  // Every investigator in exactly one active timeline; gone characters dropped; new ones join the main timeline.
  reconcile(investigatorIds) {
    const known = new Set(investigatorIds);
    const seen = new Set();
    for (const t of this.active()) {
      t.members = t.members.filter((id) => known.has(id) && !seen.has(id));
      for (const id of t.members) seen.add(id);
    }
    for (const id of investigatorIds) if (!seen.has(id)) this.main().members.push(id);
    return this;
  }

  take(ids) { for (const t of this.active()) t.members = t.members.filter((id) => !ids.includes(id)); }

  split({ name, members, windowId = null, returnTo = [], narrativeTime = "", location = "", notes = "" }) {
    const id = `t-${this.now().toString(36)}-${this.list.length}`;
    this.take(members);
    const t = { ...this.blank(id, String(name || "Side thread").slice(0, 80)), members: [...members], windowId, returnTo, narrativeTime, location, notes };
    this.list.push(t);
    return t;
  }

  merge(id, intoId = MAIN) {
    const t = this.get(id);
    const into = this.get(intoId) ?? this.main();
    if (!t || t.id === MAIN || t.status !== "active" || into === t) return null;
    into.members.push(...t.members.filter((m) => !into.members.includes(m)));
    t.status = "merged"; t.mergedInto = into.id; t.members = [];
    return into;
  }

  update(id, { narrativeTime, location, notes, add = [], remove = [] } = {}) {
    const t = this.get(id);
    if (!t || t.status !== "active") return null;
    if (narrativeTime !== undefined) t.narrativeTime = String(narrativeTime).slice(0, 120);
    if (location !== undefined) t.location = String(location).slice(0, 120);
    if (notes !== undefined) t.notes = String(notes).slice(0, 2000);
    if (add.length) { this.take(add); t.members.push(...add); }
    if (remove.length && t.id !== MAIN) { t.members = t.members.filter((m) => !remove.includes(m)); this.main().members.push(...remove); }
    return t;
  }
}
