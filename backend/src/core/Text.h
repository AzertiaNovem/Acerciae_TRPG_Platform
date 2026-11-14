#pragma once
#include <string>
#include <vector>
#include <set>

// Small text utilities shared by the rule-based layers (mock LLM, consistency rules, retrieval).
namespace acerciae::text {
std::string lower(std::string s);
std::string upper(std::string s);
std::string trim(const std::string& s);
bool icontains(const std::string& hay, const std::string& needle);
std::vector<std::string> words(const std::string& s);                 // alphanumeric tokens
std::vector<std::string> keywords(const std::string& s, size_t minLen = 4); // lowercase, stopwords removed, deduped
std::vector<std::string> properNouns(const std::string& s);           // "Sheriff Baker", "Corbitt House"
std::vector<std::string> quotedSpeech(const std::string& s);          // text inside "..." or “...”
std::vector<std::string> sentences(const std::string& s);
// Byte limits on valid UTF-8: never split a code point. truncate adds an ellipsis after the prefix.
std::string utf8Prefix(const std::string& s, size_t maxBytes);
// Code points of valid UTF-8 (each byte that is not a continuation byte counts once), as [...s].length in TypeScript,
// codePointCount in Kotlin and unicodeScalars.count in Swift.
inline size_t utf8Length(const std::string& s) { size_t n = 0; for (unsigned char c : s) n += (c & 0xC0) != 0x80; return n; }
// Strict decoding: calls f(code point) for each one in order and returns false on invalid UTF-8 (a stray or missing
// continuation byte, an overlong form, a surrogate U+D800..U+DFFF, a value above U+10FFFF) or as soon as f returns false.
template <class F> bool forEachCodePoint(const std::string& s, F&& f) {
    for (size_t i = 0; i < s.size();) {
        unsigned char c = (unsigned char)s[i];
        size_t n = c < 0x80 ? 1 : c >= 0xC2 && c <= 0xDF ? 2 : c >= 0xE0 && c <= 0xEF ? 3 : c >= 0xF0 && c <= 0xF4 ? 4 : 0;
        if (n == 0 || i + n > s.size()) return false;
        char32_t cp = n == 1 ? c : n == 2 ? c & 0x1F : n == 3 ? c & 0x0F : c & 0x07;
        for (size_t k = 1; k < n; ++k) {
            unsigned char d = (unsigned char)s[i + k];
            if ((d & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (d & 0x3F);
        }
        if ((n == 3 && cp < 0x800) || (n == 4 && (cp < 0x10000 || cp > 0x10FFFF)) || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        if (!f(cp)) return false;
        i += n;
    }
    return true;
}
inline bool utf8Valid(const std::string& s) { return forEachCodePoint(s, [](char32_t) { return true; }); }
std::string truncate(const std::string& s, size_t n);
std::string join(const std::vector<std::string>& xs, const std::string& sep);
bool isStopword(const std::string& w);
std::string nowIso();
} // namespace acerciae::text
