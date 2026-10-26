#pragma once
#include <json/json.h>
#include <string>
#include <vector>
#include <optional>

namespace acerciae::logstudio {

// Canonical Log Model (schemaVersion 1.0). One event = one unit of what actually happened.
// `content` is always the original text; nothing in the studio rewrites it.
struct DiceInfo {
    std::string expression;     // e.g. "1d100", "ra 侦查"
    std::vector<int> rolls;
    std::optional<int> total;
    std::string checkName;
    std::string outcome;        // success/failure/critical/fumble/… as written
    std::string raw;
    bool empty() const { return expression.empty() && rolls.empty() && !total && checkName.empty() && outcome.empty(); }
    Json::Value toJson() const;
};

struct LogEvent {
    std::string eventId;                 // filled on save
    long long sequenceNumber = 0;
    std::string eventType = "dialogue";  // dialogue|action|narration|dice_roll|system|ooc|scene_change|media|secret
    std::string content;
    std::string speakerKey;
    std::string speakerDisplayName;
    std::string speakerCharacterId;
    std::string speakerRole = "pc";      // gm|pc|npc|dice|system|hidden
    std::optional<long long> occurredAtUnix;
    std::string timeText;
    std::string sceneKey, sceneTitle, sceneId, chatWindowId;
    std::string visibilityScope = "public";   // public|gm|character
    std::vector<std::string> audience;
    std::string sourceKind = "import";   // channel_event|import
    std::string sourceEventId, sourceMessageId;
    Json::Value sourceReference = Json::Value(Json::objectValue);
    std::optional<DiceInfo> dice;
    Json::Value media;                   // null or array
    Json::Value metadata = Json::Value(Json::objectValue);
    std::string rawText;
    bool unrecognised = false;
    Json::Value toJson() const;
    static LogEvent fromJson(const Json::Value& v);
};

struct SpeakerInfo {
    std::string key;            // "<nick>-<imUserId>" or channel character id
    std::string displayName;
    std::string imUserId;
    std::string role = "pc";    // gm|pc|npc|dice|system|hidden
    int messageCount = 0;
    std::vector<std::string> aliases;
};

struct ImportIssue { int lineNo = 0; std::string raw; std::string reason; std::string severity = "warning"; };

struct ParsedLog {
    std::string adapter;
    std::string formatVersion;
    std::vector<LogEvent> events;
    std::vector<SpeakerInfo> speakers;
    std::vector<ImportIssue> issues;
    std::string startText;      // unformatted text before the first recognised message
    Json::Value stats() const;
};

// Classification helpers shared by adapters (pure functions, unit-tested).
std::string classifyMessage(const std::string& text, bool isDiceBot, bool speakerIsGm);   // event_type
bool isOocText(const std::string& text);
std::optional<DiceInfo> parseDice(const std::string& text);         // SealDice-style .r/.ra/.rc results and plain "1d100=37"
Json::Value extractCqMedia(const std::string& text, std::string& cleaned);   // [CQ:image,file=...] → media entries
std::string normaliseEncoding(const std::string& bytes, std::string& detected);  // UTF-8 BOM, UTF-16 LE/BE → UTF-8; GBK passthrough flagged

} // namespace acerciae::logstudio
