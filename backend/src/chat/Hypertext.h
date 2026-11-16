#pragma once
#include <json/json.h>
#include <string>
#include <vector>

// Interactive messages (messages.kind = 'hypertext', docs/HYPERTEXT.md): card format v1 and its pure rules. No database,
// no I/O. HypertextService posts cards and runs their effects with these; the web and mobile apps port defaultState,
// validateState, evalCondition, interpolate and diceVerdict. mobile/contracts/fixtures/hypertext.json pins every one.
namespace acerciae::hypertext {

constexpr int kMaxNodes = 64, kMaxStateKeys = 32, kMaxReplies = 16, kMaxSlots = 4, kMaxActors = 10;
constexpr size_t kMaxScriptBytes = 16384, kMaxDocBytes = 32768, kMaxStateBytes = 8192;
constexpr size_t kMaxStoredBytes = 61440;   // the stored public document and the templates, as storedSize counts (the CHECKs allow 64 KiB)
constexpr size_t kMaxContent = 2000, kMaxSay = 500, kMaxSayLines = 5, kMaxTemplate = 1000;

struct Issue { std::string path, message; };   // path in the post body: "hypertext.body[2].label", "replies.door.text"
struct Normalized {
    bool ok = false;
    Json::Value doc;                 // the card with its defaults filled in; public to every reader
    Json::Value replies;             // {id: {text, kind, character_id, audience, slots, allow_dice, per_viewer, total, group}}: PRIVATE
    std::vector<Issue> errors;       // at most 10, in the order they were found
    Json::Value details() const;     // [{path, message}] for the 400 invalid_hypertext body
};
// Checks a posted card and its reply templates against format v1. Unknown keys anywhere are errors. Actor and character ids
// are checked as UUIDs only (lowercased): the service checks that they belong to the channel. The normalized card is at
// most 32 KiB of JSON; the stored document (with the reply stubs) and the templates at most kMaxStoredBytes each.
Normalized normalize(const Json::Value& hypertext, const Json::Value& replies);
// The stored messages.hypertext: the normalized card plus closes_at and the reply stubs [{id, slots, audience, group}]
// sorted by id. Template text, kind, character and limits never leave the server.
Json::Value publicDoc(const Json::Value& doc, const Json::Value& replies, const std::string& closesAt);
// The plain-text content when a card is posted without one: the title, then one line per node visible under the default
// state, joined with "\n" and cut to 2000 code points; no locale words. "—" when nothing is visible.
std::string fallbackText(const Json::Value& doc);
// The bytes PostgreSQL's jsonb text form of a document takes ({"key": value, ...}): the compact JSON plus a space after
// each colon and comma.
size_t storedSize(const Json::Value& v);

// Per-viewer state. defaultState: bool false, int its default or min, enum its default or null, set [], text "".
Json::Value defaultState(const Json::Value& doc);
// Declared keys only (a missing key keeps its default), types, ranges, enum and set members, set max, text max and
// characters, at most 8 KiB serialized. key is the first offending key ("" for the whole state); state is the full
// canonical state (defaults overlaid with the given values) to store.
struct StateCheck { bool ok = false; std::string key, message; Json::Value state; };
StateCheck validateState(const Json::Value& doc, const Json::Value& state);
// show_if / enable_if over a state; a missing or ill-typed value reads as its default.
bool evalCondition(const Json::Value& cond, const Json::Value& doc, const Json::Value& state);
// {{key}} in text nodes, control labels, group titles and act.say (the card title, placeholders and submit labels are
// literal): int as decimal, enum as its label ("" when null), set as its labels in schema order joined with ", ", text raw.
std::string interpolate(const std::string& text, const Json::Value& doc, const Json::Value& state);

// A private reply rendered with a client's slots: the names must match exactly, an enum value must be one of the declared
// strings, an int a JSON integer within range. With allow_dice the result must still parse as .r/.rh. error: invalid_slot.
struct Rendered { bool ok = false; std::string text, error, message; };
Rendered renderReply(const Json::Value& reply, const Json::Value& slots);

// What a line posted as the clicker may be, by the canonical command name of dice::parseCommand: r/rh, ra/rc/rah/rch and
// ri/rih with modifiers only run directly; sc and ds need the viewer's confirmation (428); ri with a name, st, en, ss,
// init and move are refused; a line that is not a command is none.
enum class Verdict { none, allowed, confirm, refused };
Verdict diceVerdict(const std::string& text);
const char* verdictName(Verdict v);   // "none" | "allowed" | "confirm" | "refused"
bool isCommand(const std::string& text);

// ^[a-z][a-z0-9_]{0,31}$ and not a JavaScript prototype name (constructor, valueof, ...): ids, keys, slots, handlers, groups.
bool validId(const std::string& s);
// Valid UTF-8 without C0 controls (except "\n" when multiline), bidi overrides U+202A..U+202E and U+2066..U+2069, or
// noncharacters.
bool allowedText(const std::string& s, bool multiline);
// A say as the clicker: 1..500 code points after trimming, at most 5 lines, allowed characters. "" when it is fine.
std::string sayError(const std::string& text);
// A card's given content: 1..2000 code points, allowed characters, not a dot command. "" when it is fine.
std::string contentError(const std::string& text);

} // namespace acerciae::hypertext
