#include "LogModel.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <regex>
#include <iconv.h>
#include <cerrno>
#include <stdexcept>

namespace acerciae::logstudio {

Json::Value DiceInfo::toJson() const {
    Json::Value v; v["expression"] = expression; v["rolls"] = Json::Value(Json::arrayValue); for (int r : rolls) v["rolls"].append(r);
    if (total) v["total"] = *total; else v["total"] = Json::Value();
    v["check_name"] = checkName; v["outcome"] = outcome; v["raw"] = raw; return v;
}

Json::Value LogEvent::toJson() const {
    Json::Value v;
    v["campaign_id"]=campaignId; v["speaker_id"]=speakerKey;
    v["source_event_id"]=sourceEventId; v["source_message_id"]=sourceMessageId;
    v["event_id"] = eventId; v["sequence_number"] = (Json::Int64)sequenceNumber; v["event_type"] = eventType; v["content"] = content;
    v["speaker_key"] = speakerKey; v["speaker_display_name"] = speakerDisplayName; v["speaker_character_id"] = speakerCharacterId.empty() ? Json::Value() : Json::Value(speakerCharacterId);
    v["speaker_role"] = speakerRole;
    if (occurredAtUnix) v["timestamp"] = (Json::Int64)*occurredAtUnix; else v["timestamp"] = Json::Value();
    v["time_text"] = timeText; v["scene_key"] = sceneKey; v["scene_title"] = sceneTitle;
    v["scene_id"] = sceneId.empty() ? Json::Value() : Json::Value(sceneId); v["chat_window_id"] = chatWindowId.empty() ? Json::Value() : Json::Value(chatWindowId);
    v["visibility_scope"] = visibilityScope; v["audience"] = json::fromStrArray(audience);
    v["source_kind"] = sourceKind; v["source_reference"] = sourceReference;
    v["dice"] = dice ? dice->toJson() : Json::Value(); v["media"] = media.isNull() ? Json::Value() : media; v["metadata"] = metadata;
    v["raw_text"] = rawText.empty() ? Json::Value() : Json::Value(rawText); v["unrecognised"] = unrecognised;
    return v;
}

LogEvent LogEvent::fromJson(const Json::Value& v) {
    LogEvent e;
    e.campaignId=json::str(v,"campaign_id",json::str(v,"channel_id")); e.sourceEventId=json::str(v,"source_event_id"); e.sourceMessageId=json::str(v,"source_message_id");
    e.eventId = json::str(v, "event_id"); e.sequenceNumber = v["sequence_number"].isNumeric() ? v["sequence_number"].asInt64() : 0;
    e.eventType = json::str(v, "event_type", "dialogue"); e.content = json::str(v, "content");
    e.speakerKey = json::str(v, "speaker_key"); e.speakerDisplayName = json::str(v, "speaker_display_name"); e.speakerCharacterId = json::str(v, "speaker_character_id");
    e.speakerRole = json::str(v, "speaker_role", "pc");
    if (v["timestamp"].isNumeric()) e.occurredAtUnix = v["timestamp"].asInt64();
    e.timeText = json::str(v, "time_text"); e.sceneKey = json::str(v, "scene_key"); e.sceneTitle = json::str(v, "scene_title");
    e.sceneId = json::str(v, "scene_id"); e.chatWindowId = json::str(v, "chat_window_id"); e.visibilityScope = json::str(v, "visibility_scope", "public");
    e.audience = json::strArray(v["audience"]); e.sourceKind = json::str(v, "source_kind", "import");
    if (v["source_reference"].isObject()) e.sourceReference = v["source_reference"];
    if (v["dice"].isObject()) { DiceInfo d; d.expression = json::str(v["dice"], "expression"); for (auto& r : v["dice"]["rolls"]) if (r.isNumeric()) d.rolls.push_back(r.asInt()); if (v["dice"]["total"].isNumeric()) d.total = v["dice"]["total"].asInt(); d.checkName = json::str(v["dice"], "check_name"); d.outcome = json::str(v["dice"], "outcome"); d.raw = json::str(v["dice"], "raw"); e.dice = d; }
    if (v["media"].isArray()) e.media = v["media"];
    if (v["metadata"].isObject()) e.metadata = v["metadata"];
    e.rawText = json::str(v, "raw_text"); e.unrecognised = json::toBool(v, "unrecognised");
    return e;
}

Json::Value ParsedLog::stats() const {
    Json::Value s; s["adapter"] = adapter; s["format_version"] = formatVersion; s["events"] = (int)events.size(); s["speakers"] = (int)speakers.size(); s["issues"] = (int)issues.size();
    Json::Value byType(Json::objectValue); int unrec = 0;
    for (auto& e : events) { byType[e.eventType] = byType[e.eventType].asInt() + 1; if (e.unrecognised) unrec++; }
    s["by_type"] = byType; s["unrecognised"] = unrec; return s;
}

// ---- classification ------------------------------------------------------------------------------
bool isOocText(const std::string& t0) {
    auto t = text::trim(t0);
    if (t.empty()) return false;
    // Common table conventions: (…) （…） // … 「ooc」
    if (t[0] == '(' || t.rfind("\xef\xbc\x88", 0) == 0) return true;             // ( or （
    if (t.rfind("//", 0) == 0 || t.rfind("#", 0) == 0) return true;
    auto l = text::lower(t);
    if (l.rfind("ooc", 0) == 0 || l.rfind("[ooc]", 0) == 0 || l.rfind("(ooc", 0) == 0) return true;
    return false;
}

std::optional<DiceInfo> parseDice(const std::string& t) {
    DiceInfo d; d.raw = t;
    // SealDice result lines: "<name>的侦查检定结果为: D100=37/55 成功" / "ra 侦查 ... D100=37/55 困难成功"
    std::smatch m;
    try {
        static const std::regex sealResult("D(\\d+)\\s*=\\s*(\\d+)\\s*/\\s*(\\d+)\\s*(大成功|极难成功|困难成功|成功|失败|大失败|critical|extreme success|hard success|success|failure|fumble)?", std::regex::icase);
        if (std::regex_search(t, m, sealResult)) {
            d.expression = "1d" + m[1].str(); d.rolls.push_back(std::stoi(m[2])); d.total = std::stoi(m[2]);
            d.outcome = m[4].matched ? m[4].str() : "";
            // check name: text between "的" and "检定" if present
            static const std::regex nameRe("的([^\\s:：]{1,16})检定");
            std::smatch n; if (std::regex_search(t, n, nameRe)) d.checkName = n[1];
            d.checkName = d.checkName.empty() ? "" : d.checkName;
            Json::Value extra; extra["target"] = std::stoi(m[3]); d.raw = t;
            return d;
        }
        // Generic "2d6+3=10" or "1d100=37" or "[37]" results
        static const std::regex generic("(\\d*d\\d+(?:[+\\-]\\d+)?)\\s*=\\s*(?:\\[([\\d, ]+)\\][+\\-\\d ]*=?\\s*)?(\\d+)", std::regex::icase);
        if (std::regex_search(t, m, generic)) {
            d.expression = m[1]; d.total = std::stoi(m[3]);
            if (m[2].matched) { std::string list = m[2]; std::string cur; for (char c : list) { if (std::isdigit((unsigned char)c)) cur += c; else { if (!cur.empty()) d.rolls.push_back(std::stoi(cur)); cur.clear(); } } if (!cur.empty()) d.rolls.push_back(std::stoi(cur)); }
            return d;
        }
        // Command without result: ".r 1d100" / ".ra 侦查 60"
        static const std::regex cmd("^[.。/!！]\\s*(r[acdh]?|rc|ra|roll|sc|st|en)\\b\\s*(.*)$", std::regex::icase);
        if (std::regex_search(t, m, cmd)) { d.expression = text::trim(m[2]); d.checkName = ""; return d; }
    } catch (...) {}
    return std::nullopt;
}

std::string classifyMessage(const std::string& t, bool isDiceBot, bool speakerIsGm) {
    auto tt = text::trim(t);
    if (isDiceBot) return parseDice(tt) ? "dice_roll" : "system";
    if (isOocText(tt)) return "ooc";
    // A result-shaped roll ("D100=37/55 成功", "2d6+3=10") is a dice roll whoever posted it.
    if (auto d = parseDice(tt); d && d->total) return "dice_roll";
    static const std::regex cmd("^[.。/!！]\\s*[a-zA-Z]{1,8}\\b");
    if (std::regex_search(tt, cmd)) return "dice_roll";
    if (tt.find("[CQ:image") != std::string::npos || tt.find("[图片]") != std::string::npos) return "media";
    if (speakerIsGm) return "narration";
    // Player text wrapped in quotes is dialogue; otherwise it is an action description.
    bool hasQuote = tt.find('"') != std::string::npos || tt.find("\xe2\x80\x9c") != std::string::npos || tt.find("\xe3\x80\x8c") != std::string::npos; // " “ 「
    if (hasQuote) return "dialogue";
    if (tt.size() > 0 && (tt[0] == '*' || tt[0] == '/')) return "action";
    return "dialogue";
}

Json::Value extractCqMedia(const std::string& t, std::string& cleaned) {
    Json::Value out(Json::arrayValue); cleaned = t;
    static const std::regex cq("\\[CQ:(image|record|video|face),([^\\]]*)\\]");
    std::smatch m; std::string rest = t; std::string acc;
    while (std::regex_search(rest, m, cq)) {
        Json::Value item; item["kind"] = m[1].str(); item["cq"] = m[0].str();
        std::string params = m[2]; std::string::size_type p = params.find("file="); if (p != std::string::npos) { auto e = params.find(',', p); item["file"] = params.substr(p + 5, e == std::string::npos ? std::string::npos : e - p - 5); }
        p = params.find("url="); if (p != std::string::npos) { auto e = params.find(',', p); item["url"] = params.substr(p + 4, e == std::string::npos ? std::string::npos : e - p - 4); }
        out.append(item);
        acc += m.prefix().str() + (m[1].str() == "image" ? "[图片]" : "[" + m[1].str() + "]");
        rest = m.suffix().str();
    }
    if (!out.empty()) cleaned = acc + rest;
    return out.empty() ? Json::Value() : out;
}

std::string normaliseEncoding(const std::string& b, std::string& detected) {
    auto convert=[](const std::string& in,const char* encoding)->std::optional<std::string> {
        auto cd=iconv_open("UTF-8",encoding); if(cd==(iconv_t)-1) return std::nullopt;
        std::string out(in.size()*4+16,'\0'); char* input=const_cast<char*>(in.data()); size_t left=in.size();
        char* output=out.data(); size_t room=out.size(); auto result=iconv(cd,&input,&left,&output,&room); iconv_close(cd);
        if(result==(size_t)-1||left) return std::nullopt; out.resize(out.size()-room); return out;
    };
    detected="utf-8"; std::string input=b;
    if(b.size()>=3&&b.compare(0,3,"\xEF\xBB\xBF")==0) {detected="utf-8-bom";input=b.substr(3);}
    if(b.size()>=2&&(b.compare(0,2,"\xFF\xFE")==0||b.compare(0,2,"\xFE\xFF")==0)) {
        bool le=(unsigned char)b[0]==0xFF; auto out=convert(b.substr(2),le?"UTF-16LE":"UTF-16BE");
        if(!out) throw std::invalid_argument("invalid UTF-16; re-export the log as UTF-8"); detected=le?"utf-16le":"utf-16be"; return *out;
    }
    if(convert(input,"UTF-8")) return input;
    if(auto out=convert(b,"GB18030")) {detected="gb18030-inferred";return *out;}
    throw std::invalid_argument("unknown or invalid log encoding; re-export as UTF-8 (no import saved)");
}

} // namespace acerciae::logstudio
