#include "AnthropicClient.h"
#include "../core/Json.h"
#include <curl/curl.h>

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
    if (b["stop_reason"] == "max_tokens") { r.error = "Anthropic response reached max_tokens; increase LLM_MAX_TOKENS"; return r; }
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
    auto* c = curl_easy_init();
    if (!c) { result.error = "HTTP client unavailable"; return result; }
    curl_slist* h = nullptr;
    h = curl_slist_append(h, "Content-Type: application/json");
    h = curl_slist_append(h, "anthropic-version: 2023-06-01");
    h = curl_slist_append(h, ("x-api-key: " + ep_.apiKey).c_str());
    std::string output;
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, (long)ep_.timeoutMs);
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, +[](char* p, size_t s, size_t n, void* ctx) -> size_t {
        auto& out = *static_cast<std::string*>(ctx);
        if (s*n > 16*1024*1024 - out.size()) return 0;
        out.append(p, s*n); return s*n;
    });
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &output);
    const auto rc = curl_easy_perform(c);
    long status = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(h); curl_easy_cleanup(c);
    if (rc != CURLE_OK || status < 200 || status >= 300) {
        result.error = "Anthropic request failed (HTTP " + std::to_string(status) + ")"; return result;
    }
    try { return parseResponse(json::parse(output)); }
    catch (...) { result.error = "invalid Anthropic response JSON"; return result; }
}
}
