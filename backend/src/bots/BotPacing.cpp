#include "BotPacing.h"
#include <algorithm>
#include <cctype>

namespace acerciae::bots {

namespace {
std::string lower(const std::string& s) { std::string o = s; for (auto& c : o) c = (char)std::tolower((unsigned char)c); return o; }
bool wordChar(unsigned char c) { return std::isalnum(c) || c == '_' || c >= 0x80; }
bool ascii(const std::string& s) { return std::all_of(s.begin(), s.end(), [](unsigned char c) { return c < 0x80; }); }
void owe(State& s, const char* why, const Line& l, bool gmSeen) { s.owed = why; s.owedSeq = l.seq; s.owedAt = l.at; s.gmSeen = gmSeen; }
}

bool names(const std::string& text, const std::vector<std::string>& list) {
    const auto t = lower(text);
    for (const auto& n : list) {
        const auto k = lower(n);
        if (k.size() < 2) continue;
        // Latin names match whole words ("Ann" is not in "Annual"); names in other scripts match anywhere.
        for (std::size_t at = t.find(k); at != std::string::npos; at = t.find(k, at + 1)) {
            if (!ascii(k)) return true;
            const bool before = at == 0 || !wordChar((unsigned char)t[at - 1]) || (unsigned char)t[at - 1] >= 0x80;
            const bool after = at + k.size() >= t.size() || !wordChar((unsigned char)t[at + k.size()]) || (unsigned char)t[at + k.size()] >= 0x80;
            if (before && after) return true;
        }
    }
    return false;
}

void ingest(State& s, const Self& me, const Line& l) {
    if (l.kind == "system") return;
    s.lastLineAt = std::max(s.lastLineAt, l.at);
    if (l.authorId == me.userId) return;
    const bool human = !l.authorIsBot && !l.authorIsGm;
    const bool named = l.whisperedToMe || (me.direct && !l.authorIsBot) || names(l.content, me.names);
    if (human) s.chain = 0;
    if (me.table) {
        if (human) { if (!me.agentPacing) owe(s, "player", l, false); return; }
        if (l.authorIsGm) {
            if (!s.owed.empty()) { s.gmSeen = true; return; }
            if (me.agentPacing) return;   // the GM agent calls the bots itself after its turn
            if (named && s.chain < kChainMax) owe(s, "addressed", l, true);
            return;
        }
        if (named && s.owed.empty() && s.chain < kChainMax) owe(s, "addressed", l, true);
        return;
    }
    // Outside the table: only when someone names it; another bot only once per human line. People's other lines count
    // toward joining in on its own.
    if (!named) { if (!l.authorIsBot) ++s.heard; return; }
    if (l.authorIsBot) { if (s.owed.empty() && s.chain < 1) owe(s, "addressed", l, true); return; }
    if (s.chain < kChainMax) owe(s, "mention", l, true);
}

bool due(const State& s, double now, const Timing& t) {
    if (s.owed.empty()) return false;
    if (now - s.lastLineAt < t.settle) return false;
    if (s.owed == "player") return s.gmSeen || now - s.owedAt >= t.gmWait;
    return true;
}

bool chatter(const State& s, double now, double lastEval, const Chatter& t) {
    return s.owed.empty() && s.heard >= t.heard && now - lastEval >= t.gap && now - s.lastLineAt >= t.quiet;
}

} // namespace acerciae::bots
