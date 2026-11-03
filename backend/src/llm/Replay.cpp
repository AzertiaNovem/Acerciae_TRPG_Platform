#include "Replay.h"
#include "../core/Json.h"

namespace acerciae::llm {
namespace {
bool nonEmptyString(const Json::Value& v) { return v.isString() && !v.asString().empty(); }
}

Json::Value replayableAssistant(const Json::Value& exchange, const std::string& provider, const std::string& model) {
    if (!exchange.isObject()) return Json::Value();
    const auto from = json::str(exchange, "provider");
    const bool sameModel = !model.empty() && json::str(exchange, "model") == model;
    const auto& content = exchange["provider_content"];
    if (from.empty() || from != provider || !content.isArray() || content.empty()) return Json::Value();
    Json::Value out(Json::arrayValue);
    if (provider == "anthropic") {
        // Content blocks. A thinking block is replayable only unmodified, with its signature, for the model that
        // signed it; a redacted one only with its sealed data. Anything else of the model's turn is text.
        for (const auto& b : content) {
            if (!b.isObject()) continue;
            const auto type = json::str(b, "type");
            if (type == "text") { if (nonEmptyString(b["text"])) out.append(b); }
            else if (type == "thinking") { if (sameModel && nonEmptyString(b["signature"]) && b["thinking"].isString()) out.append(b); }
            else if (type == "redacted_thinking") { if (sameModel && nonEmptyString(b["data"])) out.append(b); }
            // tool_use and unknown blocks are not part of a script answer: left out.
        }
    } else if (provider == "openai_compatible") {
        // Responses output items. A reasoning item is replayable only with its encrypted content, for the same model;
        // the message item carries the text.
        for (const auto& it : content) {
            if (!it.isObject()) continue;
            const auto type = json::str(it, "type");
            if (type == "message") {
                if (json::str(it, "role", "assistant") != "assistant" || !it["content"].isArray()) continue;
                Json::Value m; m["type"] = "message"; m["role"] = "assistant"; m["content"] = Json::Value(Json::arrayValue);
                if (nonEmptyString(it["id"])) m["id"] = it["id"];
                for (const auto& c : it["content"]) if (c.isObject() && json::str(c, "type") == "output_text" && c["text"].isString()) { Json::Value t; t["type"] = "output_text"; t["text"] = c["text"]; m["content"].append(t); }
                if (!m["content"].empty()) out.append(m);
            } else if (type == "reasoning") {
                if (!sameModel || !nonEmptyString(it["encrypted_content"])) continue;
                Json::Value r; r["type"] = "reasoning"; r["encrypted_content"] = it["encrypted_content"];
                if (nonEmptyString(it["id"])) r["id"] = it["id"];
                r["summary"] = it["summary"].isArray() ? it["summary"] : Json::Value(Json::arrayValue);
                out.append(r);
            }
        }
    } else return Json::Value();
    // Only sealed reasoning without any text would be an incomplete turn: replay the plain text then.
    bool text = false;
    for (const auto& x : out) { auto t = json::str(x, "type"); if (t == "text" || t == "message") text = true; }
    return text ? out : Json::Value();
}

bool carriesReasoning(const Json::Value& replay) {
    if (!replay.isArray()) return false;
    for (const auto& x : replay) { auto t = json::str(x, "type"); if (t == "thinking" || t == "redacted_thinking" || t == "reasoning") return true; }
    return false;
}

} // namespace acerciae::llm
