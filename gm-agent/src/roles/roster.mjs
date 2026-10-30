// The client's own cast. On the platform co-players and real NPCs are both `kind: "npc"` characters owned by the
// Keeper account; here they are kept apart, because they are given different context:
//   real NPC  – voiced by the GM model, shares the Keeper's whole context;
//   co-player – a fellow investigator with an LLM-made role card, sees only the chat log it could have witnessed.
// Co-players carry COPLAYER_MARK at the start of `speaking_style` so the split survives a lost state file.
export const COPLAYER_MARK = "[co-player]";

export const markStyle = (style) => `${COPLAYER_MARK} ${String(style ?? "").replace(COPLAYER_MARK, "").trim()}`.trim();
export const unmarkStyle = (style) => String(style ?? "").replace(COPLAYER_MARK, "").trim();
const norm = (s) => String(s ?? "").trim().toLowerCase();

export class Roster {
  constructor({ coplayers = [], npcs = [] } = {}) {
    this.coplayers = coplayers;
    this.npcs = npcs;
  }

  toJSON() { return { coplayers: this.coplayers, npcs: this.npcs }; }

  isCoplayer(characterId) { return this.coplayers.some((c) => c.characterId === characterId); }
  isNpc(characterId) { return this.npcs.some((c) => c.characterId === characterId); }
  coplayersIn(windowId) { return this.coplayers.filter((c) => c.windows.includes(windowId)); }
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
        this.coplayers.push({ characterId: c.id, name: c.name, persona: c.bio ?? "", speakingStyle: unmarkStyle(c.speaking_style), windows: [...defaultWindows] });
      } else {
        this.npcs.push({ characterId: c.id, name: c.name, brief: c.bio || c.description || "" });
      }
    }
    return this;
  }
}
