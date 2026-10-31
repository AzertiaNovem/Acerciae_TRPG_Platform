// Story timelines. The platform has scenarios for the whole campaign, but no idea that part of the party may be living
// another thread: co-players or players who went somewhere else, a story told later about something that happened
// elsewhere. The client keeps that here, in its state file.
//
// Every investigator (player character or co-player) is in exactly one active timeline; the main timeline always
// exists and is played in the Main Chat. Other timelines are bound to a window of their own. Each has a persistent
// handle (T0 is the main timeline; handles are never reused), a span ("short": the party is briefly apart, as in two
// rooms of one house; "long": far apart, as in two cities) and `opened` (its first scene has been played).
//
// The membership log records who was in which timeline from which chat line on, so every line is attributed to the
// timeline its speaker was in when it was written: a player's lines from before a split keep the old tag, and a line
// written by someone visiting another window is recognised as coming from elsewhere.
// `notes` are the GM's own and are shown only to the GM.

export const MAIN = "main";
const norm = (s) => String(s ?? "").trim().toLowerCase();
const MERGED_KEPT = 20;

// Places are compared loosely: case, punctuation and leading articles do not matter ("the Old Harbour" = "old harbour").
export const placeKey = (s) => norm(s).replace(/[\p{P}\p{S}]+/gu, " ").replace(/^(the|a|an)\s+/, "").replace(/\s+/g, " ").trim();

export class Timelines {
  // `data` is the persisted object {list, log, nextHandle}, or (older state files) just the list.
  constructor(data = [], { now = Date.now } = {}) {
    this.now = now;
    const src = Array.isArray(data) ? { list: data } : (data ?? {});
    this.list = (src.list ?? []).map((t) => ({ span: "short", opened: true, handle: null, ...t, members: [...(t.members ?? [])] }));
    this.log = Array.isArray(src.log) ? src.log.map((e) => ({ ...e })) : [];
    if (!this.get(MAIN)) this.list.unshift(this.blank(MAIN, "Main story"));
    this.main().handle = 0;
    this.nextHandle = Math.max(Number(src.nextHandle) || 1, ...this.list.map((t) => (Number.isInteger(t.handle) ? t.handle + 1 : 1)));
    for (const t of this.list) if (!Number.isInteger(t.handle)) t.handle = this.nextHandle++;
  }

  blank(id, name) {
    return { id, name, status: "active", members: [], windowId: null, returnTo: [], narrativeTime: "", location: "", notes: "", span: "short", opened: true, handle: null, createdAt: new Date(this.now()).toISOString(), mergedInto: null };
  }

  toJSON() { return { list: this.list, log: this.log, nextHandle: this.nextHandle }; }
  get(id) { return this.list.find((t) => t.id === id); }
  main() { return this.get(MAIN); }
  active() { return this.list.filter((t) => t.status === "active"); }
  byHandle(handle) {
    const m = String(handle ?? "").trim().match(/^T?(\d+)$/i);
    return m ? this.list.find((t) => t.handle === Number(m[1])) ?? null : null;
  }
  byName(name) {
    const s = String(name ?? "");
    return this.list.find((t) => t.id === s) ?? (/^T\d+$/i.test(s) ? this.byHandle(s) : null) ?? this.active().find((t) => norm(t.name) === norm(s)) ?? this.list.find((t) => norm(t.name) === norm(s));
  }
  of(characterId) { return this.active().find((t) => t.members.includes(characterId)) ?? this.main(); }
  // The timeline a window is bound to: the active one if any, else the last one that was (for older lines).
  ofWindow(windowId) {
    const bound = this.list.filter((t) => t.windowId && t.windowId === windowId);
    return bound.find((t) => t.status === "active") ?? bound.at(-1) ?? null;
  }
  activeOfWindow(windowId) { const t = this.ofWindow(windowId); return t?.status === "active" ? t : null; }
  // A window that was bound to a thread that has since been merged: its scene is over.
  retired(windowId) { const t = this.ofWindow(windowId); return Boolean(t) && t.status !== "active"; }
  // An active timeline at this place (see placeKey), if any.
  atPlace(place) { const k = placeKey(place); return k ? this.active().find((t) => placeKey(t.location) === k) ?? null : null; }

  known(characterId) { return this.list.some((t) => t.members.includes(characterId)) || this.log.some((e) => e.id === characterId); }
  // Which timeline an investigator was in when line `seq` was written.
  timelineAt(characterId, seq) {
    let id = null;
    for (const e of this.log) if (e.id === characterId && e.fromSeq <= seq) id = e.timelineId;
    if (id === null) return this.log.some((e) => e.id === characterId) ? this.main() : this.of(characterId);
    return this.get(id) ?? this.main();
  }
  // A line belongs to its speaker's timeline at that moment; Keeper and NPC lines to their window's timeline.
  ofLine(message) {
    if (message.character_id && this.known(message.character_id)) return this.timelineAt(message.character_id, message.seq ?? Infinity);
    return this.ofWindow(message.chat_window_id) ?? this.main();
  }

  record(ids, timelineId, fromSeq) {
    for (const id of ids) this.log.push({ id, timelineId, fromSeq: Number.isFinite(fromSeq) ? fromSeq : 0 });
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

  split({ name, members, windowId = null, returnTo = [], narrativeTime = "", location = "", notes = "", span = "short", opened = true, fromSeq = 0 }) {
    const id = `t-${this.now().toString(36)}-${this.list.length}`;
    this.take(members);
    const t = { ...this.blank(id, String(name || location || "Side thread").slice(0, 80)), members: [...members], windowId, returnTo, narrativeTime, location, notes, span: span === "long" ? "long" : "short", opened, handle: this.nextHandle++ };
    this.list.push(t);
    this.record(members, id, fromSeq);
    this.prune();
    return t;
  }

  // Investigators join timeline `toId` from line `fromSeq` on.
  move(ids, toId, fromSeq = 0) {
    const to = this.get(toId);
    if (!to || to.status !== "active" || !ids.length) return null;
    this.take(ids);
    to.members.push(...ids.filter((m) => !to.members.includes(m)));
    this.record(ids, to.id, fromSeq);
    return to;
  }

  merge(id, intoId = MAIN, fromSeq = 0) {
    const t = this.get(id);
    const into = this.get(intoId) ?? this.main();
    if (!t || t.id === MAIN || t.status !== "active" || into === t) return null;
    const members = [...t.members];
    into.members.push(...members.filter((m) => !into.members.includes(m)));
    this.record(members, into.id, fromSeq);
    t.status = "merged"; t.mergedInto = into.id; t.members = [];
    this.prune();
    return into;
  }

  relocate(id, { location, narrativeTime } = {}) {
    const t = this.get(id);
    if (!t || t.status !== "active") return null;
    if (location) t.location = String(location).slice(0, 120);
    if (narrativeTime) t.narrativeTime = String(narrativeTime).slice(0, 120);
    return t;
  }

  update(id, { narrativeTime, location, notes, span, add = [], remove = [], fromSeq = 0 } = {}) {
    const t = this.get(id);
    if (!t || t.status !== "active") return null;
    if (narrativeTime !== undefined) t.narrativeTime = String(narrativeTime).slice(0, 120);
    if (location !== undefined) t.location = String(location).slice(0, 120);
    if (notes !== undefined) t.notes = String(notes).slice(0, 2000);
    if (span === "short" || span === "long") t.span = span;
    if (add.length) this.move(add, t.id, fromSeq);
    if (remove.length && t.id !== MAIN) this.move(remove, MAIN, fromSeq);
    return t;
  }

  // Merged threads without a window of their own are dropped after the newest MERGED_KEPT; the log keeps their ids,
  // and lines that pointed at them fall back to the main timeline.
  prune() {
    const loose = this.list.filter((t) => t.status !== "active" && !t.windowId);
    for (const t of loose.slice(0, Math.max(0, loose.length - MERGED_KEPT))) this.list.splice(this.list.indexOf(t), 1);
  }
}
