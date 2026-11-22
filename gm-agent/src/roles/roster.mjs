// The client's own cast: the characters the GM voices with the GM model, sharing the GM's whole context (real NPCs).
// They are every `kind: "npc"` character, the ones the GM made by hand included, and every PC the GM account owns
// (`castBy`): such a PC is played like an NPC until it is handed to a player or to one of the platform's bots
// (`bots handoff`), when it becomes that player's character. Older versions played those PCs, and NPCs marked
// "[co-player]" at the start of `speaking_style`, as AI co-players; they are real NPCs now, and an older state file's
// `coplayers` (their seats and personas) is left in the file for `bots handoff` and never read here.
export class Roster {
  constructor({ npcs = [] } = {}) {
    this.npcs = Array.isArray(npcs) ? npcs : [];
  }

  toJSON() { return { npcs: this.npcs }; }

  isNpc(characterId) { return this.npcs.some((c) => c.characterId === characterId); }
  npcByName(name) { return this.npcs.find((c) => norm(c.name) === norm(name)); }

  // Brings the roster in line with the channel's characters: forgets deleted ones and those no longer the GM's (a PC
  // handed to someone), and picks up every character the GM voices.
  reconcile(characters, { castBy = null } = {}) {
    const byId = new Map(characters.map((c) => [c.id, c]));
    const voiced = (c) => Boolean(c) && (c.kind === "npc" || (c.kind === "pc" && Boolean(castBy) && c.user_id === castBy));
    this.npcs = this.npcs.filter((n) => voiced(byId.get(n.characterId)));
    for (const c of characters) {
      if (!voiced(c)) continue;
      const entry = this.npcs.find((x) => x.characterId === c.id);
      if (entry) { entry.name = c.name; continue; }
      this.npcs.push({ characterId: c.id, name: c.name, brief: c.bio || c.description || "" });
    }
    return this;
  }
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

// A player character: a PC someone else plays (a person, or one of the platform's bots), not one the GM voices.
export const isPlayerCharacter = (character, roster) => character?.kind === "pc" && !roster.isNpc(character.id);
