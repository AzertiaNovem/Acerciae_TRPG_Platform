#pragma once
#include <json/json.h>
#include <string>
#include <vector>

// COC7 point-buy rules (server feature `coc7_points`): the career list from the community character sheet, the
// career and hobby skill-point budgets, and the validation of a role card that spends them.
namespace acerciae::coc7 {
extern const char* kCareersJson;   // generated: scripts/coc7_careers.py

struct Career {
    int id = 0;
    std::string name;                 // as the sheet names it (Chinese)
    int creditMin = -1, creditMax = -1;
    Json::Value points;               // [{attrs:["EDU"], mult:4}, {attrs:["STR","DEX"], mult:2}] — "或" = best of
    std::string formula;              // the sheet's text, e.g. 教育×2＋力量或敏捷×2
    Json::Value fixed;                // [{skill (canonical), any?, spec?}]
    Json::Value choices;              // [{pick, from:[{skill, any?, spec?}]}]
    int free = 0;                     // 任意特长: skills of the player's choice that take career points
    std::string description;
};

const std::vector<Career>& careers();
const Career* findCareer(const std::string& name);
// What the client needs to build a card: skills with bases, specialisation families and every career.
const Json::Value& rules();

// "Science (Biology)" → "Science"; a plain skill → its canonical name.
std::string family(const std::string& key);
// Base value of a skill for these characteristics (Dodge = DEX/2, Language (Own) = EDU, specialisations by family;
// unknown skills use `customBase`).
int skillBase(const std::string& key, const Json::Value& characteristics, int customBase = 0);
int careerBudget(const Career& c, const Json::Value& characteristics);
int hobbyBudget(const Json::Value& characteristics);   // INT × 2

// Applies card.career and card.skill_points ({key: {career, hobby, growth, base?}}) to the card: every such skill's
// total becomes base + career + hobby + growth in card.skills. Returns the report
// {career, career_budget, career_spent, hobby_budget, hobby_spent, characteristics_total, luck, allowed:[...],
//  violations:[{code, skill?, message}], warnings:[...]}. The caller decides whether violations block the save.
Json::Value apply(Json::Value& card);
}
