#pragma once
#include <string>
#include <vector>

// When a bot speaks (docs/BOTS.md). Pure rules, no database: the runtime feeds each line the bot witnessed in a chat
// window, in order, and asks whether a turn is due.
//
// At the table (the bot plays a character there): a human player's line owes the bot one turn, taken once the GM has
// answered and the window has been quiet a moment, or after a longer wait with no GM line. A GM line naming the bot's
// character (or whispered to it), or another bot's line naming it, owes a turn too. Outside the table (no character
// there) a bot answers only when someone names it. A bot's run of turns ("chain") restarts only with a human player's
// line, so neither the GM, a GM agent nor other bots can keep it talking: at most kChainMax turns per human line.
namespace acerciae::bots {

constexpr int kChainMax = 2;

struct Line {
    long long seq = 0;
    double at = 0;                 // seconds since the epoch
    std::string authorId;
    bool authorIsBot = false;
    bool authorIsGm = false;       // posted with the GM role (narration, NPCs, a GM agent)
    std::string kind;              // ic | ooc | narration | roll | system | hypertext …
    std::string content;
    bool whisperedToMe = false;    // a whisper to one of the bot's characters
};

struct State {
    std::string owed;              // "" | player | addressed | mention | called | adopt | unprompted
    long long owedSeq = 0;
    double owedAt = 0;
    bool gmSeen = false;           // the GM has spoken since the debt arose
    double lastLineAt = 0;         // the window's latest line
    int chain = 0;                 // this bot's turns since the last human player's line
};

struct Self {
    std::string userId;
    std::vector<std::string> names;   // the bot's name and its characters' names here
    bool table = false;               // it plays a character in this window
    bool agentPacing = false;         // a GM agent paces the bots of this channel: players' lines owe nothing
};

struct Timing { double settle = 6, gmWait = 90; };

// Whether the text names one of the names (case-insensitive; whole words in Latin scripts, anywhere in CJK text).
bool names(const std::string& text, const std::vector<std::string>& names);
void ingest(State& s, const Self& me, const Line& l);
bool due(const State& s, double now, const Timing& t);

} // namespace acerciae::bots
