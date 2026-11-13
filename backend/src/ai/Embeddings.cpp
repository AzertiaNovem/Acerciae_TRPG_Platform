#include "Embeddings.h"
#include "AiHttp.h"
#include "AwsSigV4.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <cmath>

namespace acerciae::ai {

std::vector<float> fitDimensions(std::vector<float> v) {
    if (v.empty()) return v;
    if (v.size() < kEmbeddingDimensions) { v.resize(kEmbeddingDimensions, 0.f); return v; }
    if (v.size() > kEmbeddingDimensions) {
        v.resize(kEmbeddingDimensions);
        double norm = 0; for (float x : v) norm += double(x) * x;
        norm = std::sqrt(norm);
        if (norm > 0) for (auto& x : v) x = float(x / norm);
    }
    return v;
}

static std::vector<float> floats(const Json::Value& a) {
    std::vector<float> v; v.reserve(a.size());
    for (const auto& x : a) v.push_back(x.asFloat());
    return v;
}

// OpenAI-style: ask for 1536 dimensions; a model that rejects the field is asked again without it.
static std::vector<float> openAiStyle(const std::string& base, const LlmEndpoint& ep, const std::string& text, const std::vector<std::string>& extra) {
    std::vector<std::string> headers = {"Content-Type: application/json", "Authorization: Bearer " + ep.apiKey};
    headers.insert(headers.end(), extra.begin(), extra.end());
    for (int attempt = 0; attempt < 2; ++attempt) {
        Json::Value body; body["model"] = ep.model; body["input"] = text; body["encoding_format"] = "float";
        if (attempt == 0) body["dimensions"] = (int)kEmbeddingDimensions;
        auto r = http::post(http::joinUrl(base, "/embeddings"), headers, json::dump(body), ep.timeoutMs);
        if (r.error.empty() && r.status >= 200 && r.status < 300) {
            try { return fitDimensions(floats(json::parse(r.body)["data"][0]["embedding"])); } catch (...) { return {}; }
        }
        if (attempt == 0 && r.status == 400) continue;
        ALOG_WARN << "embedding failed (" << ep.provider << "): HTTP " << r.status << " " << r.error << " " << llm::excerpt(r.body);
        return {};
    }
    return {};
}

static std::vector<float> google(const LlmEndpoint& ep, const std::string& text) {
    auto model = ep.model.rfind("models/", 0) == 0 ? ep.model : "models/" + ep.model;
    Json::Value body; body["model"] = model; body["content"]["parts"][0]["text"] = text;
    body["output_dimensionality"] = (int)kEmbeddingDimensions;
    auto r = http::post(http::joinUrl(ep.apiBase, "/" + http::uriPath(model) + ":embedContent"),
                        {"Content-Type: application/json", "x-goog-api-key: " + ep.apiKey}, json::dump(body), ep.timeoutMs);
    if (!r.error.empty() || r.status < 200 || r.status >= 300) { ALOG_WARN << "embedding failed (google): HTTP " << r.status << " " << r.error << " " << llm::excerpt(r.body); return {}; }
    try {
        auto v = floats(json::parse(r.body)["embedding"]["values"]);
        // Fewer than the full 3072 dimensions are not normalised by the API.
        double norm = 0; for (float x : v) norm += double(x) * x; norm = std::sqrt(norm);
        if (norm > 0) for (auto& x : v) x = float(x / norm);
        return fitDimensions(v);
    } catch (...) { return {}; }
}

// Bedrock InvokeModel, signed with SigV4 (service "bedrock").
static std::vector<float> bedrock(const LlmEndpoint& ep, const std::string& text) {
    bool cohere = ep.model.find("cohere.") != std::string::npos;
    Json::Value body;
    if (cohere) { body["texts"][0] = text; body["input_type"] = "search_document"; body["output_dimension"] = (int)kEmbeddingDimensions; body["embedding_types"][0] = "float"; }
    else { body["inputText"] = text; body["dimensions"] = 1024; body["normalize"] = true; }
    auto payload = json::dump(body);
    auto url = http::joinUrl(ep.apiBase, "/model/" + aws::uriEncode(ep.model) + "/invoke");
    aws::Request req; req.host = http::hostOf(url); req.path = http::pathOf(url); req.body = payload;
    req.headers = {{"content-type", "application/json"}, {"accept", "application/json"}};
    aws::Credentials c{ep.access.option("access_key_id"), ep.apiKey, ep.access.secret("session_token"), ep.access.option("region", "us-east-1")};
    auto r = http::post(url, aws::sign(req, c, "bedrock"), payload, ep.timeoutMs);
    if (!r.error.empty() || r.status < 200 || r.status >= 300) { ALOG_WARN << "embedding failed (aws): HTTP " << r.status << " " << r.error << " " << llm::excerpt(r.body); return {}; }
    try {
        auto j = json::parse(r.body);
        if (cohere) { const auto& e = j["embeddings"]; return fitDimensions(floats(e.isObject() ? e["float"][0] : e[0])); }
        return fitDimensions(floats(j["embedding"]));
    } catch (...) { return {}; }
}

std::vector<float> embed(const LlmEndpoint& ep, const std::string& text) {
    if (ep.model.empty() || text.empty()) return {};
    if (ep.provider == "google") return google(ep, text);
    if (ep.provider == "aws") return bedrock(ep, text);
    if (ep.provider == "alibaba") return openAiStyle(http::joinUrl(ep.apiBase, "/compatible-mode/v1"), ep, text, {});
    if (ep.provider == "openrouter") return openAiStyle(ep.apiBase, ep, text, {"X-OpenRouter-Title: Acerciae"});
    if (ep.provider == "openai" || ep.provider == "responses") return openAiStyle(ep.apiBase, ep, text, {});
    return {};
}

} // namespace acerciae::ai
