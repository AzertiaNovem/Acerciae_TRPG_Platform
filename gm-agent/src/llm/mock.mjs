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
      case "coplayer_repair": return JSON.stringify(this.card(user, "coplayer"));
      case "coplayer_points": return JSON.stringify(this.points(user));
      case "director": return JSON.stringify(this.director(user));
      case "coplayer_turn": return JSON.stringify(this.coplayer(user));
      default: return "{}";
    }
  }

  card(user, kind) {
    const taken = field(user, "TAKEN NAMES").split(",").map((s) => s.trim());
    const i = Math.max(0, this.calls.filter((c) => c.purpose === `${kind}_card`).length - 1);
    const name = field(user, "NPC NAME") || NAMES.find((n) => !taken.includes(n)) || `Investigator ${i + 1}`;
    const n = (base) => base + ((i * 7) % 20);
    const catalog = JSON.parse(field(user, 'CAREERS') || '[]');
    const career = (catalog.find((c) => c.name === '会计师') ?? catalog[0])?.name;
    return {
      name,
      persona: `[mock] ${name} is curious, careful and loyal to the group.`,
      speaking_style: "plain, polite, short sentences",
      appearance_prompt: "[mock] Adult investigator in a tidy 1920s wool coat, short dark hair, ink-stained fingers, round spectacles.",
      role_card: {
        ...(career ? { career: { name: career, choices: [], specialties: [] } } : {}),
        basic: { player: 'AI co-player', occupation: CAREERS[i % CAREERS.length], age: String(28 + i * 3), sex: i % 2 ? "male" : "female", residence: "Arkham", birthplace: "Boston" },
        characteristics: { STR: n(45), CON: n(50), SIZ: n(55), DEX: n(60), APP: n(50), INT: n(65), POW: n(55), EDU: n(70), LUK: n(50) },
        skills: { "Spot Hidden": 60, "Library Use": 55, Psychology: 45, Persuade: 40, "Fighting (Brawl)": 35, Dodge: 40 },
        background: { personal_description: "[mock] tidy coat, ink-stained fingers", ideology: "[mock] the truth matters", traits: "[mock] stubborn", significant_people: '[mock] family', meaningful_locations: '[mock] home', treasured_possessions: '[mock] notebook', injuries: 'None', phobias: 'None', arcane: 'None', encounters: 'None' },
        items: [{ name: "Notebook", note: "", qty: 1 }, { name: "Flashlight", note: "", qty: 1 }],
        wealth: { cash: "$20", assets: "$500", spending_level: "$10" },
      },
    };
  }

  points(user) {
    const rules = JSON.parse(field(user, 'RULES'));
    const card = JSON.parse(field(user, 'EXISTING CARD'));
    const concrete = (e) => e.spec ? `${e.skill} (${e.spec})` : e.any ? `${e.skill} (Mock specialty)` : e.skill;
    const choices = rules.career.choices.map((g) => g.from.slice(0, g.pick).map(concrete));
    const fixed = [...new Set(['Credit Rating', ...rules.career.fixed.map(concrete), ...choices.flat()])];
    const specialties = rules.skills.map((s) => s.name).filter((n) => !fixed.includes(n) && n !== 'Cthulhu Mythos').slice(0, rules.career.free);
    const points = {};
    const base = (name) => {
      const raw = rules.skills.find((s) => s.name === name)?.base ?? rules.families.find((f) => name.startsWith(f.name + ' ('))?.base ?? 0;
      return raw === 'DEX/2' ? Math.floor(card.characteristics.DEX / 2) : raw === 'EDU' ? card.characteristics.EDU : Number(raw);
    };
    points['Credit Rating'] = { career: rules.career.credit?.[0] ?? 0, hobby: 0 };
    const spend = (budget, type, names) => {
      let left = budget;
      while (left > 0) {
        let used = 0;
        for (const name of names) {
          const p = points[name] ??= { career: 0, hobby: 0 };
          const growth = card.skill_points?.[name]?.growth ?? 0;
          const cap = name === 'Credit Rating' ? rules.career.credit?.[1] ?? 99 : 99;
          if (base(name) + p.career + p.hobby + growth < cap && left > 0) { p[type]++; left--; used++; }
        }
        if (!used) break;
      }
    };
    spend(rules.career_budget - points['Credit Rating'].career, 'career', [...fixed, ...specialties]);
    spend(rules.hobby_budget, 'hobby', rules.skills.map((s) => s.name).filter((n) => n !== 'Cthulhu Mythos' && n !== 'Credit Rating'));
    return { career: { name: rules.career.name, choices, specialties }, skill_points: points };
  }

  // Deterministic stand-ins for the Keeper's judgement: "I go to the X" sends the speaker to a new place, "I go back"
  // brings them back to the main story, "next morning" asks for the next scenario.
  director(user) {
    const last = field(user, "NEWEST LINE") || "the silence";
    if (field(user, "KICKOFF")) return { actions: [{ type: "narrate", text: "[mock Keeper] The rain drums on the station roof as your train pulls in. What do you do?" }], coplayers_may_act: true };
    const actions = [{ type: "narrate", text: `[mock Keeper] You consider ${JSON.stringify(last.slice(0, 80))}. The lamp flickers; something waits in the dark.` }];
    const whereabouts = [];
    const m = last.match(/^(.+?): (.*)$/);
    const mode = (user.match(/^MODE: (\w+)/m) ?? [])[1] ?? "human";
    if (m && ["human", "relay"].includes(mode)) {
      const [, speaker, text] = m;
      const going = text.match(/\bI (?:go|head|walk|drive|run) to (?:the )?([^.,!?]+)/i);
      if (/\bI (?:go|head|walk) back\b|\bback to the others\b/i.test(text)) whereabouts.push({ who: [speaker], thread: "T0" });
      else if (going) whereabouts.push({ who: [speaker], thread: "new", place: going[1].trim(), own_scene: true, span: /\bcity|train|abroad\b/i.test(text) ? "long" : "short", opening: `[mock Keeper] ${going[1].trim()}: fog, and a single lamp.` });
      if (/\bnext morning\b/i.test(text)) actions.push({ type: "advance_scenario", title: "The next morning", location: "", narrative_time: "next morning", reason: "a night passes" });
    }
    return { actions, coplayers_may_act: true, ...(whereabouts.length ? { whereabouts } : {}) };
  }

  coplayer(user) {
    const me = field(user, "YOU ARE");
    const last = field(user, "NEWEST LINE");
    if (!last) return { action: "pass" };
    return { action: "speak", kind: "ic", text: `[mock ${me}] I stay close and keep my eyes open.` };
  }
}
