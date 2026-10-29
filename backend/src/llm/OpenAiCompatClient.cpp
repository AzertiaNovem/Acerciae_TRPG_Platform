#include "OpenAiCompatClient.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "HttpTransport.h"

namespace acerciae {

std::string OpenAiCompatClient::post(const std::string& path, const std::string& body, long& status, std::string& err) {
    std::string url = ep_.apiBase; while (!url.empty() && url.back() == '/') url.pop_back(); url += path;
    auto res = llm::postJson(url, {"Content-Type: application/json", "Authorization: Bearer " + ep_.apiKey}, body, ep_.timeoutMs);
    status = res.status; err = res.error;
    return res.body;
}

LlmResponse OpenAiCompatClient::complete(const LlmRequest& req) {
    Json::Value body;
    body["model"] = ep_.model;
    int maxTokens = req.maxTokens > 0 ? req.maxTokens : ep_.maxTokens;
    if (!ep_.reasoningEffort.empty()) {
        // Reasoning models take an effort level and max_completion_tokens, and reject a custom temperature.
        body["reasoning_effort"] = ep_.reasoningEffort;
        body["max_completion_tokens"] = maxTokens;
    } else {
        body["temperature"] = req.temperature;
        body["max_tokens"] = maxTokens;
    }
    Json::Value msgs(Json::arrayValue);
    if (!req.system.empty()) { Json::Value m; m["role"] = "system"; m["content"] = req.system; msgs.append(m); }
    for (auto& m : req.messages) {
        Json::Value j; j["role"] = m.role; j["content"] = m.content;
        if (m.role == "assistant" && m.toolCalls.isArray() && !m.toolCalls.empty()) {
            Json::Value tcs(Json::arrayValue);
            for (auto& tc : m.toolCalls) {
                Json::Value t; t["id"] = tc["id"]; t["type"] = "function";
                t["function"]["name"] = tc["name"]; t["function"]["arguments"] = tc["arguments"].isString() ? tc["arguments"] : Json::Value(json::dump(tc["arguments"]));
                tcs.append(t);
            }
            j["tool_calls"] = tcs;
            if (m.content.empty()) j["content"] = Json::Value();
        }
        if (m.role == "tool") { j["tool_call_id"] = m.toolCallId; j["name"] = m.name; }
        msgs.append(j);
    }
    body["messages"] = msgs;
    if (!req.tools.empty()) {
        Json::Value tools(Json::arrayValue);
        for (auto& t : req.tools) { Json::Value j; j["type"] = "function"; j["function"]["name"] = t.name; j["function"]["description"] = t.description; j["function"]["parameters"] = t.parameters; tools.append(j); }
        body["tools"] = tools; body["tool_choice"] = "auto";
    }
    if (!req.responseSchema.isNull()) body["response_format"]["type"] = "json_object";

    LlmResponse r;
    long status = 0; std::string err;
    auto text = post("/chat/completions", json::dump(body), status, err);
    r.providerStatus = status;
    if (!err.empty()) { r.error = err; return r; }
    if (status < 200 || status >= 300) {
        // Provider bodies stay in the server log: they can carry account details and anything a host chose to answer.
        ALOG_WARN << "LLM provider HTTP " << status << " for task " << req.task << ": " << llm::excerpt(text);
        r.error = "the AI provider returned HTTP " + std::to_string(status); return r;
    }
    Json::Value j;
    try { j = json::parse(text); } catch (const std::exception& e) { r.error = std::string("bad json: ") + e.what(); return r; }
    if (!j["choices"].isArray() || j["choices"].empty()) { r.error = "no choices in response"; return r; }
    const auto& msg = j["choices"][0]["message"];
    if (msg["content"].isString()) r.content = msg["content"].asString();
    if (msg["tool_calls"].isArray()) {
        for (auto& tc : msg["tool_calls"]) {
            Json::Value t; t["id"] = tc["id"]; t["name"] = tc["function"]["name"];
            t["arguments"] = tc["function"]["arguments"].isString() ? tc["function"]["arguments"].asString() : json::dump(tc["function"]["arguments"]);
            r.toolCalls.append(t);
        }
    }
    r.promptTokens = j["usage"]["prompt_tokens"].asInt(); r.completionTokens = j["usage"]["completion_tokens"].asInt();
    if (j["choices"][0]["finish_reason"] == "length") {
        r.error = "the model stopped at its output token limit before finishing"; return r;
    }
    r.ok = true;
    return r;
}

std::vector<float> OpenAiCompatClient::embed(const std::string& text) {
    if (ep_.embeddingModel.empty()) return {};
    Json::Value body; body["model"] = ep_.embeddingModel; body["input"] = text;
    long status = 0; std::string err;
    auto out = post("/embeddings", json::dump(body), status, err);
    if (!err.empty() || status < 200 || status >= 300) { ALOG_WARN << "embedding failed: " << err << " status " << status; return {}; }
    std::vector<float> v;
    try { auto j = json::parse(out); for (auto& x : j["data"][0]["embedding"]) v.push_back(x.asFloat()); } catch (...) {}
    return v;
}

} // namespace acerciae
