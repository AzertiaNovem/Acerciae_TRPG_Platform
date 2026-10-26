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
std::string truncate(const std::string& s, size_t n);
std::string join(const std::vector<std::string>& xs, const std::string& sep);
bool isStopword(const std::string& w);
std::string nowIso();
} // namespace acerciae::text
