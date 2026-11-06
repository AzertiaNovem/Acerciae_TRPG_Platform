// The rule system a channel plays by: Call of Cthulhu 7e (`coc7e`, the default), D&D 2024 (`dnd2024`), or PbtA (`pbta`). A profile
// carries everything that differs between them in this client: the words the prompts use, the game's framing, the
// dice commands each role may use, how role cards are written and checked, what a co-player reads of its own sheet,
// and which characteristics count as striking. The table and `setup` choose one from `channel.rule_system`; the rest
// of the client reads the profile and never names a system itself.
import { COC7E } from "./coc7e.mjs";
import { DND2024 } from "./dnd2024.mjs";
import { PBTA } from "./pbta.mjs";

export const RULE_SYSTEMS = ["coc7e", "dnd2024", "pbta"];
const PROFILES = { coc7e: COC7E, dnd2024: DND2024, pbta: PBTA };

export const ruleSystemOf = (channel) => (RULE_SYSTEMS.includes(channel?.rule_system) ? channel.rule_system : "coc7e");

export function rulesProfile(id = "coc7e") {
  const p = PROFILES[id];
  if (!p) throw new Error(`unknown rule system "${id}" (${RULE_SYSTEMS.join(", ")})`);
  return p;
}

// A one-shot word swap for large static prompts written with the CoC words (the director's, the planner's): the
// identity for CoC, so its text is untouched. The GM is "GM" in every system, so the prompts say "GM" as written;
// what still differs per system is the game's name and the player characters' (investigators, adventurers,
// characters). Only ever applied to prompt text this client wrote, never to the chat or the context, where
// "investigator" may be anyone's word.
export function adaptPrompt(profile, text) {
  if (!profile || profile.id === "coc7e") return text;
  const v = profile.vocab;
  return String(text)
    .replace(/Call of Cthulhu 7th edition/g, v.game)
    .replace(/\binvestigators\b/g, v.pcs).replace(/\binvestigator\b/g, v.pc)
    .replace(/\bInvestigators\b/g, v.pcs.charAt(0).toUpperCase() + v.pcs.slice(1)).replace(/\bInvestigator\b/g, v.pc.charAt(0).toUpperCase() + v.pc.slice(1));
}
