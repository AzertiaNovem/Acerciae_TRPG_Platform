#pragma once
#include "Dice.h"

// D&D 2024 (System Reference Document 5.2) for the dice engine: the names of abilities, saving throws, skills and the
// sheet values dice read, and the D20 Test commands of a D&D channel. Pure, like the rest of the engine.
//
// A character's attrs in a D&D channel (what .st sets and the sheet writes):
//   STR DEX CON INT WIS CHA        ability scores
//   "<Skill>" (Athletics …)        proficiency: 0 none, 1 proficient, 2 expertise
//   "<ABILITY> Save" (STR Save …)  saving-throw proficiency: 0 or 1
//   Level, Proficiency Bonus       the bonus follows the level unless set
//   HP, HP Max, Temp HP, AC, Speed, Initiative (an extra Initiative bonus)
//   Death Successes, Death Failures, "Slot N" / "Slot N Max" (spell slots left / per long rest, N = 1-9)
namespace acerciae::dice::dnd {

const std::vector<std::string>& abilities();                    // STR DEX CON INT WIS CHA
struct SkillDef { std::string name; std::string ability; };
const std::vector<SkillDef>& skills();                           // the 18 skills of the SRD with their abilities
// Canonical key for what a player typed, in English or any server language ("感知" -> "WIS", "力量豁免" -> "STR Save",
// "sigilo" -> "Stealth", "法术位1" -> "Slot 1"); "" when it is none of the known names.
std::string canonical(const std::string& raw);
std::string displayName(const std::string& key, const std::string& lang);   // "WIS" -> "感知" (zh-CN); unknown as is
// Every known key with its names per language, for the character sheet: {key: {lang: name}}.
Json::Value names();
// The stored spelling of `raw` in attrs (known names match by canonical key), or "" if absent.
std::string storedKey(const Json::Value& attrs, const std::string& raw);
AttrValue lookup(const Json::Value& attrs, const std::string& raw);

int modifier(int score);          // floor((score - 10) / 2)
int proficiencyBonus(int level);  // 2 at levels 1-4, … 6 at 17-20
int proficiencyOf(const Json::Value& attrs);   // "Proficiency Bonus" if set, else from Level (1 when unset)

// Runs .r .st and the D&D commands (.rc/.ra checks, .ri, .ds, .ss). .init needs the window's order and is run by the
// DiceService. `.ri` puts {"initiative": {name, total, tiebreak}} in the outcome detail for the service to store.
Outcome execute(const Command& cmd, const Context& ctx, const TextSet& texts, Rng& rng);
std::string preview(const Command& cmd, const Context& ctx, const TextSet& texts);

} // namespace acerciae::dice::dnd
