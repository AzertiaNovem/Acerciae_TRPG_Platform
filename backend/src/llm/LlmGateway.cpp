#include "LlmGateway.h"
#include "OpenAiCompatClient.h"
#include "AnthropicClient.h"
#include "MockLlmClient.h"
#include "SchemaValidator.h"
#include "../core/Json.h"
#include "../core/Log.h"

namespace acerciae {

LlmGateway::LlmGateway(const Config& cfg) : cfg_(cfg), mock_(std::make_shared<MockLlmClient>()) {
    if (cfg.mockLlm()) client_ = mock_;
    else if (cfg.llmProvider == "anthropic") client_ = std::make_shared<AnthropicClient>(OpenAiCompatClient::endpointFrom(cfg));
    else client_ = std::make_shared<OpenAiCompatClient>(cfg);
    ALOG_INFO << "LLM gateway mode=" << client_->mode() << " model=" << client_->modelName();
}
LlmGateway::LlmGateway(const Config& cfg, std::unique_ptr<ILlmClient> client) : cfg_(cfg), client_(std::move(client)), mock_(std::make_shared<MockLlmClient>()) {}

LlmGateway::Resolved LlmGateway::clientFor(const std::string& channelId) const {
    Resolved r; r.client = client_; r.provider = cfg_.llmProvider;
    if (channelId.empty() || !resolver_) return r;
    // A broken server credential must not silently send private requests to the platform provider.
    auto profile = resolver_(channelId);
    if (!profile) return r;
    r.language = profile->language;
    const auto& ep = profile->endpoint;
    r.provider = ep.provider;
    if (ep.apiKey.empty()) { r.client = mock_; r.custom = true; return r; }
    auto key = ep.provider + "\n" + std::to_string(ep.timeoutMs) + "\n" + std::to_string(ep.maxTokens) + "\n" + ep.apiBase + "\n" + ep.apiKey + "\n" + ep.model + "\n" + ep.reasoningEffort + "\n" + ep.embeddingModel;
    std::lock_guard<std::mutex> lk(mu_);
    auto& c = clients_[key];
    if (!c) {
        if (ep.provider == "anthropic") c = std::make_shared<AnthropicClient>(ep);
        else c = std::make_shared<OpenAiCompatClient>(ep);
    }
    r.client = c; r.custom = true;
    return r;
}

std::string LlmGateway::languageName(const std::string& code) {
    static const std::map<std::string, std::string> names = {
        {"zh", "Simplified Chinese"}, {"zh-CN", "Simplified Chinese"}, {"zh-TW", "Traditional Chinese"}, {"ja", "Japanese"}, {"ko", "Korean"},
        {"es", "Spanish"}, {"fr", "French"}, {"de", "German"}, {"ru", "Russian"}, {"pt", "Portuguese"}, {"it", "Italian"}};
    auto it = names.find(code);
    return it == names.end() ? "" : it->second;
}

Json::Value LlmGateway::status(const std::string& channelId) const {
    auto r = clientFor(channelId);
    bool mock = r.client->mode() == "mock";
    Json::Value s; s["mode"] = r.client->mode(); s["model"] = r.client->modelName(); s["provider"] = r.provider;
    s["source"] = r.custom ? "server" : "process";
    s["api_base"] = mock || r.custom ? "" : cfg_.llmApiBase; s["embeddings"] = cfg_.llmProvider == "openai_compatible" && !cfg_.llmEmbeddingModel.empty();
    s["language"] = r.language.empty() ? "en" : r.language;
    s["note"] = mock ? "MOCK LLM MODE: no LLM API key configured. Rule-based extraction demonstrates the pipeline end to end." : "live";
    return s;
}

Json::Value LlmGateway::extractJson(const std::string& content) {
    // Accept raw JSON or JSON inside ```json fences / surrounding prose.
    auto s = content;
    auto fence = s.find("```");
    if (fence != std::string::npos) {
        auto start = s.find('\n', fence); auto end = s.rfind("```");
        if (start != std::string::npos && end != std::string::npos && end > start) s = s.substr(start + 1, end - start - 1);
    }
    auto a = s.find_first_of("{["); auto b = s.find_last_of("}]");
    if (a == std::string::npos || b == std::string::npos || b < a) throw std::runtime_error("no JSON object in model output");
    return json::parse(s.substr(a, b - a + 1));
}

LlmGateway::Outcome LlmGateway::runStructured(LlmRequest req, ToolExecutor exec, int maxRounds) {
    Outcome out;
    if (req.maxTokens <= 0) req.maxTokens = cfg_.llmMaxTokens;
    if (req.temperature < 0) req.temperature = cfg_.llmTemperature;
    if (!exec) req.tools.clear();
    auto resolved = clientFor(req.channelId);
    auto& client = *resolved.client;
    auto lang = languageName(resolved.language);
    if (!lang.empty())
        req.system += "\n\nOutput language: write every human-readable string (summaries, titles, rationale, descriptions, drafts) in " + lang +
                      ". Keep JSON keys, enum values, status values and ids exactly as specified.";
    for (int round = 0; round < maxRounds; ++round) {
        auto resp = client.complete(req);
        out.llmCalls++;
        if (!resp.ok) { out.error = resp.error; return out; }
        if (resp.toolCalls.isArray() && !resp.toolCalls.empty() && exec) {
            LlmMessage assistant; assistant.role = "assistant"; assistant.content = resp.content; assistant.toolCalls = resp.toolCalls; assistant.providerContent = resp.providerContent;
            req.messages.push_back(assistant);
            for (auto& tc : resp.toolCalls) {
                Json::Value args;
                try { args = tc["arguments"].isString() ? json::parse(tc["arguments"].asString()) : tc["arguments"]; } catch (...) { args = Json::Value(Json::objectValue); }
                Json::Value result;
                try { result = exec(tc["name"].asString(), args); }
                catch (const std::exception& e) { result["error"] = e.what(); }
                out.toolCalls++;
                LlmMessage tm; tm.role = "tool"; tm.toolCallId = tc["id"].asString(); tm.name = tc["name"].asString(); tm.content = json::dump(result);
                req.messages.push_back(tm);
            }
            continue;
        }
        out.rawContent = resp.content;
        if (req.responseSchema.isNull()) { out.ok = true; out.data = resp.content; return out; }
        try {
            auto data = extractJson(resp.content);
            std::vector<std::string> errs;
            if (!SchemaValidator::validate(req.responseSchema, data, errs)) {
                ALOG_WARN << "LLM output for task '" << req.task << "' failed schema validation: " << SchemaValidator::errorsToString(errs);
                if (round + 1 < maxRounds) {
                    // One repair attempt: tell the model what was wrong.
                    LlmMessage a; a.role = "assistant"; a.content = resp.content; req.messages.push_back(a);
                    LlmMessage u; u.role = "user"; u.content = "Your JSON did not match the required schema: " + SchemaValidator::errorsToString(errs) + ". Reply with corrected JSON only.";
                    req.messages.push_back(u);
                    continue;
                }
                out.error = "schema validation failed: " + SchemaValidator::errorsToString(errs);
                return out;
            }
            out.ok = true; out.data = data; return out;
        } catch (const std::exception& e) {
            out.error = std::string("unparseable model output: ") + e.what();
            return out;
        }
    }
    out.error = "tool loop exceeded max rounds";
    return out;
}

} // namespace acerciae
