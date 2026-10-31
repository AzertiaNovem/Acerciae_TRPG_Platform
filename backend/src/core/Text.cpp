#include "Text.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <ctime>
#include <sstream>
#include <iomanip>

namespace acerciae::text {

static const std::set<std::string>& stopwords() {
    static const std::set<std::string> s = {
        "the","and","that","this","with","from","they","them","their","have","has","had","was","were","will","would",
        "what","when","where","which","who","whom","why","how","then","than","there","here","into","onto","about",
        "your","you","yours","mine","ours","just","very","some","such","also","been","being","does","did","done",
        "over","under","after","before","again","still","only","while","because","could","should","might","must",
        "said","says","say","tell","told","take","takes","took","make","makes","made","like","want","wants","know",
        "knows","knew","look","looks","looked","back","down","upon","toward","towards","through","around","away",
        "really","maybe","perhaps","think","thought","something","anything","nothing","everything","someone","anyone",
        "going","goes","went","come","comes","came","give","gives","gave","last","next","week","night","today","time",
        "i","me","my","we","us","our","he","him","his","she","her","it","its","a","an","of","to","in","on","at","by",
        "is","are","am","be","do","not","no","yes","so","if","or","but","for","as","up","out","off","all","any","can",
        "let","lets","get","gets","got","put","puts","see","sees","saw","room","door","one","two","three","first",
        "notice","notices","noticed","hands","hand","walks","walk","looks","turns","turn","takes","gives","holds","hold","opens",
        "brings","bring","stand","stands","sits","sitting","standing","waiting","watching","talking","moves","move","keeps","keep",
        "starts","start","speaks","speak","smiles","nods","shakes","picks","drops","dropped","steps","leaves","leave","arrives",
        "arrive","enters","enter","hear","hears","heard","feel","feels","felt","find","finds","found","says","asked","asks","ask",
        "reads","read","shows","show","shown","pull","pulls","push","pushes","waves","sets","set","meet","meets","wait","waits",
        "before","while","never","always","already","every","other","another","right","left","across","along","behind","beside",
        "between","beyond","without","within","though","through","would","should","could","might","quite","rather","enough",
        "slowly","quickly","again","still","there","where","these","those","their","whose","which","while","until","since",
        "mess","somewhere","nobody","anybody","everybody","somebody","yours","ours","theirs","itself","himself","herself","myself"
    };
    return s;
}

bool isStopword(const std::string& w) { return stopwords().count(w) > 0; }

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
    return s;
}
std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace((unsigned char)s[a])) ++a;
    while (b > a && std::isspace((unsigned char)s[b - 1])) --b;
    return s.substr(a, b - a);
}
bool icontains(const std::string& hay, const std::string& needle) {
    if (needle.empty()) return false;
    return lower(hay).find(lower(needle)) != std::string::npos;
}
std::vector<std::string> words(const std::string& s) {
    std::vector<std::string> out; std::string cur;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '\'' || c >= 0x80) cur += (char)c;
        else { if (!cur.empty()) out.push_back(cur); cur.clear(); }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}
std::vector<std::string> keywords(const std::string& s, size_t minLen) {
    std::vector<std::string> out; std::set<std::string> seen;
    for (auto& w : words(s)) {
        auto l = lower(w);
        // strip possessive and trailing apostrophes
        while (!l.empty() && l.back() == '\'') l.pop_back();
        if (l.size() >= 2 && l.compare(l.size()-2, 2, "'s") == 0) l = l.substr(0, l.size()-2);
        if (l.size() < minLen || isStopword(l)) continue;
        if (seen.insert(l).second) out.push_back(l);
    }
    return out;
}
std::vector<std::string> properNouns(const std::string& s) {
    // Capitalised runs that are not at the very start of a sentence (to reduce "I"/"The" noise).
    std::vector<std::string> out; std::set<std::string> seen;
    std::vector<std::string> chunks;
    for (auto& sent : sentences(s)) {
        // Break on punctuation so that "Harvey Walters, Sheriff" does not become one name.
        std::string cur;
        for (size_t i = 0; i < sent.size(); ++i) {
            unsigned char c = sent[i];
            bool brk = (c == ',' || c == ';' || c == ':' || c == '(' || c == ')' || c == '"' || c == '!' || c == '?' || c == '.');
            if (c == 0xe2 && i + 2 < sent.size() && (unsigned char)sent[i+1] == 0x80) { brk = true; i += 2; }
            if (brk) { chunks.push_back(cur); cur.clear(); } else cur += (char)c;
        }
        chunks.push_back(cur);
    }
    for (auto& sent : chunks) {
        auto ws = words(sent);
        for (auto& w : ws) { // strip possessive
            if (w.size() > 2 && (w.compare(w.size()-2, 2, "'s") == 0 || w.compare(w.size()-2, 2, "\xe2\x80\x99s") == 0)) w = w.substr(0, w.size()-2);
            if (w.size() > 3 && w.compare(w.size()-3, 3, "\xe2\x80\x99") == 0) w = w.substr(0, w.size()-3);
        }
        std::string run; int runLen = 0;
        auto flush = [&]() {
            if (runLen >= 1 && run.size() > 2) {
                auto l = lower(run);
                if (l != "i" && !isStopword(l) && seen.insert(l).second) out.push_back(run);
            }
            run.clear(); runLen = 0;
        };
        for (size_t i = 0; i < ws.size(); ++i) {
            const auto& w = ws[i];
            bool cap = std::isupper((unsigned char)w[0]) && w != "I" && w != "I'm" && w != "I'll" && w != "I've" && w != "I'd";
            bool sentenceStart = (i == 0);
            if (cap && !(sentenceStart && isStopword(lower(w)))) {
                if (sentenceStart && runLen == 0) {
                    // Keep sentence-initial capitals only when followed by another capitalised word.
                    bool nextCap = (i + 1 < ws.size()) && std::isupper((unsigned char)ws[i+1][0]) && ws[i+1] != "I";
                    if (!nextCap) continue;
                }
                if (runLen) run += " ";
                run += w; runLen++;
            } else flush();
        }
        flush();
    }
    return out;
}
std::vector<std::string> quotedSpeech(const std::string& s) {
    std::vector<std::string> out; std::string cur; bool in = false;
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = s[i];
        bool quote = (c == '"');
        // UTF-8 curly quotes “ (e2 80 9c) ” (e2 80 9d)
        if (c == 0xe2 && i + 2 < s.size() && (unsigned char)s[i+1] == 0x80 && ((unsigned char)s[i+2] == 0x9c || (unsigned char)s[i+2] == 0x9d)) { quote = true; i += 2; }
        if (quote) { if (in && !trim(cur).empty()) out.push_back(trim(cur)); cur.clear(); in = !in; continue; }
        if (in) cur += (char)c;
    }
    return out;
}
std::vector<std::string> sentences(const std::string& s) {
    static const std::set<std::string> abbrev = {"mr","mrs","ms","dr","prof","st","mt","rev","sgt","capt","lt","col","gen","no","vs","etc","jr","sr"};
    std::vector<std::string> out; std::string cur;
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        cur += c;
        bool terminator = (c == '.' || c == '!' || c == '?' || c == '\n');
        if (c == '.') {
            // "Mrs." / "Dr." are not sentence ends.
            auto ws = words(cur);
            if (!ws.empty() && abbrev.count(lower(ws.back()))) terminator = false;
        }
        if (terminator) {
            // absorb closing quotes / brackets that follow the terminator
            while (i + 1 < s.size()) {
                unsigned char n = s[i + 1];
                if (n == '"' || n == '\'' || n == ')') { cur += (char)n; ++i; continue; }
                if (n == 0xe2 && i + 3 < s.size() && (unsigned char)s[i + 2] == 0x80 && ((unsigned char)s[i + 3] == 0x9d || (unsigned char)s[i + 3] == 0x99)) { cur += s.substr(i + 1, 3); i += 3; continue; }
                break;
            }
            auto t = trim(cur); if (!t.empty()) out.push_back(t); cur.clear();
        }
    }
    auto t = trim(cur); if (!t.empty()) out.push_back(t);
    return out;
}
std::string utf8Prefix(const std::string& s, size_t maxBytes) {
    if (s.size() <= maxBytes) return s;
    size_t end = maxBytes;
    // end points at the first excluded byte; continuation bytes belong to an incomplete final code point.
    while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0) == 0x80) --end;
    return s.substr(0, end);
}
std::string truncate(const std::string& s, size_t n) {
    if (s.size() <= n) return s;
    return utf8Prefix(s, n) + "…";
}
std::string join(const std::vector<std::string>& xs, const std::string& sep) {
    std::string out;
    for (size_t i = 0; i < xs.size(); ++i) { if (i) out += sep; out += xs[i]; }
    return out;
}
std::string nowIso() {
    auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{}; gmtime_r(&t, &tm);
    std::ostringstream os; os << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    return os.str();
}

} // namespace acerciae::text
namespace acerciae::text {
std::string upper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::toupper(c); });
    return s;
}
}
