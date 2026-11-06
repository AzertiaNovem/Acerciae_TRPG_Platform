#include "RuleSystem.h"

namespace acerciae::rules {

namespace {
const Profile kCoc{
    "coc7e", "Call of Cthulhu 7th edition (Basic Roleplaying)", "GM", "GM",
    "BRP/CoC: players declare intent; the GM adjudicates success. Characters only know what they witnessed or were told.",
    false};
const Profile kPbta{
    "pbta", "a Powered by the Apocalypse game", "GM", "GM",
    "Describe the fiction first. When a move triggers, players roll or follow its diceless instructions. "
    "Read that move's outcome, including choices. Humans decide the fictional consequences; a low roll need not mean failure.", false};
const Profile kDnd{
    "dnd2024", "a fifth-edition fantasy roleplaying game (D&D 2024 rules, System Reference Document 5.2)", "GM", "GM",
    "5e (2024 SRD): players declare intent; the GM calls for D20 Tests (ability checks, saving throws, attack "
    "rolls) against a Difficulty Class or Armor Class, with Advantage or Disadvantage. Characters only know what they "
    "witnessed or were told. Hit Points, spell slots and conditions are tracked; combat runs in initiative order.",
    true};

void replaceAll(std::string& s, const std::string& from, const std::string& to) {
    for (size_t pos = s.find(from); pos != std::string::npos; pos = s.find(from, pos + to.size())) s.replace(pos, from.size(), to);
}
} // namespace

bool valid(const std::string& id) { return id == kPbta.id || id == kCoc.id || id == kDnd.id; }
std::string canonical(const std::string& id) {
    if (valid(id)) return id;
    if (id == "coc7" || id == "coc" || id == "brp") return kCoc.id;
    return "";
}
const Profile& profile(const std::string& id) { return id == kPbta.id ? kPbta : id == kDnd.id ? kDnd : kCoc; }

std::string adapt(std::string prompt, const Profile& p) {
    if (p.id != kCoc.id) {
        // The prompts are written for Call of Cthulhu; in another system's channel the game gets that system's name.
        // The GM is "GM" in every system, so the prompts name it directly.
        replaceAll(prompt, "Call of Cthulhu / BRP", "{GAME}");
        replaceAll(prompt, "BRP/CoC", p.dnd ? "5e" : "PbtA");
    }
    replaceAll(prompt, "{GAME}", p.game);
    replaceAll(prompt, "{GM_SHORT}", p.gmShort);
    replaceAll(prompt, "{GM}", p.gm);
    return prompt;
}

} // namespace acerciae::rules
