// The rule system a channel plays by: Call of Cthulhu 7e (`coc7e`, the default) or D&D 2024 (`dnd2024`). A profile
// carries everything that differs between them in this client: the words the prompts use, the game's framing, the
// dice commands each role may use, how role cards are written and checked, what a co-player reads of its own sheet,
// and which characteristics count as striking. The table and `setup` choose one from `channel.rule_system`; the rest
// of the client reads the profile and never names a system itself.
import { COC7E } from "./coc7e.mjs";
import { DND2024 } from "./dnd2024.mjs";

export const RULE_SYSTEMS = ["coc7e", "dnd2024"];
const PROFILES = { coc7e: COC7E, dnd2024: DND2024 };

export const ruleSystemOf = (channel) => (channel?.rule_system === "dnd2024" ? "dnd2024" : "coc7e");

export function rulesProfile(id = "coc7e") {
  const p = PROFILES[id];
  if (!p) throw new Error(`unknown rule system "${id}" (${RULE_SYSTEMS.join(", ")})`);
  return p;
}

// A one-shot word swap for large static prompts written with the CoC words (the planner's, the memory's): the
// identity for CoC, so its text is untouched. Only ever applied to prompt text this client wrote, never to the
// chat or the context, where "Keeper" may be anyone's word.
export function adaptPrompt(profile, text) {
  if (!profile || profile.id === "coc7e") return text;
  const v = profile.vocab;
  return String(text)
    .replace(/Call of Cthulhu 7th edition/g, v.game)
    .replace(/\bKeeper's\b/g, `${v.gm}'s`).replace(/\bKeeper\b/g, v.gm).replace(/\bKP\b/g, v.gmShort)
    .replace(/\binvestigators\b/g, v.pcs).replace(/\binvestigator\b/g, v.pc)
    .replace(/\bInvestigators\b/g, v.pcs.charAt(0).toUpperCase() + v.pcs.slice(1)).replace(/\bInvestigator\b/g, v.pc.charAt(0).toUpperCase() + v.pc.slice(1));
}
