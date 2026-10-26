#include "LlmGateway.h"
#include "OpenAiCompatClient.h"
#include "MockLlmClient.h"
#include "SchemaValidator.h"
#include "../core/Json.h"
#include "../core/Log.h"

namespace acerciae {

LlmGateway::LlmGateway(const Config& cfg) : cfg_(cfg) {
    if (cfg.mockLlm()) client_ = std::make_unique<MockLlmClient>();
    else client_ = std::make_unique<OpenAiCompatClient>(cfg);
    ALOG_INFO << "LLM gateway mode=" << client_->mode() << " model=" << client_->modelName();
}
LlmGateway::LlmGateway(const Config& cfg, std::unique_ptr<ILlmClient> client) : cfg_(cfg), client_(std::move(client)) {}

Json::Value LlmGateway::status() const {
    Json::Value s; s["mode"] = client_->mode(); s["model"] = client_->modelName(); s["provider"] = cfg_.llmProvider;
    s["api_base"] = cfg_.mockLlm() ? "" : cfg_.llmApiBase; s["embeddings"] = !cfg_.llmEmbeddingModel.empty();
    s["note"] = cfg_.mockLlm() ? "MOCK LLM MODE: no LLM_API_KEY configured. Rule-based extraction demonstrates the pipeline end to end." : "live";
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
    for (int round = 0; round < maxRounds; ++round) {
        auto resp = client_->complete(req);
        out.llmCalls++;
        if (!resp.ok) { out.error = resp.error; return out; }
        if (resp.toolCalls.isArray() && !resp.toolCalls.empty() && exec) {
            LlmMessage assistant; assistant.role = "assistant"; assistant.content = resp.content; assistant.toolCalls = resp.toolCalls;
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
