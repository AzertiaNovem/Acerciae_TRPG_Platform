#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
class LlmGateway;

// What a bot remembers (docs/BOTS.md), so players can keep it as a friend from table to table. For every channel it
// plays in, the lines it witnessed are folded, a few hundred at a time, into its memory of that table (task
// bot_memory): a first-person account with the moment that struck it most, and notes on the people it played with.
// The account of a table is written from the window's lines only; what was whispered to its characters goes into a
// separate private part that is read at that table alone. Memory is refreshed when a scenario closes or the story
// ends, when the bot leaves the channel, and after kLines new lines and a quiet spell.
//
// What a bot brings to a turn: its maintainers' notes; its notes on the people in the window; at the table, that
// table's account, its private part and the GM's briefing for it, never another table's story; as itself, the
// accounts of the tables everyone in the window played at too, or of every table when its maintainers let it share.
// A private chat with one person is remembered like a table but never comes up anywhere else, and leaves no notes on
// people.
class BotMemory {
public:
    BotMemory(const Config& cfg, Db& db, LlmGateway& llm) : cfg_(cfg), db_(db), llm_(llm) {}
    struct Claim { std::string botId, windowId, token; };
    // Windows whose lines are due to be remembered, claimed with a lease (one per bot and channel at a time).
    std::vector<Claim> due(int limit = 4);
    // Folds a claimed window's new lines into the bot's memory of its channel.
    void refresh(const Claim& c);
    // What the bot remembers for a turn in this window (empty when nothing): see above.
    std::string recall(const std::string& botId, const std::string& channelId, const std::string& windowId, bool table);
    // A scenario closed or the story ended in the channel: remember what the bots saw there soon.
    void flushChannel(const std::string& channelId);
    static Json::Value schema();
    static constexpr int kLines = 60;   // new lines that make a memory due after a quiet spell
    static constexpr int kBatch = 300;  // lines remembered per model call
    static constexpr std::size_t kRecallBytes = 12000;

private:
    const Config& cfg_;
    Db& db_;
    LlmGateway& llm_;
};

} // namespace acerciae
