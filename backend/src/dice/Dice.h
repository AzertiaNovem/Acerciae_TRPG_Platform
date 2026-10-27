#pragma once
#include <json/json.h>
#include <map>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

// Sealdice-compatible dice engine for BRP / Call of Cthulhu 7e. Pure: no database, no I/O. The DiceService
// loads a character's attributes and a text group, runs a command through here and persists the outcome.
namespace acerciae::dice {

// A user-facing error; its message is already rendered with the active text group.
class DiceError : public std::runtime_error { using std::runtime_error::runtime_error; };

class Rng {
public:
    virtual ~Rng() = default;
    virtual int roll(int sides) = 0;   // uniform in [1, sides]
};
class RandomRng : public Rng {
public:
    int roll(int sides) override;
};
// Deterministic source for tests: returns the queued values in order (clamped to [1, sides]).
class SeqRng : public Rng {
public:
    explicit SeqRng(std::vector<int> v) : v_(std::move(v)) {}
    int roll(int sides) override;
private:
    std::vector<int> v_; std::size_t i_ = 0;
};

// ---- expressions: 3d6+2, (2d6+6)*5, d%, 4d6k3, 1d100 ---------------------------------------------
struct ExprResult {
    int total = 0;
    std::string detail;     // the expression with every die replaced by what it rolled, e.g. "[2+5+1]+2"
};
ExprResult evaluate(const std::string& expr, Rng& rng, int defaultSides = 100);   // throws DiceError
bool isExpression(const std::string& s);                                          // syntactically valid, no rolling

// ---- attributes ------------------------------------------------------------------------------------
std::string normKey(const std::string& raw);          // lowercase, spaces/_/-/()/ removed
std::string canonicalName(const std::string& raw);    // "侦查" / "spot" / "spothidden" -> "Spot Hidden"; unknown -> trimmed raw
// The skill table: canonical name and base code (>= 0 fixed value, -2 half DEX, -3 EDU).
struct SkillDef { std::string name; int base; };
std::vector<SkillDef> skillDefs();
std::optional<int> baseCode(const std::string& raw);   // base code of a known skill, nullopt for characteristics and unknown names
struct AttrValue { bool found = false; int value = 0; std::string name; bool isBase = false; };
// Looks a name up in an attrs object (case/alias-insensitive). Falls back to CoC7 base values (Dodge = DEX/2,
// Language (Own) = EDU, Spot Hidden 25, ...) with isBase = true.
AttrValue lookup(const Json::Value& attrs, const std::string& raw);
// Finds the key under which `raw` is stored in attrs (exact stored spelling), or "" if absent.
std::string storedKey(const Json::Value& attrs, const std::string& raw);
// Moves legacy sheet layouts (numeric top-level fields, a "skills" object) into sheet.attrs with canonical names.
Json::Value normalizeSheet(const Json::Value& sheet);

// ---- CoC 7e success levels ------------------------------------------------------------------------
enum class Level { Fumble = 0, Failure = 1, Regular = 2, Hard = 3, Extreme = 4, Critical = 5 };
Level successLevel(int roll, int value);
const char* levelKey(Level l);   // "level.critical" ...
struct D100 { int roll = 0; std::vector<int> tens; };   // tens: every tens die rolled when bonus/penalty apply
D100 rollD100(Rng& rng, int bonus, int penalty);

// ---- reply texts (Sealdice "custom text" groups) --------------------------------------------------
// Built-in groups are "en" and "zh". A server-defined group overrides any subset of keys on top of a base.
const Json::Value& builtinTexts(const std::string& lang);
std::vector<std::string> textKeys();
class TextSet {
public:
    TextSet() : base_("en") {}
    TextSet(std::string base, Json::Value overrides) : base_(std::move(base)), overrides_(std::move(overrides)) {}
    std::string get(const std::string& key) const;
    std::string render(const std::string& key, const std::map<std::string, std::string>& vars) const;
    const std::string& base() const { return base_; }
private:
    std::string base_;
    Json::Value overrides_;
};

// ---- commands -------------------------------------------------------------------------------------
struct Command {
    std::string name;       // r | ra | sc | st | en  (rc is an alias of ra)
    std::string args;
    bool hidden = false;    // .rh / .rah / .rch
    std::string raw;        // e.g. ".ra"
};
// Recognises ".ra research", "。ra侦查", ".r3d6", ".st str60 dex50", ".sc 1/1d6", ".en spot hidden", ".rh".
std::optional<Command> parseCommand(const std::string& content);

struct Context {
    std::string name;           // who acts: character name, or the author's display name for plain rolls
    bool hasCharacter = false;
    Json::Value attrs = Json::Value(Json::objectValue);
};
struct Outcome {
    std::string text;           // rendered reply
    Json::Value detail = Json::Value(Json::objectValue);
    bool hidden = false;
    bool attrsChanged = false;
    Json::Value attrs;          // the full new attrs object when attrsChanged
};
Outcome execute(const Command& cmd, const Context& ctx, const TextSet& texts, Rng& rng);
// The gray hint shown while typing; never rolls. Empty when there is nothing useful to say.
std::string preview(const Command& cmd, const Context& ctx, const TextSet& texts);

} // namespace acerciae::dice
