// A deterministic offline model: it shows every pipeline end to end without a provider and records each request, so
// tests can check what each role was (and was not) shown. Its writing is placeholder text, clearly labelled.
const NAMES = ["Harriet Vance", "Tomas Leclerc", "Mei Okada", "Arthur Penhallow", "Rosa Delgado", "Ivan Sorokin", "Edith Crane", "Samuel Achebe"];
const CAREERS = ["Antiquarian", "Journalist", "Doctor of Medicine", "Private Investigator", "Professor", "Police Detective", "Author", "Nurse"];

const field = (text, label) => (String(text).match(new RegExp(`^${label}:\\s*(.+)$`, "m")) ?? [])[1]?.trim() ?? "";

export class MockLlm {
  constructor() { this.calls = []; this.mock = true; }

  async complete({ system, messages, purpose }) {
    this.calls.push({ purpose, system, messages: structuredClone(messages) });
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    switch (purpose) {
      case "coplayer_card": return JSON.stringify(this.card(user, "coplayer"));
      case "npc_card": return JSON.stringify(this.card(user, "npc"));
      case "director": return JSON.stringify(this.director(user));
      case "coplayer_turn": return JSON.stringify(this.coplayer(user));
      default: return "{}";
    }
  }

  card(user, kind) {
    const taken = field(user, "TAKEN NAMES").split(",").map((s) => s.trim());
    const i = this.calls.filter((c) => c.purpose === `${kind}_card`).length - 1;
    const name = field(user, "NPC NAME") || NAMES.find((n) => !taken.includes(n)) || `Investigator ${i + 1}`;
    const n = (base) => base + ((i * 7) % 20);
    return {
      name,
      persona: `[mock] ${name} is curious, careful and loyal to the group.`,
      speaking_style: "plain, polite, short sentences",
      role_card: {
        basic: { occupation: CAREERS[i % CAREERS.length], age: String(28 + i * 3), sex: i % 2 ? "male" : "female", residence: "Arkham", birthplace: "Boston" },
        characteristics: { STR: n(45), CON: n(50), SIZ: n(55), DEX: n(60), APP: n(50), INT: n(65), POW: n(55), EDU: n(70), LUK: n(50) },
        skills: { "Spot Hidden": 60, "Library Use": 55, Psychology: 45, Persuade: 40, "Fighting (Brawl)": 35, Dodge: 40 },
        background: { personal_description: "[mock] tidy coat, ink-stained fingers", ideology: "[mock] the truth matters", traits: "[mock] stubborn" },
        items: [{ name: "Notebook", note: "", qty: 1 }, { name: "Flashlight", note: "", qty: 1 }],
        wealth: { cash: "$20", assets: "$500", spending_level: "$10" },
      },
    };
  }

  director(user) {
    const last = field(user, "NEWEST LINE") || "the silence";
    if (field(user, "KICKOFF")) return { actions: [{ type: "narrate", text: "[mock Keeper] The rain drums on the station roof as your train pulls in. What do you do?" }], coplayers_may_act: true };
    return {
      actions: [{ type: "narrate", text: `[mock Keeper] You consider ${JSON.stringify(last.slice(0, 80))}. The lamp flickers; something waits in the dark.` }],
      coplayers_may_act: true,
    };
  }

  coplayer(user) {
    const me = field(user, "YOU ARE");
    const last = field(user, "NEWEST LINE");
    if (!last) return { action: "pass" };
    return { action: "speak", kind: "ic", text: `[mock ${me}] I stay close and keep my eyes open.` };
  }
}
