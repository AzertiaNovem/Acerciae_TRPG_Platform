#include "LogAdapters.h"
#include "../core/Json.h"
#include "../core/Errors.h"
#include "../core/Text.h"
#include <regex>
#include <map>
#include <ctime>

namespace acerciae::logstudio {
using namespace text;

// ---- shared helpers ------------------------------------------------------------------------------
namespace {

std::optional<long long> parseTime(const std::string& s) {
    // "2022/05/10 11:28:25", "2022-05-10 11:28:25", "11:28:25" (no date → nullopt, kept as time_text)
    static const std::regex full("^(\\d{4})[/-](\\d{1,2})[/-](\\d{1,2})[ T](\\d{1,2}):(\\d{1,2})(?::(\\d{1,2}))?$");
    std::smatch m; auto t = trim(s);
    if (!std::regex_match(t, m, full)) return std::nullopt;
    std::tm tm{}; tm.tm_year = std::stoi(m[1]) - 1900; tm.tm_mon = std::stoi(m[2]) - 1; tm.tm_mday = std::stoi(m[3]);
    tm.tm_hour = std::stoi(m[4]); tm.tm_min = std::stoi(m[5]); tm.tm_sec = m[6].matched ? std::stoi(m[6]) : 0;
    return (long long)timegm(&tm);
}

struct SpeakerTable {
    std::map<std::string, SpeakerInfo> byKey; std::vector<std::string> order;
    std::string add(const std::string& nick, const std::string& imId, bool isDice) {
        auto key = nick + "-" + imId;
        auto it = byKey.find(key);
        if (it == byKey.end()) {
            SpeakerInfo s; s.key = key; s.displayName = nick; s.imUserId = imId;
            auto l = lower(nick);
            bool botName = l.find("骰") != std::string::npos || l.find("dice") != std::string::npos || l.find("bot") != std::string::npos || l.find("海豹") != std::string::npos;
            s.role = (isDice || botName) ? "dice" : (l.rfind("ob", 0) == 0 ? "hidden" : (l == "kp" || l == "gm" || l == "keeper" || l.find("keeper") != std::string::npos || l.find("守秘人") != std::string::npos || l.find("主持") != std::string::npos ? "gm" : "pc"));
            byKey[key] = s; order.push_back(key);
        }
        byKey[key].messageCount++;
        return key;
    }
    std::vector<SpeakerInfo> list() const { std::vector<SpeakerInfo> v; for (auto& k : order) v.push_back(byKey.at(k)); return v; }
};

void finishEvent(LogEvent& e, const SpeakerInfo& sp, const std::string& adapter, int lineNo, const std::string& rawLine) {
    std::string cleaned; auto media = extractCqMedia(e.content, cleaned);
    if (!media.isNull()) { e.media = media; e.metadata["display_text_without_cq"] = cleaned; }
    bool isDice = sp.role == "dice";
    e.speakerRole = sp.role;
    e.eventType = classifyMessage(e.content, isDice, sp.role == "gm");
    if (sp.role == "hidden") e.eventType = e.eventType == "ooc" ? "ooc" : "secret";
    if (e.eventType == "dice_roll" || isDice) { auto d = parseDice(e.content); if (d) e.dice = d; }
    e.sourceReference["adapter"] = adapter; e.sourceReference["line_no"] = lineNo; e.sourceReference["im_user_id"] = sp.imUserId;
    if (e.rawText.empty()) e.rawText = rawLine;
}

// Generic header-line parser shared by the text formats (story-painter semantics: a header line
// starts a message; everything up to the next header belongs to it; text before the first header is startText).
ParsedLog parseHeaderFormat(const std::string& textIn, const std::regex& header, const std::string& adapter,
                            std::function<void(const std::smatch&, std::string& nick, std::string& imId, std::string& timeStr, std::string& inlineMsg)> extract) {
    ParsedLog out; out.adapter = adapter;
    SpeakerTable speakers;
    std::vector<std::string> lines; { std::string cur; for (char c : textIn) { if (c == '\n') { if (!cur.empty() && cur.back() == '\r') cur.pop_back(); lines.push_back(cur); cur.clear(); } else cur += c; } lines.push_back(cur); }
    LogEvent* last = nullptr; std::string startText; long long seq = 0; int lastHeaderLine = 0;
    for (size_t i = 0; i < lines.size(); ++i) {
        std::smatch m;
        if (std::regex_match(lines[i], m, header)) {
            std::string nick, imId, timeStr, inlineMsg; extract(m, nick, imId, timeStr, inlineMsg);
            if (nick.empty()) continue;
            if (imId.empty()) imId = "auto:" + lower(nick);
            LogEvent e; e.sequenceNumber = ++seq; e.speakerDisplayName = nick; e.speakerKey = speakers.add(nick, imId, false);
            auto ts = parseTime(timeStr); if (ts) e.occurredAtUnix = ts; else e.timeText = timeStr;
            e.content = inlineMsg + (!inlineMsg.empty() && i + 1 < lines.size() ? "\n" : ""); e.rawText = lines[i]; e.sourceKind = "import";
            out.events.push_back(e); last = &out.events.back(); lastHeaderLine = (int)i + 1;
            continue;
        }
        if (last) { last->content += lines[i] + (i + 1 < lines.size() ? "\n" : ""); last->rawText += "\n" + lines[i]; }
        else startText += lines[i] + "\n";
    }
    for (auto& e : out.events) { auto& sp = speakers.byKey[e.speakerKey]; finishEvent(e, sp, adapter, (int)e.sequenceNumber, e.rawText); }
    // Dice-bot speakers: SealDice names its bot replies; a speaker whose every message parses as a dice result is a dice bot.
    for (auto& [k, sp] : speakers.byKey) {
        int diceLike = 0, total = 0; for (auto& e : out.events) if (e.speakerKey == k) { total++; if (e.dice && e.dice->total) diceLike++; }
        if (total >= 2 && diceLike * 100 / total >= 80) { sp.role = "dice"; for (auto& e : out.events) if (e.speakerKey == k) { e.speakerRole = "dice"; if (e.eventType != "dice_roll") e.eventType = e.dice ? "dice_roll" : "system"; } }
    }
    out.speakers = speakers.list();
    out.startText = startText;
    if (!trim(out.startText).empty()) { ImportIssue is; is.lineNo = 1; is.raw = truncate(out.startText, 200); is.reason = "text before the first recognised message was kept as a leading note"; out.issues.push_back(is); LogEvent e; e.sequenceNumber = 0; e.eventType = "system"; e.content = out.startText; e.rawText = out.startText; e.unrecognised = true; e.speakerRole = "system"; e.sourceReference["adapter"] = adapter; e.sourceReference["line_no"] = 1; out.events.insert(out.events.begin(), e); for (size_t i = 0; i < out.events.size(); ++i) out.events[i].sequenceNumber = (long long)i + 1; }
    (void)lastHeaderLine;
    return out;
}

} // namespace

// ---- NativeJsonAdapter ----------------------------------------------------------------------------
class NativeJsonAdapter : public LogAdapter {
public:
    std::string name() const override { return "native_json"; }
    std::string supportedVersions() const override { return "acerciae-log schemaVersion 1.0"; }
    bool detect(const std::string& t) const override {
        try { auto j = json::parse(t); return j.isObject() && j.isMember("schemaVersion") && j["events"].isArray(); } catch (...) { return false; }
    }
    ParsedLog parse(const std::string& t) const override {
        ParsedLog out; out.adapter = name();
        auto j = json::parse(t); out.formatVersion = json::str(j, "schemaVersion");
        if(out.formatVersion!="1.0"||!j["events"].isArray()) throw badRequest("native JSON requires schemaVersion 1.0 and events array");
        SpeakerTable speakers; long long seq = 0;
        for (auto& ev : j["events"]) {
            if(!ev.isObject()) { LogEvent e;e.sequenceNumber=++seq;e.eventType="system";e.speakerRole="system";e.rawText=json::dump(ev);e.content=e.rawText;e.unrecognised=true;out.events.push_back(e);out.issues.push_back({(int)seq,e.rawText,"non-object event retained","warning"});continue; }
            auto e = LogEvent::fromJson(ev); if(e.rawText.empty()) e.rawText=json::dump(ev); e.sequenceNumber = ++seq; e.sourceKind = "import";
            if (e.speakerKey.empty()) e.speakerKey = speakers.add(e.speakerDisplayName, json::str(ev["source_reference"], "im_user_id", "native"), e.speakerRole == "dice");
            else { speakers.add(e.speakerDisplayName, json::str(ev["source_reference"], "im_user_id", "native"), e.speakerRole == "dice"); speakers.byKey.erase(e.speakerDisplayName + "-" + json::str(ev["source_reference"], "im_user_id", "native")); SpeakerInfo s; s.key = e.speakerKey; s.displayName = e.speakerDisplayName; s.role = e.speakerRole; auto& ref = speakers.byKey[e.speakerKey]; if (ref.key.empty()) { ref = s; speakers.order.push_back(e.speakerKey); } ref.messageCount++; }
            if (e.content.empty() && e.rawText.empty()) { ImportIssue is; is.lineNo = (int)seq; is.raw = json::dump(ev); is.reason = "event without content"; out.issues.push_back(is); e.unrecognised = true; }
            out.events.push_back(e);
        }
        out.speakers = speakers.list();
        for (auto& s : out.speakers) if (s.displayName.empty()) s.displayName = s.key;
        return out;
    }
    std::string exportText(const std::vector<LogEvent>& events) const override { return json::dump(toNativeJson(events, Json::Value(Json::objectValue)), true); }
};

// ---- SealDiceJsonAdapter --------------------------------------------------------------------------
// Verified against story-painter's SealDiceLogImporter: top-level {version, items:[{nickname, IMUserId, time,
// message, isDice, commandId, commandInfo?, ...}]}; detection = items[0] has keys "isDice" and "message".
class SealDiceJsonAdapter : public LogAdapter {
public:
    std::string name() const override { return "sealdice_json"; }
    std::string supportedVersions() const override { return "SealDice log JSON export (items[].{nickname,IMUserId,time,message,isDice,commandId}; fixture version 105; compatible item shapes are accepted, other versions are not certified)"; }
    bool detect(const std::string& t) const override {
        try { auto j = json::parse(t); return j.isObject() && j["items"].isArray() && !j["items"].empty() && j["items"][0].isMember("isDice") && j["items"][0].isMember("message"); } catch (...) { return false; }
    }
    ParsedLog parse(const std::string& t) const override {
        ParsedLog out; out.adapter = name();
        auto j = json::parse(t); out.formatVersion = j.isMember("version") ? json::dump(j["version"]) : "unknown";
        SpeakerTable speakers; long long seq = 0;
        for (auto& it : j["items"]) {
            LogEvent e; e.sequenceNumber = ++seq; e.sourceKind = "import";
            auto nick = json::str(it, "nickname"); auto imId = json::str(it, "IMUserId", "unknown");
            bool isDice = json::toBool(it, "isDice");
            if (nick.empty() && json::str(it, "message").empty()) { ImportIssue is; is.lineNo = (int)seq; is.raw = truncate(json::dump(it), 200); is.reason = "item without nickname and message"; out.issues.push_back(is); e.unrecognised = true; e.rawText = json::dump(it); e.eventType = "system"; e.speakerRole = "system"; out.events.push_back(e); continue; }
            e.speakerDisplayName = nick; e.speakerKey = speakers.add(nick, imId, isDice);
            if (isDice) speakers.byKey[e.speakerKey].role = "dice";
            if (it["time"].isNumeric()) e.occurredAtUnix = it["time"].asInt64(); else if (it["time"].isString()) { auto p = parseTime(it["time"].asString()); if (p) e.occurredAtUnix = p; else e.timeText = it["time"].asString(); }
            e.content = json::str(it,"message"); e.rawText=json::dump(it);
            if (it.isMember("commandId") && it["commandId"].isNumeric()) e.metadata["command_id"] = it["commandId"];
            if (it.isMember("commandInfo") && !it["commandInfo"].isNull()) { e.metadata["command_info"] = it["commandInfo"]; }
            for (auto k : {"rawMsgId", "uniformId", "isRaw", "role", "color"}) if (it.isMember(k)) e.metadata[k] = it[k];
            finishEvent(e, speakers.byKey[e.speakerKey], name(), (int)seq, e.rawText);
            // SealDice commandInfo (when present) carries structured roll data; prefer it over regex.
            if (it["commandInfo"].isObject()) {
                auto& ci = it["commandInfo"]; DiceInfo d = e.dice.value_or(DiceInfo{});
                if (ci.isMember("items") && ci["items"].isArray() && !ci["items"].empty()) { auto& first = ci["items"][0]; if (first.isMember("expr")) d.expression = json::str(first, "expr"); if (first.isMember("expr1")) d.expression = json::str(first, "expr1"); if (first["dicePoints"].isNumeric()) d.total = first["dicePoints"].asInt(); if (first["checkVal"].isNumeric()) d.total = first["checkVal"].asInt(); if (first.isMember("attr")) d.checkName = json::str(first, "attr"); if (first.isMember("rank")) d.outcome = json::dump(first["rank"]); }
                if (ci.isMember("rule")) e.metadata["rule"] = ci["rule"];
                if (!d.empty()) { d.raw = e.content; e.dice = d; if (e.eventType != "ooc") e.eventType = "dice_roll"; }
            }
            out.events.push_back(e);
        }
        out.speakers = speakers.list();
        return out;
    }
};

// ---- SealDiceTextAdapter --------------------------------------------------------------------------
// story-painter "海豹编辑器格式" (reEditLog): "<nick>(<imid>) 2022/05/10 11:28:25 [#n]" header, message on following lines.
class SealDiceTextAdapter : public LogAdapter {
    static const std::regex& header() { static const std::regex re("^([^(<\\n]+?)(?:\\(([^(\\n]+)\\)|<([^(\\n]+)>)?\\s+(\\d{4}/\\d{1,2}/\\d{1,2} )?(\\d{1,2}:\\d{1,2}:\\d{2})( #\\d+)?\\s*$"); return re; }
public:
    std::string name() const override { return "sealdice_text"; }
    std::string supportedVersions() const override { return "SealDice text log export / story-painter editor format: 'nickname(IMUserId) YYYY/MM/DD HH:MM:SS' header lines (date optional, '#n' suffix tolerated)"; }
    bool detect(const std::string& t) const override { std::string line; int hits = 0, lines = 0; for (size_t i = 0; i <= t.size(); ++i) { if (i == t.size() || t[i] == '\n') { if (!line.empty() && line.back() == '\r') line.pop_back(); if (std::regex_match(line, header())) hits++; line.clear(); if (++lines > 400) break; } else line += t[i]; } return hits >= 1; }
    ParsedLog parse(const std::string& t) const override {
        return parseHeaderFormat(t, header(), name(), [](const std::smatch& m, std::string& nick, std::string& imId, std::string& ts, std::string& inlineMsg) {
            nick = trim(m[1]); imId = m[2].matched ? m[2].str() : (m[3].matched ? m[3].str() : ""); ts = trim((m[4].matched ? m[4].str() : "") + m[5].str()); inlineMsg = "";
        });
    }
    std::string exportText(const std::vector<LogEvent>& events) const override {
        std::string out;
        for (auto& e : events) {
            std::string ts; if (e.occurredAtUnix) { std::time_t tt = *e.occurredAtUnix; std::tm tm{}; gmtime_r(&tt, &tm); char buf[32]; std::strftime(buf, sizeof buf, "%Y/%m/%d %H:%M:%S", &tm); ts = buf; } else ts = e.timeText.empty() ? "00:00:00" : e.timeText;
            out += e.speakerDisplayName + "(" + json::str(e.sourceReference, "im_user_id", "0") + ") " + ts + "\n" + e.content + "\n\n";
        }
        return out;
    }
};

// ---- RenderedLogAdapter ---------------------------------------------------------------------------
// story-painter "染色器导出格式": "[YYYY/MM/DD ]HH:MM:SS<nick[(imid)]>:message" (time optional).
class RenderedLogAdapter : public LogAdapter {
    static const std::regex& header() { static const std::regex re("^((?:\\d{4}/\\d{2}/\\d{2}\\s)?\\d{2}:\\d{2}:\\d{2})?<(.+?)(\\([^)]+\\))?>:(.*)$"); return re; }
public:
    std::string name() const override { return "rendered_log"; }
    std::string supportedVersions() const override { return "story-painter rendered text export: '[date ]HH:MM:SS<nickname(QQ)>:message' lines"; }
    bool detect(const std::string& t) const override { std::string line; int hits = 0, lines = 0; for (size_t i = 0; i <= t.size(); ++i) { if (i == t.size() || t[i] == '\n') { if (!line.empty() && line.back() == '\r') line.pop_back(); if (std::regex_match(line, header())) hits++; line.clear(); if (++lines > 400) break; } else line += t[i]; } return hits >= 2; }
    ParsedLog parse(const std::string& t) const override {
        return parseHeaderFormat(t, header(), name(), [](const std::smatch& m, std::string& nick, std::string& imId, std::string& ts, std::string& inlineMsg) {
            nick = trim(m[2]); imId = m[3].matched ? "QQ:" + m[3].str().substr(1, m[3].str().size() - 2) : ""; ts = m[1].matched ? m[1].str() : ""; inlineMsg = m[4].str();
        });
    }
};

// ---- QQExportAdapter --------------------------------------------------------------------------------
// story-painter "QQ导出格式": "YYYY-MM-DD HH:MM:SS nickname(QQ)" header then message lines.
class QQExportAdapter : public LogAdapter {
    static const std::regex& header() { static const std::regex re("^(\\d{4}-\\d{2}-\\d{2} \\d{1,2}:\\d{1,2}:\\d{1,2})\\s+(.+?)(\\([^)]+\\)|<[^>]+>)$"); return re; }
public:
    std::string name() const override { return "qq_export"; }
    std::string supportedVersions() const override { return "QQ chat export: 'YYYY-MM-DD HH:MM:SS nickname(QQ)' header lines"; }
    bool detect(const std::string& t) const override { std::string line; int hits = 0, lines = 0; for (size_t i = 0; i <= t.size(); ++i) { if (i == t.size() || t[i] == '\n') { if (!line.empty() && line.back() == '\r') line.pop_back(); if (std::regex_match(line, header())) hits++; line.clear(); if (++lines > 400) break; } else line += t[i]; } return hits >= 1; }
    ParsedLog parse(const std::string& t) const override {
        return parseHeaderFormat(t, header(), name(), [](const std::smatch& m, std::string& nick, std::string& imId, std::string& ts, std::string& inlineMsg) {
            nick = trim(m[2]); auto id = m[3].str(); imId = "QQ:" + id.substr(1, id.size() - 2); ts = m[1].str(); inlineMsg = "";
        });
    }
};

std::unique_ptr<LogAdapter> makeNativeJsonAdapter() { return std::make_unique<NativeJsonAdapter>(); }
std::unique_ptr<LogAdapter> makeSealDiceJsonAdapter() { return std::make_unique<SealDiceJsonAdapter>(); }
std::unique_ptr<LogAdapter> makeSealDiceTextAdapter() { return std::make_unique<SealDiceTextAdapter>(); }
std::unique_ptr<LogAdapter> makeRenderedLogAdapter() { return std::make_unique<RenderedLogAdapter>(); }
std::unique_ptr<LogAdapter> makeQQExportAdapter() { return std::make_unique<QQExportAdapter>(); }

AdapterRegistry::AdapterRegistry() {
    adapters_.push_back(makeNativeJsonAdapter());
    adapters_.push_back(makeSealDiceJsonAdapter());
    adapters_.push_back(makeSealDiceTextAdapter());
    adapters_.push_back(makeQQExportAdapter());
    adapters_.push_back(makeRenderedLogAdapter());
}
const LogAdapter* AdapterRegistry::byName(const std::string& n) const { for (auto& a : adapters_) if (a->name() == n) return a.get(); return nullptr; }
const LogAdapter* AdapterRegistry::detect(const std::string& t) const { for (auto& a : adapters_) if (a->detect(t)) return a.get(); return nullptr; }
std::vector<const LogAdapter*> AdapterRegistry::all() const { std::vector<const LogAdapter*> v; for (auto& a : adapters_) v.push_back(a.get()); return v; }

Json::Value toNativeJson(const std::vector<LogEvent>& events, const Json::Value& meta) {
    Json::Value j; j["schemaVersion"] = "1.0"; j["generator"] = "acerciae-log-studio"; j["meta"] = meta; j["events"] = Json::Value(Json::arrayValue);
    for (auto& e : events) j["events"].append(e.toJson());
    j["extensions"] = Json::Value(Json::objectValue);   // reserved for future SealDice/Parquet-specific fields
    return j;
}
std::string toPlainText(const std::vector<LogEvent>& events) {
    std::string out;
    for (auto& e : events) {
        std::string ts; if (e.occurredAtUnix) { std::time_t tt = *e.occurredAtUnix; std::tm tm{}; gmtime_r(&tt, &tm); char buf[32]; std::strftime(buf, sizeof buf, "%Y/%m/%d %H:%M:%S", &tm); ts = buf; } else ts = e.timeText;
        if (e.eventType == "scene_change") { out += "\n=== " + e.content + " ===\n\n"; continue; }
        out += (ts.empty() ? "" : ts + " ") + "<" + e.speakerDisplayName + ">: " + e.content + "\n";
    }
    return out;
}

} // namespace acerciae::logstudio
