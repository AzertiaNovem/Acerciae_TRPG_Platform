#include "AnthropicClient.h"
#include "../core/Json.h"
#include "HttpTransport.h"
#include "StreamResponse.h"
#include "../core/Log.h"
#include <vector>

namespace acerciae {
namespace {
// Blocks that may carry a cache breakpoint (thinking blocks may not).
bool cacheable(const Json::Value& block) {
    auto t = block["type"].asString();
    return t == "text" || t == "tool_result" || t == "tool_use" || t == "image" || t == "document";
}
constexpr int kMaxBreakpoints = 4;   // the Messages API accepts at most four per request
}

Json::Value AnthropicClient::requestBody(const LlmRequest& req, const LlmEndpoint& ep) {
    Json::Value b;
    b["model"] = ep.model;
    b["stream"] = true;
    b["max_tokens"] = req.maxTokens > 0 ? req.maxTokens : ep.maxTokens;
    std::string system = req.system;
    if (!req.responseSchema.isNull())
        system += "\nReturn only a JSON value matching this schema after any tool calls:\n" + json::dump(req.responseSchema);
    b["messages"] = Json::Value(Json::arrayValue);
    auto& messages = b["messages"];
    // Breakpoints asked for by the caller: (message index, block index) of the last block of each marked message.
    std::vector<std::pair<Json::ArrayIndex, Json::ArrayIndex>> marks;
    for (const auto& m : req.messages) {
        if (m.role == "system") { system += "\n" + m.content; continue; }
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
        // Consecutive tool responses must be one user turn immediately following tool_use.
        if (!messages.empty() && messages[messages.size()-1]["role"] == role) {
            for (const auto& block : blocks) messages[messages.size()-1]["content"].append(block);
        } else {
            Json::Value msg; msg["role"] = role; msg["content"] = blocks; messages.append(msg);
        }
        if (m.cacheBreakpoint) marks.push_back({messages.size() - 1, messages[messages.size()-1]["content"].size() - 1});
    }
    if (req.cache == LlmCache::off) {
        b["system"] = system;
    } else {
        // The system prompt as one marked block: the tools before it and the system prompt are cached together.
        Json::Value block; block["type"] = "text"; block["text"] = system; block["cache_control"]["type"] = "ephemeral";
        b["system"] = Json::Value(Json::arrayValue); b["system"].append(block);
        int left = kMaxBreakpoints - 1;
        if (req.cache == LlmCache::conversation && !messages.empty()) {
            auto& last = messages[messages.size()-1]["content"];
            if (!last.empty()) marks.push_back({messages.size() - 1, last.size() - 1});
        }
        // When more points are asked for than the API takes, the latest ones are kept: they cover the longest prefix.
        for (auto it = marks.rbegin(); it != marks.rend() && left > 0; ++it) {
            auto& blk = messages[it->first]["content"][it->second];
            if (!cacheable(blk) || blk.isMember("cache_control")) continue;
            blk["cache_control"]["type"] = "ephemeral";
            --left;
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
    // input_tokens is only the uncached remainder: the whole prompt adds what was read from and written to the cache.
    const auto& usage = b["usage"];
    r.cacheReadTokens = usage.get("cache_read_input_tokens", 0).asInt();
    r.cacheWriteTokens = usage.get("cache_creation_input_tokens", 0).asInt();
    r.promptTokens = usage.get("input_tokens", 0).asInt() + r.cacheReadTokens + r.cacheWriteTokens;
    r.completionTokens = usage.get("output_tokens", 0).asInt();
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
    r.ok = !r.content.empty() || !r.toolCalls.empty();
    if (!r.ok) r.error = "Anthropic response has no text or tool calls";
    return r;
}
LlmResponse AnthropicClient::complete(const LlmRequest& req) {
    LlmResponse result;
    auto body = json::dump(requestBody(req, ep_));
    auto url = ep_.apiBase; while (!url.empty() && url.back() == '/') url.pop_back();
    url += "/messages";
    // OpenRouter's Messages endpoint takes its own key as a bearer token.
    auto auth = ep_.provider == "openrouter" ? "Authorization: Bearer " + ep_.apiKey : "x-api-key: " + ep_.apiKey;
    auto res = llm::postJson(url, {"Content-Type: application/json", "anthropic-version: 2023-06-01", auth}, body, ep_.timeoutMs);
    result.providerStatus = res.status;
    if (!res.error.empty()) { result.error = res.error; return result; }
    if (res.status < 200 || res.status >= 300) {
        ALOG_WARN << "Anthropic HTTP " << res.status << " for task " << req.task << ": " << llm::excerpt(res.body);
        result.error = "the AI provider returned HTTP " + std::to_string(res.status); return result;
    }
    try { return parseResponse(llm::anthropicResponse(res.body)); }
    catch (const std::exception& e) { result.error = std::string("invalid Anthropic response: ")+e.what(); return result; }
}
}
