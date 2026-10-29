#include "AnthropicClient.h"
#include "../core/Json.h"
#include "HttpTransport.h"
#include "../core/Log.h"

namespace acerciae {
Json::Value AnthropicClient::requestBody(const LlmRequest& req, const LlmEndpoint& ep) {
    Json::Value b;
    b["model"] = ep.model;
    b["max_tokens"] = req.maxTokens > 0 ? req.maxTokens : ep.maxTokens;
    std::string system = req.system;
    if (!req.responseSchema.isNull())
        system += "\nReturn only a JSON value matching this schema after any tool calls:\n" + json::dump(req.responseSchema);
    b["system"] = system;
    b["messages"] = Json::Value(Json::arrayValue);
    for (const auto& m : req.messages) {
        if (m.role == "system") { b["system"] = b["system"].asString() + "\n" + m.content; continue; }
        Json::Value blocks(Json::arrayValue);
        const std::string role = m.role == "assistant" ? "assistant" : "user";
        if (m.role == "tool") {
            Json::Value result; result["type"] = "tool_result"; result["tool_use_id"] = m.toolCallId; result["content"] = m.content;
            if (m.isError) result["is_error"] = true;
            blocks.append(result);
        } else if (m.role == "assistant" && m.providerContent.isArray() && !m.providerContent.empty()) {
            blocks = m.providerContent;
        } else {
            if (!m.content.empty()) { Json::Value text; text["type"] = "text"; text["text"] = m.content; blocks.append(text); }
            if (m.role == "assistant") for (const auto& t : m.toolCalls) {
                Json::Value tool; tool["type"] = "tool_use"; tool["id"] = t["id"]; tool["name"] = t["name"];
                tool["input"] = t["arguments"].isString() ? json::parse(t["arguments"].asString()) : t["arguments"];
                blocks.append(tool);
            }
        }
        if (blocks.empty()) continue;
        auto& messages = b["messages"];
        // Consecutive tool responses must be one user turn immediately following tool_use.
        if (!messages.empty() && messages[messages.size()-1]["role"] == role) {
            for (const auto& block : blocks) messages[messages.size()-1]["content"].append(block);
        } else {
            Json::Value msg; msg["role"] = role; msg["content"] = blocks; messages.append(msg);
        }
    }
    if (!req.tools.empty()) {
        b["tools"] = Json::Value(Json::arrayValue);
        for (const auto& t : req.tools) {
            Json::Value tool; tool["name"] = t.name; tool["description"] = t.description; tool["input_schema"] = t.parameters;
            b["tools"].append(tool);
        }
    }
    // OpenAI reasoning_effort/response_format are not part of the baseline Messages contract.
    return b;
}
LlmResponse AnthropicClient::parseResponse(const Json::Value& b) {
    LlmResponse r;
    if (b["type"] == "error" || !b["content"].isArray()) { r.error = "invalid Anthropic Messages response"; return r; }
    r.promptTokens = b["usage"].get("input_tokens", 0).asInt();
    r.completionTokens = b["usage"].get("output_tokens", 0).asInt();
    if (b["stop_reason"] == "max_tokens") { r.error = "the model stopped at its output token limit before finishing"; return r; }
    // A refusal is final: neither its partial text nor any tool_use in the same turn is acted on.
    if (b["stop_reason"] == "refusal") { r.error = "the model declined this request"; return r; }
    r.providerContent = b["content"];
    for (const auto& block : b["content"]) {
        if (block["type"] == "text" && block["text"].isString()) r.content += block["text"].asString();
        if (block["type"] == "tool_use") {
            if (!block["id"].isString() || !block["name"].isString() || !block["input"].isObject()) { r.error = "invalid Anthropic tool_use"; return r; }
            Json::Value tool; tool["id"] = block["id"]; tool["name"] = block["name"]; tool["arguments"] = json::dump(block["input"]);
            r.toolCalls.append(tool);
        }
    }
    r.promptTokens = b["usage"].get("input_tokens", 0).asInt();
    r.completionTokens = b["usage"].get("output_tokens", 0).asInt();
    r.ok = !r.content.empty() || !r.toolCalls.empty();
    if (!r.ok) r.error = "Anthropic response has no text or tool calls";
    return r;
}
LlmResponse AnthropicClient::complete(const LlmRequest& req) {
    LlmResponse result;
    auto body = json::dump(requestBody(req, ep_));
    auto url = ep_.apiBase; while (!url.empty() && url.back() == '/') url.pop_back();
    url += "/messages";
    auto res = llm::postJson(url, {"Content-Type: application/json", "anthropic-version: 2023-06-01", "x-api-key: " + ep_.apiKey}, body, ep_.timeoutMs);
    result.providerStatus = res.status;
    if (!res.error.empty()) { result.error = res.error; return result; }
    if (res.status < 200 || res.status >= 300) {
        ALOG_WARN << "Anthropic HTTP " << res.status << " for task " << req.task << ": " << llm::excerpt(res.body);
        result.error = "the AI provider returned HTTP " + std::to_string(res.status); return result;
    }
    try { return parseResponse(json::parse(res.body)); }
    catch (...) { result.error = "invalid Anthropic response JSON"; return result; }
}
}
