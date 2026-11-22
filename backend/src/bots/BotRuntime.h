#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include <json/json.h>
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace acerciae {
class AuthService; class ChatService; class LlmGateway; class ServerSettingsService; class WorkPool; class CharacterSpaceService; class DiceService; class BotCards; class BotMemory;

// Bots speak (docs/BOTS.md). A loop reads, for every bot in every chat window it is in, the lines it witnessed since it
// last looked (its own window's lines and whispers to its characters; never GM-only lines, never another window), and
// applies the pacing rules (BotPacing.h) to decide when a turn is due. A due turn is claimed with a lease on the row
// and logged once per trigger in bot_turns, then run on a small pool: one model call (task bot_turn, the server's
// text_bots use) whose answer is checked and posted with the bot's own access, exactly as a player would post it.
//
// At the table a bot plays its character: in character, its own dice (.r .ra .rc .sc; never .st, .en or a hidden roll),
// or it passes. Outside the table it speaks as itself, out of character. A newer human player's line arriving while a
// bot composes discards the draft (the debt stays). An interrupted turn is never posted twice; failures back off.
// Outside the table, a bot may also join in on its own, within its hourly allowance (BotPacing::chatter). The same
// loop has the bots write down what they saw (BotMemory), and every turn brings what the bot remembers.
class BotRuntime {
public:
    BotRuntime(const Config& cfg, Db& db, AuthService& auth, ChatService& chat, LlmGateway& llm, ServerSettingsService& settings, CharacterSpaceService& space, DiceService& dice);
    ~BotRuntime();
    void start();
    void stop();
    // One pass of the loop (tests call it directly): reads new lines, and runs due turns inline when `inlineTurns`.
    int tick(bool inlineTurns = false);
    // The memory work of one pass (tests call it directly): folds due windows' lines into the bots' memory.
    int memoryTick(bool inlineRuns = false);
    BotMemory& memory() { return *memory_; }
    // The checked answer of a turn: {action: speak|roll|pass|make_character, kind, messages[], command, concept}. Throws
    // std::runtime_error naming what is wrong. `table`: the bot plays a character here; `ruleSystem`: the channel's;
    // `canMake`: it has no character in this channel yet, so it may make one when asked.
    static Json::Value checkTurn(const Json::Value& out, bool table, const std::string& ruleSystem, bool canMake = false);
    static Json::Value schema();
    // One chat line as a bot reads it: "#seq who (how): what". `gm`: the rule system's name for the GM; `me`: the bot.
    static std::string renderLine(const Json::Value& m, const std::string& gm, const std::string& me);

private:
    struct Claim { std::string botId, windowId, token; };
    void loop();
    std::vector<Claim> scan();
    void runTurn(const Claim& c);
    const Config& cfg_;
    Db& db_;
    AuthService& auth_;
    ChatService& chat_;
    LlmGateway& llm_;
    ServerSettingsService& settings_;
    std::unique_ptr<BotMemory> memory_;
    std::unique_ptr<BotCards> cards_;
    std::unique_ptr<WorkPool> pool_;
    std::atomic<bool> running_{false};
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
};

} // namespace acerciae
