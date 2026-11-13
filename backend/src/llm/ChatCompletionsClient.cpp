#include "ChatCompletionsClient.h"
#include "HttpTransport.h"
#include "StreamResponse.h"
#include "../core/Json.h"
#include "../core/Log.h"

namespace acerciae {

std::string ChatCompletionsClient::baseUrl(const LlmEndpoint& ep) {
    auto base = ep.apiBase; while (!base.empty() && base.back() == '/') base.pop_back();
    if (ep.provider == "alibaba" && base.find("/compatible-mode") == std::string::npos) base += "/compatible-mode/v1";
    return base;
}

Json::Value ChatCompletionsClient::requestBody(const LlmRequest& req, const LlmEndpoint& ep) {
    Json::Value body;
    body["model"] = ep.model;
    body["stream"] = true;
    body["stream_options"]["include_usage"] = true;
    int maxTokens = req.maxTokens > 0 ? req.maxTokens : ep.maxTokens;
    // OpenAI's own reasoning models only take max_completion_tokens; other gateways know max_tokens.
    if (ep.provider == "openai") body["max_completion_tokens"] = maxTokens; else body["max_tokens"] = maxTokens;
    if (!ep.reasoningEffort.empty() && ep.provider == "openai") body["reasoning_effort"] = ep.reasoningEffort;
    else if (!ep.reasoningEffort.empty() && ep.provider == "openrouter") body["reasoning"]["effort"] = ep.reasoningEffort;
    else body["temperature"] = req.temperature;
    Json::Value messages(Json::arrayValue);
    std::string system = req.system;
    if (!req.responseSchema.isNull()) system += (system.empty() ? "" : "\n\n") + std::string("Return the final answer as a JSON object matching the requested schema.");
    if (!system.empty()) { Json::Value m; m["role"] = "system"; m["content"] = system; messages.append(m); }
    for (const auto& m : req.messages) {
        Json::Value j;
        if (m.role == "tool") { j["role"] = "tool"; j["tool_call_id"] = m.toolCallId; j["content"] = m.content; messages.append(j); continue; }
        j["role"] = m.role == "assistant" ? "assistant" : m.role == "system" ? "system" : "user";
        j["content"] = m.content;
        if (m.role == "assistant" && m.toolCalls.isArray() && !m.toolCalls.empty()) {
            if (m.content.empty()) j["content"] = Json::Value();
            for (const auto& tc : m.toolCalls) {
                Json::Value c; c["id"] = tc["id"]; c["type"] = "function"; c["function"]["name"] = tc["name"];
                c["function"]["arguments"] = tc["arguments"].isString() ? tc["arguments"] : Json::Value(json::dump(tc["arguments"]));
                j["tool_calls"].append(c);
            }
        }
        messages.append(j);
    }
    body["messages"] = messages;
    if (!req.tools.empty()) {
        Json::Value tools(Json::arrayValue);
        for (const auto& t : req.tools) {
            Json::Value j; j["type"] = "function"; j["function"]["name"] = t.name; j["function"]["description"] = t.description; j["function"]["parameters"] = t.parameters;
            tools.append(j);
        }
        body["tools"] = tools; body["tool_choice"] = "auto";
    }
    if (!req.responseSchema.isNull()) body["response_format"]["type"] = "json_object";
    return body;
}

LlmResponse ChatCompletionsClient::parseResponse(const Json::Value& j) {
    LlmResponse r;
    r.promptTokens = j["usage"]["prompt_tokens"].asInt(); r.completionTokens = j["usage"]["completion_tokens"].asInt();
    r.cacheReadTokens = j["usage"]["prompt_tokens_details"]["cached_tokens"].asInt();
    if (j["error"].isObject()) { r.error = "the AI provider reported a failed response"; return r; }
    if (!j["choices"].isArray() || j["choices"].empty()) { r.error = "no output in response"; return r; }
    const auto& choice = j["choices"][0];
    const auto& m = choice["message"];
    auto finish = choice["finish_reason"].asString();
    if (m["refusal"].isString() && !m["refusal"].asString().empty()) { r.error = "the model declined this request"; return r; }
    if (finish == "content_filter") { r.error = "the model declined this request"; return r; }
    if (m["content"].isString()) r.content = m["content"].asString();
    else if (m["content"].isArray()) for (const auto& part : m["content"]) if (part["text"].isString()) r.content += part["text"].asString();
    for (const auto& tc : m["tool_calls"]) {
        Json::Value t; t["id"] = tc["id"]; t["name"] = tc["function"]["name"];
        t["arguments"] = tc["function"]["arguments"].isString() ? tc["function"]["arguments"].asString() : json::dump(tc["function"]["arguments"]);
        r.toolCalls.append(t);
    }
    if (finish == "length" && r.toolCalls.empty()) { r.error = "the model stopped at its output token limit before finishing"; return r; }
    r.providerContent = m;
    r.ok = !r.content.empty() || !r.toolCalls.empty();
    if (!r.ok) r.error = "the AI response was empty";
    return r;
}

LlmResponse ChatCompletionsClient::complete(const LlmRequest& req) {
    LlmResponse r;
    std::vector<std::string> headers = {"Content-Type: application/json", "Authorization: Bearer " + ep_.apiKey};
    if (ep_.provider == "openrouter") headers.push_back("X-OpenRouter-Title: Acerciae");
    auto res = llm::postJson(baseUrl(ep_) + "/chat/completions", headers, json::dump(requestBody(req, ep_)), ep_.timeoutMs);
    r.providerStatus = res.status;
    if (!res.error.empty()) { r.error = res.error; return r; }
    if (res.status < 200 || res.status >= 300) {
        ALOG_WARN << "LLM provider HTTP " << res.status << " for task " << req.task << ": " << llm::excerpt(res.body);
        r.error = "the AI provider returned HTTP " + std::to_string(res.status); return r;
    }
    Json::Value j;
    try { j = llm::chatCompletionsResponse(res.body); } catch (const std::exception& e) { r.error = std::string("bad response: ") + e.what(); return r; }
    r = parseResponse(j);
    r.providerStatus = res.status;
    return r;
}

} // namespace acerciae
