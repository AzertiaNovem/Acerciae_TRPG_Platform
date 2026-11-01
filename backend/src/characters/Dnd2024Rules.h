#pragma once
#include <json/json.h>
#include <string>

// D&D 2024 character rules from the System Reference Document 5.2 (CC-BY-4.0, Wizards of the Coast; see
// docs/DND_2024.md for the attribution): the classes, species and backgrounds it contains, ability-score point buy
// and the standard array, background ability increases, spell slots by class and level, and the validation of the
// role card's `dnd` part when the channel's GM has turned point buy on.
namespace acerciae::dnd2024 {

// What the character sheet needs to build a card: classes {name, names{lang}, hit_die, saves[], skill_count,
// skills[] (empty = any), caster: full|half|pact|none}, species {name, names, speed, extra_skills, skill_from[]},
// backgrounds {name, names, abilities[3], skills[2]}, point_buy {budget, min, max, costs{score: cost}},
// standard_array[], slots {full|half: [[per level 1..9] for class levels 1..20], pact: [{slots, level}]},
// names of abilities and skills {key: {lang: name}}.
const Json::Value& rules();

// The role card's `dnd` part, bounded and typed; unknown keys are dropped.
Json::Value normalize(const Json::Value& dnd);
// Final ability scores: base + background increases + later improvements (capped at 30).
Json::Value scores(const Json::Value& dnd);
// The point-buy report for a card's `dnd` part: {method, budget, spent, scores{}, violations[{code, message}]}.
Json::Value check(const Json::Value& dnd);
// sheet.attrs after mirroring the build into it (scores, level, proficiencies, AC, HP Max, Speed, slot maxima). Live
// values the dice change (HP, Temp HP, slots left, death saves) are only filled in when missing.
Json::Value mirrorAttrs(const Json::Value& attrs, const Json::Value& dnd);

} // namespace acerciae::dnd2024
