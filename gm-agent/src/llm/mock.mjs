// A deterministic offline model: it shows every pipeline end to end without a provider and records each request, so
// tests can check what each role was (and was not) shown. Its writing is placeholder text, clearly labelled.
import { partsOf, textOf } from "./parts.mjs";

const NAMES = ["Harriet Vance", "Tomas Leclerc", "Mei Okada", "Arthur Penhallow", "Rosa Delgado", "Ivan Sorokin", "Edith Crane", "Samuel Achebe"];
const CAREERS = ["Antiquarian", "Journalist", "Doctor of Medicine", "Private Investigator", "Professor", "Police Detective", "Author", "Nurse"];

const field = (text, label) => (String(text).match(new RegExp(`^${label}:\\s*(.+)$`, "m")) ?? [])[1]?.trim() ?? "";

// Keep the offline fixtures expressed as game actions. Emit their prose as a draft and carry the
// remaining fixture decisions in a mock-only direction, so the real paragraph binding still runs.
function draftFor(plan) {
  const paragraphs = [];
  const part = (text, label = "") => {
    if (!String(text ?? "").trim()) return undefined;
    const rows = String(text).trim().split(/\n\s*\n/);
    const ids = rows.map(row => paragraphs.push(label ? `${label}: ${row}` : row));
    return ids.length === 1 ? ids[0] : ids;
  };
  const label = a => ({
    npc: `NPC ${a.name}`, new_npc: `New NPC ${a.name}`, whisper: `Whisper to ${a.to}`,
    note: "GM only", text: `Phone from ${a.from} to ${a.to}`,
  })[a.type];
  const withOpening = a => a.opening ? { ...a, opening: part(a.opening, "Opening") } : a;
  const sourced = new Set(["narrate", "npc", "new_npc", "whisper", "note", "text", "request_roll", "ask", "dice"]);
  plan = { ...plan, actions: plan.actions.map(a => sourced.has(a.type) ? { ...a, text: part(a.text, label(a)) } : withOpening(a)) };
  if (plan.whereabouts) plan.whereabouts = plan.whereabouts.map(withOpening);
  paragraphs.push(`Table directions: ${JSON.stringify(plan)}`);
  return paragraphs.join("\n\n");
}

export class MockLlm {
  constructor() { this.calls = []; this.mock = true; }

  async complete({ system, messages, purpose, onUsage }) {
    // Recorded as plain text (parts joined), with the cache marks kept apart for tests of the layout.
    this.calls.push({ purpose, system, messages: messages.map((m) => ({ role: m.role, content: textOf(m.content) })), parts: messages.map((m) => partsOf(m.content).map((p) => ({ text: p.text, cache: Boolean(p.cache) }))) });
    const user = messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
    const chars = system.length + user.length;
    onUsage?.({ model: "mock", estimated: true, input: Math.ceil(chars / 3.5), cacheRead: 0, cacheWrite: 0, output: 50 });
    switch (purpose) {
      case "pbta_design": {
        const {template:pack,public_world:world}=JSON.parse(messages[0].content);
        for (const move of pack.moves) move.playerChoiceBands=[];
        // As many playbooks as the design asks for (one per character plus spares for the human players).
        const want=Number(system.match(/Design at least (\d+) playbooks/)?.[1] ?? 0);
        for (let i=pack.books.length;i<want;i++) pack.books.push({id:`mockbook${i+1}`,name:`[mock] Playbook ${i+1}`});
        pack.name="[mock] "+world.slice(0,24);
        return JSON.stringify({pack,reasons:["[mock] Preview the world's title before setup.","[mock] The starter moves exercise both rolled and diceless play."]});
      }
      case "pbta_card": {
        const {books,stats,existing,partySize}=JSON.parse(messages[0].content);
        const index = partySize + (messages.length > 1 ? 1 : 0);
        return JSON.stringify({name:existing?.name || NAMES[index] || "Mock player "+index,
          persona:"[mock] A member of the crew.",speaking_style:"[mock] Direct",role_card:{pbta:{book:books[0].id,stats:{[stats[0].id]:1},resources:{},conditions:{}}}});
      }
      case "npc_card": return JSON.stringify(this.card(user, "npc"));
      case "coplayer_points": return JSON.stringify(this.points(user));
      case "placement_correction": return JSON.stringify(this.placementCorrection(JSON.parse(messages[0].content)));
      case "movement_evidence": return JSON.stringify(this.movements(JSON.parse(messages[0].content)));
      case "scene_presence": return JSON.stringify(this.presence(JSON.parse(messages[0].content)));
      case "scene_handoff": return JSON.stringify(this.handoff(JSON.parse(messages[0].content)));
      case "coplayer_build": return JSON.stringify({ dnd: this.dndBuild() });
      case "scenario_illustration": return JSON.stringify(this.scenarioMoment(user));
      case "event_illustration": return JSON.stringify({ ...this.scenarioMoment(user), moment: this.scenarioMoment(user).moment.replace("[mock moment]", "[mock event]") });
      case "plot_search": return JSON.stringify(this.plotChoose(user));
      case "plot_illustration": return JSON.stringify(this.plotMoment(user));
      case "director": return draftFor(this.director(user));
      case "chat_format": return JSON.parse(messages[0].content).findLast(p => p.kind === "directions")?.text ?? "{}";
      case "planner": return JSON.stringify(this.planner(user));
      case "compact": return JSON.stringify({ summary: `[mock ${purpose}] ${field(user, "LINES") || field(user, "CHAPTERS") || "(nothing)"}`.slice(0, 400) });
      default: return "{}";
    }
  }

  // A past plot a player asked for: the request's long words stand for its meaning. The entries (or parts) that contain
  // one are chosen; with none, the scenarios (a model would guess the story's stage). The moment is the first line of
  // play that has one of them, or none.
  plotWords(user) { return (user.match(/^THE PLAYER'S REQUEST: (.*)$/m)?.[1] ?? "").toLowerCase().split(/[\s,.;:!?，。；：！？]+/).filter((w) => w.length >= 6); }
  plotChoose(user) {
    const words = this.plotWords(user);
    const entries = [...user.matchAll(/^([SCRP]\d+) \[.*$/gm)].map((m) => ({ key: m[1], text: m[0].toLowerCase() }));
    const named = entries.filter((e) => words.some((w) => e.text.includes(w))).map((e) => e.key);
    return { entries: (named.length ? named : entries.filter((e) => e.key.startsWith("S")).map((e) => e.key)).slice(0, 3), why: "[mock] the entries that name it" };
  }
  plotMoment(user) {
    const words = this.plotWords(user);
    const play = (user.split(/\nPLAY[^\n]*\(oldest first\):\n/)[1] ?? "").trim().split("\n");
    const line = play.find((l) => words.some((w) => l.toLowerCase().includes(w)));
    if (!line) return { found: false };
    const cast = (user.match(/^CAST: (.*)$/m)?.[1] ?? "").split(", ").filter((n) => n && n !== "(none named)");
    return { found: true, moment: `[mock picture] ${line.replace(/^[^:]*: /, "").slice(0, 200)}`, who: cast.slice(0, 1), orientation: "landscape", why: "[mock] the line the request names" };
  }

  // The best moment of a scenario: its last line of play, with the first character of the cast in it.
  scenarioMoment(user) {
    const play = (user.split("PLAY (oldest first):\n")[1] ?? "").trim().split("\n");
    const cast = (user.match(/^CAST: (.*)$/m)?.[1] ?? "").split(", ").filter((n) => n && n !== "(none named)");
    // Outfitted characters: each in the first outfit listed (in the picture when they are in the cast's first place).
    const outfits = Object.fromEntries([...user.matchAll(/^- (.+?) \(wears now: [^\n]*?\): "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
    return { moment: `[mock moment] ${(play.at(-1) ?? "").replace(/^[^:]*: /, "").slice(0, 200)}`, who: [...new Set([...cast.slice(0, 1), ...Object.keys(outfits)])], orientation: "landscape", outfits, why: "[mock] the last line" };
  }

  // A legal D&D 2024 build (27 points): a level-1 Elf Rogue with the Criminal background.
  dndBuild() {
    return {
      class: "Rogue", subclass: "", species: "Elf", background: "Criminal", method: "point_buy",
      base: { STR: 8, DEX: 15, CON: 14, INT: 12, WIS: 13, CHA: 10 }, increases: { DEX: 2, CON: 1 },
      skills: { "Sleight of Hand": 2, Stealth: 2, Acrobatics: 1, Deception: 1, Insight: 1, Perception: 1, Survival: 1 },
      features: "[mock] Expertise, Sneak Attack 1d6, Thieves' Cant; Darkvision, Fey Ancestry, Keen Senses", spells: "",
    };
  }

  card(user, kind) {
    const taken = field(user, "TAKEN NAMES").split(",").map((s) => s.trim());
    const i = Math.max(0, this.calls.filter((c) => c.purpose === `${kind}_card`).length - 1);
    const name = field(user, "NPC NAME") || NAMES.find((n) => !taken.includes(n)) || `Investigator ${i + 1}`;
    const n = (base) => base + ((i * 7) % 20);
    if (/^DND BUILD RULES/m.test(user)) {
      return {
        name, persona: `[mock] ${name} is quick, wry and loyal to the party.`, speaking_style: "plain, quick, short sentences",
        appearance_prompt: "[mock] Slender elf in a dark leather jerkin, braided black hair, a hooded cloak, daggers at the belt.",
        role_card: {
          basic: { player: kind === "npc" ? "NPC" : "GM", occupation: "Rogue", age: String(24 + i * 3), sex: i % 2 ? "male" : "female", residence: "the harbour quarter", birthplace: "the hill villages" },
          background: { personal_description: "[mock] slender, quick hands", ideology: "[mock] freedom over law", significant_people: "[mock] a sister in the thieves' guild", meaningful_locations: "[mock] the old mill", treasured_possessions: "[mock] a lockpick set", traits: "[mock] reckless, loyal", injuries: "None", phobias: "None", arcane: "None", encounters: "None" },
          items: [{ name: "Leather armour", note: "AC 11 + DEX", qty: 1 }, { name: "Dagger", note: "", qty: 2 }, { name: "Thieves' tools", note: "", qty: 1 }],
          wealth: { cash: "15 gp", assets: "a room above the tavern", spending_level: "modest" },
          dnd: { ...this.dndBuild(), ac: 14 },
        },
      };
    }
    const catalog = JSON.parse(field(user, 'CAREERS') || '[]');
    const career = (catalog.find((c) => c.name === '会计师') ?? catalog[0])?.name;
    return {
      name,
      persona: `[mock] ${name} is curious, careful and loyal to the group.`,
      speaking_style: "plain, polite, short sentences",
      appearance_prompt: "[mock] Adult investigator in a tidy 1920s wool coat, short dark hair, ink-stained fingers, round spectacles.",
      role_card: {
        ...(career ? { career: { name: career, choices: [], specialties: [] } } : {}),
        basic: { player: 'GM', occupation: CAREERS[i % CAREERS.length], age: String(28 + i * 3), sex: i % 2 ? "male" : "female", residence: "Arkham", birthplace: "Boston" },
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

  // Offline movement fixtures understand explicit English departures and following a named companion.
  movements({ actors, lines, destinations }) {
    const moves = [];
    for (const actor of actors) {
      for (const line of lines.filter(l => actor.sources.includes(l.seq)).reverse()) {
        const going = line.text.match(/\bI (?:go|head|walk|drive|run) to (?:the )?([^.,!?]+)/i);
        const back = /\bI (?:go|head|walk) back\b/i.test(line.text);
        const follow = line.text.match(/\bI follow (\w+)/i);
        if (!going && !back && !follow) continue;
        const dest = destinations.find(d => back ? d.key === "T0" : going ? d.place?.toLowerCase() === going[1].trim().toLowerCase() : d.companions?.some(n => n.split(" ")[0] === follow[1]));
        if (dest) moves.push({ id: actor.id, destination: dest.key, seq: line.seq });
        break;
      }
    }
    return { moves };
  }

  placementCorrection() { return { moves: [] }; }
  presence() { return { placements: [] }; }
  handoff() { return { summary: "", source_seqs: [] }; }

  // Deterministic stand-ins for the GM's judgement: "I go to the X" sends the speaker to a new place, "I go back"
  // brings them back to the main story, "next morning" asks for the next scenario.
  director(user) {
    const last = field(user, "NEWEST LINE") || "the silence";
    const phone = user.match(/^MODE: phone — (.+?) texted (.+?) on their phone/m);
    if (phone) return { actions: [{ type: "text", from: phone[2], to: phone[1], text: `[mock ${phone[2]}] Got your message.`, delay_minutes: 1 }], coplayers_may_act: false };
    if (field(user, "KICKOFF")) return { actions: [{ type: "narrate", text: "[mock GM] The rain drums on the station roof as your train pulls in. What do you do?" }], coplayers_may_act: true };
    const actions = [{ type: "narrate", text: `[mock GM] You consider ${JSON.stringify(last.slice(0, 80))}. The lamp flickers; something waits in the dark.` }];
    const whereabouts = [];
    const m = last.match(/^(.+?): (.*)$/);
    const mode = (user.match(/^MODE: (\w+)/m) ?? [])[1] ?? "human";
    if (m && ["human", "relay"].includes(mode)) {
      const [, speaker, text] = m;
      const going = text.match(/\bI (?:go|head|walk|drive|run) to (?:the )?([^.,!?]+)/i);
      if (/\bI (?:go|head|walk) back\b|\bback to the others\b/i.test(text)) whereabouts.push({ who: [speaker], thread: "T0" });
      else if (going) whereabouts.push({ who: [speaker], thread: "new", place: going[1].trim(), own_scene: true, span: /\bcity|train|abroad\b/i.test(text) ? "long" : "short", opening: `[mock GM] ${going[1].trim()}: fog, and a single lamp.` });
      // "That settles it": a small event ends (its picture is drawn when pictures are on).
      if (/\bthat settles it\b/i.test(text)) actions.push({ type: "event_done", text: `[mock] what ${speaker} settled` });
      if (/\bnext morning\b/i.test(text)) actions.push({ type: "advance_scenario", title: "The next morning", location: "", narrative_time: "next morning", reason: "a night passes" });
    }
    return { actions, coplayers_may_act: true, ...(whereabouts.length ? { whereabouts } : {}) };
  }

  // The story planner's three steps, told apart by the STEP line of the newest request; tests overwrite this.
  planner(user) {
    const step = (user.match(/^STEP: (\w+)/gm) ?? []).at(-1)?.slice(6) ?? "draft";
    if (step === "critique") return { boring: [], implausible: [], contradictions: [], stale: [], merge: [], beat_done: null, must_fix: [] };
    const pace = /pace only|Do not invent plots/.test(user);
    const beat = { title: "[mock beat] The present trouble", purpose: "let the investigators commit to a course", exit: "someone acts on what they learned" };
    // The first date when none is set; a final review moves the calendar on two days and acts off-screen.
    const routine = { routine: "[mock routine] The herring season: the boats go out before dawn and the fish market is loud every morning.", upcoming: [{ when: "next Saturday", what: "[mock] the Harbour Fair on the quay" }] };
    const calendar = { ...(/Today in the story: no date set yet/.test(user) ? { start: "1923-10-02", time: "early morning" } : {}), advice: "[mock] let a night pass after the docks", ...routine };
    const final = /This is the FINAL REVIEW/.test(user);
    // The players' words in the planner window: "never", "not" or "no" make a correction, anything else a wish.
    const wordsAt = user.indexOf("## The players' words to you");
    const words = (wordsAt < 0 ? "" : user.slice(user.indexOf("\n", wordsAt) + 1).split("\n\n")[0]).split("\n").map((l) => l.replace(/^- [^:]+: /, "").trim()).filter(Boolean);
    const table = /"table_notes"/.test(user) ? { table_notes: words.map((w) => ({ id: "new", kind: /\b(never|not|no)\b/i.test(w) ? "correction" : "wish", text: `[mock note] ${w}`, about: (w.match(/\b(Alice Hale|Alice)\b/) ?? []).slice(0, 1).map(() => "Alice Hale") })), reply: words.length ? `[mock reply] Noted ${words.length} line(s): the story will follow.` : "" } : {};
    const between = final ? { advance_days: 2, time: "morning", why: "[mock] the town sleeps on it", ...(pace ? {} : { offscreen: [{ text: "[mock offscreen] The Guild doubled the night watch at the docks.", secret: true }] }), opening: "[mock opening] A knock at the door at dawn.", recap: "[mock recap] They asked around the harbour." } : undefined;
    if (pace) return { beat, verdict: { move_on: false, why: "the scene is still fresh" }, played: "[mock] as planned", changed: step === "revise" ? "[mock] nothing" : "", calendar, ...table, ...(between ? { between } : {}) };
    return {
      throughline: "[mock] a town that hides what the sea brings in",
      threads: [{ id: "P1", title: "[mock] The night boats", status: "live", stakes: "who profits", hooks: ["a sailor talks"], twist: "[mock twist] the Guild lands cargo at the lighthouse", ripe_when: "the investigators reach the docks at night", weave_with: null }],
      beat, next: [{ what: "[mock] a stranger offers a boat ride", when: "after the docks" }],
      verdict: { move_on: false, why: "the scene is still fresh" },
      played: "[mock] as planned", changed: step === "revise" ? "[mock] nothing" : "", calendar, ...table, ...(between ? { between } : {}),
    };
  }
}
