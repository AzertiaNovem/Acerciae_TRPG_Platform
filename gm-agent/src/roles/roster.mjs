// The client's own cast. On the platform co-players and real NPCs are both `kind: "npc"` characters owned by the
// Keeper account; here they are kept apart, because they are given different context:
//   real NPC  – voiced by the GM model, shares the Keeper's whole context;
//   co-player – a fellow investigator with an LLM-made role card, sees only the chat log it could have witnessed.
// Co-players carry COPLAYER_MARK at the start of `speaking_style` so the split survives a lost state file.
// A co-player sits in windows for a stretch of the chat: `seats: [{windowId, fromSeq, toSeq}]`, where `toSeq` is null
// while it is still there. It hears a window's lines only during its seats, and acts only where a seat is open.
export const COPLAYER_MARK = "[co-player]";

export const markStyle = (style) => `${COPLAYER_MARK} ${String(style ?? "").replace(COPLAYER_MARK, "").trim()}`.trim();
export const unmarkStyle = (style) => String(style ?? "").replace(COPLAYER_MARK, "").trim();
const norm = (s) => String(s ?? "").trim().toLowerCase();

export const openSeat = (windowId, fromSeq = 0) => ({ windowId, fromSeq, toSeq: null });
export const openWindows = (coplayer) => coplayer.seats.filter((s) => s.toSeq === null).map((s) => s.windowId);

// Older state files list `windows`: each becomes a seat open since the start of the chat.
function migrate(coplayer) {
  if (!Array.isArray(coplayer.seats)) coplayer.seats = (coplayer.windows ?? []).map((w) => openSeat(w));
  delete coplayer.windows;
  return coplayer;
}

export class Roster {
  constructor({ coplayers = [], npcs = [] } = {}) {
    this.coplayers = coplayers.map(migrate);
    this.npcs = npcs;
  }

  toJSON() { return { coplayers: this.coplayers, npcs: this.npcs }; }

  isCoplayer(characterId) { return this.coplayers.some((c) => c.characterId === characterId); }
  isNpc(characterId) { return this.npcs.some((c) => c.characterId === characterId); }
  coplayersIn(windowId) { return this.coplayers.filter((c) => openWindows(c).includes(windowId)); }

  // Moves co-players: their open seats close after `atSeq`, and new seats open in `windowIds` from `openFrom`
  // (the next line by default; the line that called them back, when they rejoin in answer to it). `atSeq` and
  // `openFrom` may be functions of the window, for per-window cut points. A co-player already seated only in the
  // target windows is left alone, so a repeated move changes nothing.
  moveSeats(coplayers, windowIds, atSeq, openFrom = null) {
    const cut = (w) => (typeof atSeq === "function" ? atSeq(w) : atSeq);
    const from = (w) => (typeof openFrom === "function" ? openFrom(w) : openFrom ?? cut(w) + 1);
    for (const c of coplayers) {
      const open = openWindows(c);
      if (open.length === windowIds.length && open.every((w) => windowIds.includes(w))) continue;
      for (const s of c.seats) if (s.toSeq === null) s.toSeq = Math.max(s.fromSeq - 1, cut(s.windowId));
      for (const w of windowIds) c.seats.push(openSeat(w, from(w)));
    }
  }
  coplayerByName(name) { return this.coplayers.find((c) => norm(c.name) === norm(name)); }
  npcByName(name) { return this.npcs.find((c) => norm(c.name) === norm(name)); }

  // Brings the roster in line with the channel's characters: forgets deleted ones, picks up co-players by their mark
  // and treats every other NPC (including ones the Keeper made by hand) as a real NPC.
  reconcile(characters, defaultWindows) {
    const byId = new Map(characters.map((c) => [c.id, c]));
    this.coplayers = this.coplayers.filter((c) => byId.has(c.characterId));
    this.npcs = this.npcs.filter((c) => byId.has(c.characterId) && !this.isCoplayer(c.characterId));
    for (const c of characters) {
      if (c.kind !== "npc") continue;
      const entry = this.coplayers.find((x) => x.characterId === c.id) ?? this.npcs.find((x) => x.characterId === c.id);
      if (entry) { entry.name = c.name; continue; }
      if (String(c.speaking_style ?? "").startsWith(COPLAYER_MARK)) {
        this.coplayers.push({ characterId: c.id, name: c.name, persona: c.bio ?? "", speakingStyle: unmarkStyle(c.speaking_style), seats: defaultWindows.map((w) => openSeat(w)) });
      } else {
        this.npcs.push({ characterId: c.id, name: c.name, brief: c.bio || c.description || "" });
      }
    }
    return this;
  }
}
