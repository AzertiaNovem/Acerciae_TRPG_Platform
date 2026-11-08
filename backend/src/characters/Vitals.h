#pragma once
#include <json/json.h>
#include <string>

// The few numbers of a character that matter at the table, shown next to its name in every client: by rule system,
// Call of Cthulhu's HP, SAN and DEX, D&D's HP, AC and DEX, a PbtA playbook's resources and marked conditions.
namespace acerciae::vitals {

// `character`: a characters row (sheet.attrs for the dice values, role_card for the maxima and the PbtA sheet).
// `pbtaPack`: the channel's PbtA pack (names of resources and conditions), or null for the other systems.
// Returns {rule_system, ...}: coc7e {hp, hp_max, san, san_max, dex}; dnd2024 {hp, hp_max, ac, dex}; pbta
// {resources: [{id, name, value}], conditions: [{id, name}]} (the conditions that are on). A missing number is null.
Json::Value of(const Json::Value& character, const std::string& ruleSystem, const Json::Value& pbtaPack);

}  // namespace acerciae::vitals
