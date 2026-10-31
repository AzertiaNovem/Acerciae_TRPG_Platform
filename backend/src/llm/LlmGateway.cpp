#include "LlmGateway.h"
#include <algorithm>
#include "OpenAiCompatClient.h"
#include "AnthropicClient.h"
#include "MockLlmClient.h"
#include "SchemaValidator.h"
#include "../core/Json.h"
#include "../core/Log.h"

namespace acerciae {

LlmGateway::LlmGateway(const Config& cfg) : cfg_(cfg), mock_(std::make_shared<MockLlmClient>()) {
    ALOG_INFO << "LLM gateway: providers come from each server's settings (mock until a maintainer configures one)";
}
LlmGateway::LlmGateway(const Config& cfg, std::unique_ptr<ILlmClient> client) : cfg_(cfg), fixed_(std::move(client)), mock_(std::make_shared<MockLlmClient>()) {}

LlmGateway::Limits LlmGateway::limitsForTask(const std::string& task) const {
    if (task == "vn_script") return {cfg_.llmVnMaxTokens, cfg_.llmVnTimeoutMs};
    if (task == "module_structure" || task == "script_knowledge") return {cfg_.llmModuleMaxTokens, cfg_.llmModuleTimeoutMs};
    return {cfg_.llmMaxTokens, cfg_.llmTimeoutMs};
}

LlmGateway::Resolved LlmGateway::clientFor(const std::string& channelId, const std::string& task) const {
    Resolved r; r.client = mock_; r.provider = "mock";
    if (fixed_) { r.client = fixed_; r.fixed = true; return r; }
    if (channelId.empty() || !resolver_) return r;
    auto profile = resolver_(channelId);   // throws when the server's key cannot be unsealed: never fall back silently
    if (!profile) return r;
    r.language = profile->language;
    auto ep = profile->endpoint;
    auto limits = limitsForTask(task);
    ep.timeoutMs = limits.timeoutMs;
    ep.maxTokens = limits.maxTokens;
    if (ep.provider == "mock" || ep.apiKey.empty()) return r;
    r.provider = ep.provider; r.embeddingModel = ep.embeddingModel;
    auto key = ep.provider + "\n" + std::to_string(ep.timeoutMs) + "\n" + std::to_string(ep.maxTokens) + "\n" + ep.apiBase + "\n" + ep.apiKey + "\n" + ep.model + "\n" + ep.reasoningEffort + "\n" + ep.embeddingModel;
    std::lock_guard<std::mutex> lk(mu_);
    auto it = clients_.find(key);
    if (it == clients_.end()) {
        if (clients_.size() >= 256) clients_.clear();   // settings changes leave old entries behind
        std::shared_ptr<ILlmClient> c;
        if (ep.provider == "anthropic") c = std::make_shared<AnthropicClient>(ep);
        else c = std::make_shared<OpenAiCompatClient>(ep);
        it = clients_.emplace(key, c).first;
    }
    r.client = it->second;
    return r;
}

bool LlmGateway::embeddingsAvailable(const std::string& channelId) const {
    try { auto r = clientFor(channelId); return r.client->mode() == "live" && r.provider == "openai_compatible" && !r.embeddingModel.empty(); }
    catch (...) { return false; }
}
std::vector<float> LlmGateway::embed(const std::string& channelId, const std::string& text) {
    if (!embeddingsAvailable(channelId)) return {};
    auto r = clientFor(channelId);
    try {
        if (meter_) meter_->checkTokens(channelId);
        std::shared_ptr<void> slot = meter_ ? meter_->acquire(channelId) : nullptr;
        auto v = r.client->embed(text);
        if (meter_) meter_->recordTokens(channelId, "embedding", (int)(text.size() / 4) + 1, 0);   // providers bill input only; estimate
        return v;
    } catch (const std::exception& e) { ALOG_WARN << "embedding skipped: " << e.what(); return {}; }
}

std::string LlmGateway::languageName(const std::string& code) {
    static const std::map<std::string, std::string> names = {
        {"zh", "Simplified Chinese"}, {"zh-CN", "Simplified Chinese"}, {"zh-TW", "Traditional Chinese"}, {"ja", "Japanese"}, {"ko", "Korean"},
        {"es", "Spanish"}, {"fr", "French"}, {"de", "German"}, {"ru", "Russian"}, {"pt", "Portuguese"}, {"it", "Italian"}};
    auto it = names.find(code);
    return it == names.end() ? "" : it->second;
}

Json::Value LlmGateway::status(const std::string& channelId) const {
    Json::Value s;
    Resolved r;
    try { r = clientFor(channelId); }
    catch (const std::exception& e) { s["mode"] = "error"; s["model"] = ""; s["provider"] = ""; s["note"] = e.what(); s["embeddings"] = false; s["language"] = "en"; return s; }
    bool mock = r.client->mode() == "mock";
    s["mode"] = r.client->mode(); s["model"] = r.client->modelName(); s["provider"] = r.provider;
    s["embeddings"] = embeddingsAvailable(channelId);
    s["language"] = r.language.empty() ? "en" : r.language;
    s["note"] = mock ? "MOCK LLM MODE: this server has no AI provider configured. Rule-based extraction demonstrates the pipeline end to end." : "live";
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
    const bool moduleTask = req.task == "module_structure" || req.task == "script_knowledge";
    // Central defaults also lift legacy per-task limits; the module limit can be tuned independently.
    req.maxTokens = (moduleTask || req.task == "vn_script") ? limitsForTask(req.task).maxTokens : std::max(req.maxTokens, cfg_.llmMaxTokens);
    if (req.temperature < 0) req.temperature = cfg_.llmTemperature;
    if (!exec) req.tools.clear();
    Resolved resolved;
    try { resolved = clientFor(req.channelId, req.task); }
    catch (const std::exception& e) { out.error = e.what(); return out; }
    auto& client = *resolved.client;
    // Mock calls cost nothing; live calls spend the server's budget and hold one of its concurrent AI slots.
    AiMeter* meter = client.mode() == "live" && !resolved.fixed ? meter_ : nullptr;
    auto lang = languageName(resolved.language);
    if (!lang.empty())
        req.system += "\n\nOutput language: write every human-readable string (summaries, titles, rationale, descriptions, drafts) in " + lang +
                      ". Keep JSON keys, enum values, status values and ids exactly as specified.";
    for (int round = 0; round < maxRounds; ++round) {
        LlmResponse resp;
        try {
            if (meter) meter->checkTokens(req.channelId);
            std::shared_ptr<void> slot = meter ? meter->acquire(req.channelId) : nullptr;
            resp = client.complete(req);
        } catch (const std::exception& e) { out.error = e.what(); return out; }
        out.llmCalls++;
        if (meter && (resp.promptTokens || resp.completionTokens)) {
            try { meter->recordTokens(req.channelId, req.task, resp.promptTokens, resp.completionTokens); } catch (const std::exception& e) { ALOG_WARN << "AI usage not recorded: " << e.what(); }
        }
        if (!resp.ok) { out.error = resp.error; out.providerStatus = resp.providerStatus; return out; }
        if (resp.toolCalls.isArray() && !resp.toolCalls.empty() && exec) {
            LlmMessage assistant; assistant.role = "assistant"; assistant.content = resp.content; assistant.toolCalls = resp.toolCalls; assistant.providerContent = resp.providerContent;
            req.messages.push_back(assistant);
            for (auto& tc : resp.toolCalls) {
                Json::Value args;
                try { args = tc["arguments"].isString() ? json::parse(tc["arguments"].asString()) : tc["arguments"]; } catch (...) { args = Json::Value(Json::objectValue); }
                Json::Value result;
                bool failed = false;
                try { result = exec(tc["name"].asString(), args); }
                catch (const std::exception& e) { result["error"] = e.what(); failed = true; }
                out.toolCalls++;
                LlmMessage tm; tm.role = "tool"; tm.toolCallId = tc["id"].asString(); tm.name = tc["name"].asString(); tm.content = json::dump(result); tm.isError = failed;
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
