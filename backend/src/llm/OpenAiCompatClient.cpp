#include "OpenAiCompatClient.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <curl/curl.h>

namespace acerciae {

static size_t writeCb(char* ptr, size_t size, size_t nmemb, void* ud) {
    auto* s = static_cast<std::string*>(ud); s->append(ptr, size * nmemb); return size * nmemb;
}

std::string OpenAiCompatClient::post(const std::string& path, const std::string& body, long& status, std::string& err) {
    std::string out;
    CURL* c = curl_easy_init();
    if (!c) { err = "curl init failed"; return out; }
    std::string url = cfg_.llmApiBase; if (!url.empty() && url.back() == '/') url.pop_back(); url += path;
    struct curl_slist* hdr = nullptr;
    hdr = curl_slist_append(hdr, "Content-Type: application/json");
    hdr = curl_slist_append(hdr, ("Authorization: Bearer " + cfg_.llmApiKey).c_str());
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdr);
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, writeCb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &out);
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, (long)cfg_.llmTimeoutMs);
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    auto rc = curl_easy_perform(c);
    if (rc != CURLE_OK) err = curl_easy_strerror(rc);
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(hdr);
    curl_easy_cleanup(c);
    return out;
}

LlmResponse OpenAiCompatClient::complete(const LlmRequest& req) {
    Json::Value body;
    body["model"] = cfg_.llmModel;
    body["temperature"] = req.temperature;
    body["max_tokens"] = req.maxTokens > 0 ? req.maxTokens : cfg_.llmMaxTokens;
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
    if (!err.empty()) { r.error = "transport: " + err; return r; }
    if (status < 200 || status >= 300) { r.error = "http " + std::to_string(status) + ": " + text.substr(0, 400); return r; }
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
    r.ok = true;
    return r;
}

std::vector<float> OpenAiCompatClient::embed(const std::string& text) {
    if (cfg_.llmEmbeddingModel.empty()) return {};
    Json::Value body; body["model"] = cfg_.llmEmbeddingModel; body["input"] = text;
    long status = 0; std::string err;
    auto out = post("/embeddings", json::dump(body), status, err);
    if (!err.empty() || status < 200 || status >= 300) { ALOG_WARN << "embedding failed: " << err << " status " << status; return {}; }
    std::vector<float> v;
    try { auto j = json::parse(out); for (auto& x : j["data"][0]["embedding"]) v.push_back(x.asFloat()); } catch (...) {}
    return v;
}

} // namespace acerciae
