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
class AuthService; class ChatService; class LlmGateway; class ServerSettingsService; class WorkPool;

// Bots speak (docs/BOTS.md). A loop reads, for every bot in every chat window it is in, the lines it witnessed since it
// last looked (its own window's lines and whispers to its characters; never GM-only lines, never another window), and
// applies the pacing rules (BotPacing.h) to decide when a turn is due. A due turn is claimed with a lease on the row
// and logged once per trigger in bot_turns, then run on a small pool: one model call (task bot_turn, the server's
// text_bots use) whose answer is checked and posted with the bot's own access, exactly as a player would post it.
//
// At the table a bot plays its character: in character, its own dice (.r .ra .rc .sc; never .st, .en or a hidden roll),
// or it passes. Outside the table it speaks as itself, out of character. A newer human player's line arriving while a
// bot composes discards the draft (the debt stays). An interrupted turn is never posted twice; failures back off.
class BotRuntime {
public:
    BotRuntime(const Config& cfg, Db& db, AuthService& auth, ChatService& chat, LlmGateway& llm, ServerSettingsService& settings);
    ~BotRuntime();
    void start();
    void stop();
    // One pass of the loop (tests call it directly): reads new lines, and runs due turns inline when `inlineTurns`.
    int tick(bool inlineTurns = false);
    // The checked answer of a turn: {action: speak|roll|pass, kind, messages[], command}. Throws std::runtime_error
    // naming what is wrong. `table`: the bot plays a character here; `ruleSystem`: the channel's.
    static Json::Value checkTurn(const Json::Value& out, bool table, const std::string& ruleSystem);
    static Json::Value schema();

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
    std::unique_ptr<WorkPool> pool_;
    std::atomic<bool> running_{false};
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
};

} // namespace acerciae
