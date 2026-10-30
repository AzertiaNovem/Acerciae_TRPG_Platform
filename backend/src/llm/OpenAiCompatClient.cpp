#include "OpenAiCompatClient.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "HttpTransport.h"
#include "StreamResponse.h"

namespace acerciae {

std::string OpenAiCompatClient::post(const std::string& path, const std::string& body, long& status, std::string& err) {
    std::string url = ep_.apiBase; while (!url.empty() && url.back() == '/') url.pop_back(); url += path;
    auto res = llm::postJson(url, {"Content-Type: application/json", "Authorization: Bearer " + ep_.apiKey}, body, ep_.timeoutMs);
    status = res.status; err = res.error;
    return res.body;
}

Json::Value OpenAiCompatClient::requestBody(const LlmRequest& req, const LlmEndpoint& ep) {
    Json::Value body;
    body["model"] = ep.model;
    body["stream"] = true;
    body["store"] = false;    // nothing kept by the provider; every request carries its whole conversation
    body["max_output_tokens"] = req.maxTokens > 0 ? req.maxTokens : ep.maxTokens;
    // Reasoning models take an effort level and reject a custom temperature.
    if (!ep.reasoningEffort.empty()) body["reasoning"]["effort"] = ep.reasoningEffort;
    else body["temperature"] = req.temperature;
    if (!req.system.empty()) body["instructions"] = req.system;
    Json::Value input(Json::arrayValue);
    if (!req.responseSchema.isNull()) {
        // Some Responses gateways validate JSON mode against input only, ignoring instructions.
        // Keep this explicit even on tool-result turns; serialized JSON data is not an instruction.
        Json::Value format;
        format["role"] = "system";
        format["content"] = "Return the final answer as a JSON object matching the requested schema.";
        input.append(format);
    }
    for (auto& m : req.messages) {
        if (m.role == "tool") {
            Json::Value j; j["type"] = "function_call_output"; j["call_id"] = m.toolCallId; j["output"] = m.content; input.append(j);
            continue;
        }
        if (!m.content.empty() || !(m.role == "assistant" && m.toolCalls.isArray() && !m.toolCalls.empty())) {
            Json::Value j; j["role"] = m.role == "assistant" ? "assistant" : m.role == "system" ? "system" : "user"; j["content"] = m.content; input.append(j);
        }
        if (m.role == "assistant" && m.toolCalls.isArray())
            for (auto& tc : m.toolCalls) {
                Json::Value j; j["type"] = "function_call"; j["call_id"] = tc["id"]; j["name"] = tc["name"];
                j["arguments"] = tc["arguments"].isString() ? tc["arguments"] : Json::Value(json::dump(tc["arguments"]));
                input.append(j);
            }
    }
    body["input"] = input;
    if (!req.tools.empty()) {
        Json::Value tools(Json::arrayValue);
        // strict:false: the platform's tool schemas are plain JSON schemas, not strict-mode ones.
        for (auto& t : req.tools) { Json::Value j; j["type"] = "function"; j["name"] = t.name; j["description"] = t.description; j["parameters"] = t.parameters; j["strict"] = false; tools.append(j); }
        body["tools"] = tools; body["tool_choice"] = "auto";
    }
    if (!req.responseSchema.isNull()) body["text"]["format"]["type"] = "json_object";
    return body;
}

LlmResponse OpenAiCompatClient::parseResponse(const Json::Value& j) {
    LlmResponse r;
    r.promptTokens = j["usage"]["input_tokens"].asInt(); r.completionTokens = j["usage"]["output_tokens"].asInt();
    auto status = j["status"].asString();
    auto reason = j["incomplete_details"]["reason"].asString();
    if (status == "failed" || j["error"].isObject()) { r.error = "the AI provider reported a failed response"; return r; }
    if (status == "incomplete" && reason == "max_output_tokens") { r.error = "the model stopped at its output token limit before finishing"; return r; }
    if (status == "incomplete" && reason == "content_filter") { r.error = "the model declined this request"; return r; }
    if (!j["output"].isArray() || j["output"].empty()) { r.error = "no output in response"; return r; }
    for (const auto& item : j["output"]) {
        auto type = item["type"].asString();
        if (type == "message") {
            for (const auto& c : item["content"]) {
                if (c["type"] == "output_text" && c["text"].isString()) r.content += c["text"].asString();
                if (c["type"] == "refusal") { r.error = "the model declined this request"; return r; }
            }
        } else if (type == "function_call") {
            Json::Value t; t["id"] = item["call_id"]; t["name"] = item["name"];
            t["arguments"] = item["arguments"].isString() ? item["arguments"].asString() : json::dump(item["arguments"]);
            r.toolCalls.append(t);
        }   // reasoning items are not replayed (store:false)
    }
    if (status == "incomplete") { r.error = "the AI response was incomplete" + (reason.empty() ? std::string() : " (" + reason + ")"); return r; }
    r.ok = true;
    return r;
}

LlmResponse OpenAiCompatClient::complete(const LlmRequest& req) {
    LlmResponse r;
    long status = 0; std::string err;
    auto text = post("/responses", json::dump(requestBody(req, ep_)), status, err);
    r.providerStatus = status;
    if (!err.empty()) { r.error = err; return r; }
    if (status < 200 || status >= 300) {
        // Provider bodies stay in the server log: they can carry account details and anything a host chose to answer.
        ALOG_WARN << "LLM provider HTTP " << status << " for task " << req.task << ": " << llm::excerpt(text);
        r.error = "the AI provider returned HTTP " + std::to_string(status); return r;
    }
    Json::Value j;
    try { j = llm::responsesResponse(text); } catch (const std::exception& e) { r.error = std::string("bad json: ") + e.what(); return r; }
    r = parseResponse(j);
    r.providerStatus = status;
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
