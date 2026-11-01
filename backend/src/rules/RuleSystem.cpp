#include "RuleSystem.h"

namespace acerciae::rules {

namespace {
const Profile kCoc{
    "coc7e", "Call of Cthulhu 7th edition (Basic Roleplaying)", "Keeper", "KP",
    "BRP/CoC: players declare intent; the Keeper adjudicates success. Characters only know what they witnessed or were told.",
    false};
const Profile kDnd{
    "dnd2024", "a fifth-edition fantasy roleplaying game (D&D 2024 rules, System Reference Document 5.2)", "Dungeon Master", "DM",
    "5e (2024 SRD): players declare intent; the Dungeon Master calls for D20 Tests (ability checks, saving throws, attack "
    "rolls) against a Difficulty Class or Armor Class, with Advantage or Disadvantage. Characters only know what they "
    "witnessed or were told. Hit Points, spell slots and conditions are tracked; combat runs in initiative order.",
    true};

void replaceAll(std::string& s, const std::string& from, const std::string& to) {
    for (size_t pos = s.find(from); pos != std::string::npos; pos = s.find(from, pos + to.size())) s.replace(pos, from.size(), to);
}
} // namespace

bool valid(const std::string& id) { return id == kCoc.id || id == kDnd.id; }
std::string canonical(const std::string& id) {
    if (valid(id)) return id;
    if (id == "coc7" || id == "coc" || id == "brp") return kCoc.id;
    return "";
}
const Profile& profile(const std::string& id) { return id == kDnd.id ? kDnd : kCoc; }

std::string adapt(std::string prompt, const Profile& p) {
    if (p.dnd) {
        // The prompts are written for Call of Cthulhu; in a D&D channel the game and the GM get their D&D names.
        replaceAll(prompt, "Call of Cthulhu / BRP", "{GAME}");
        replaceAll(prompt, "BRP/CoC", "5e");
        replaceAll(prompt, "Keeper", "{GM}");
        replaceAll(prompt, "KP(", "{GM_SHORT}(");
    }
    replaceAll(prompt, "{GAME}", p.game);
    replaceAll(prompt, "{GM_SHORT}", p.gmShort);
    replaceAll(prompt, "{GM}", p.gm);
    return prompt;
}

} // namespace acerciae::rules
