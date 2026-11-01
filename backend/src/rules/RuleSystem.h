#pragma once
#include <string>

// The rule system a channel plays by, chosen by its GM (channels.rule_system): what the AI prompts call the game and
// the game master, the rule hints the consistency check reads, and which dice commands and character sheet apply.
namespace acerciae::rules {

struct Profile {
    std::string id;         // coc7e | dnd2024
    std::string game;       // how prompts name the game
    std::string gm;         // the game master's title: Keeper | Dungeon Master
    std::string gmShort;    // KP | DM (transcript labels)
    std::string hints;      // conventions the consistency check applies
    bool dnd = false;
};

bool valid(const std::string& id);
// The id a client sent, with the legacy Call of Cthulhu names older clients use (coc7, coc, brp) read as coc7e; "" when it
// names no supported system.
std::string canonical(const std::string& id);
const Profile& profile(const std::string& id);   // unknown ids read as coc7e

// Prompts are written for Call of Cthulhu (or with {GAME}, {GM} and {GM_SHORT}); this fills them in for a channel's rule
// system: in a D&D channel "Call of Cthulhu / BRP" names the game, "Keeper" becomes "Dungeon Master" and "KP(" "DM(".
// System prompts only: chat lines and other data are never rewritten.
std::string adapt(std::string prompt, const Profile& p);

} // namespace acerciae::rules
