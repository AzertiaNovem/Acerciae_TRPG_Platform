#pragma once
#include "../core/Db.h"
#include <json/json.h>
#include <map>
#include <set>
#include <string>

namespace acerciae {
class AuthService; class ChatService; class CharacterSpaceService; class LlmGateway; class DiceService; class BotMemory;

// A bot makes its own character (docs/BOTS.md) when someone at the table asks it to: one model call (task bot_card)
// proposes a character in keeping with the bot's persona and memory, and the server builds a legal card from it, then saves it
// through the same routes a player uses (createCharacter, CharacterSpaceService::updateCard), so the channel's point
// buy and every other check apply. Call of Cthulhu, D&D 2024 and PbtA; another rule system asks the GM for the card.
class BotCards {
public:
    BotCards(Db& db, AuthService& auth, ChatService& chat, CharacterSpaceService& space, LlmGateway& llm, DiceService& dice, BotMemory& memory)
        : db_(db), auth_(auth), chat_(chat), space_(space), llm_(llm), dice_(dice), memory_(memory) {}

    // Makes the bot's character in the channel from `idea` and says so in the window. Returns the new character's
    // id, or "" when it could not (it then asks the GM, out of character, to make one).
    std::string make(const std::string& botId, const std::string& channelId, const std::string& windowId, const std::string& idea);

    // The role card a wish describes ({occupation, age, sex, characteristics{}, skills{name: total}, background{},
    // items[]}): characteristics 15–90; skills up to 99 (never Cthulhu Mythos). Under point buy it chooses the custom
    // career with the eight skills wanted most and spends the career points (EDU×4) and hobby points (INT×2) toward the
    // totals wanted, within both budgets, so the card always passes coc7::apply.
    static Json::Value cocCard(const Json::Value& wish, bool pointBuy);
    // D&D 2024 ({class, species, background, abilities[] most wanted first, skills[], features, spells, story{}}): a
    // level 1 standard-array build, the background's +2/+1 to the two of its abilities wanted most, the class's saves,
    // the background's skills, the class's picks (the wanted ones first) and the species' pick, so the card always
    // passes dnd2024::check. Unknown names become a Fighter, a Human, the background that suits the abilities best.
    static Json::Value dndCard(const Json::Value& wish);
    // PbtA ({book, stats{}, resources{}, story{}}) against the channel's pack: ids or names; a playbook another character
    // holds gives way to a free one; stats -1..+3, resources 0..99, every field of the pack filled.
    static Json::Value pbtaCard(const Json::Value& wish, const Json::Value& pack, const std::set<std::string>& takenBooks);
    static Json::Value schema();

private:
    // A line of the bot's own, out of character, from the channel's texts (bots.card_*).
    void say(const std::string& user, const std::string& channelId, const std::string& windowId, const std::string& key, const std::map<std::string, std::string>& vars = {});
    Db& db_;
    AuthService& auth_;
    ChatService& chat_;
    CharacterSpaceService& space_;
    LlmGateway& llm_;
    DiceService& dice_;
    BotMemory& memory_;   // what the bot remembers shapes whom it plays
};

} // namespace acerciae
