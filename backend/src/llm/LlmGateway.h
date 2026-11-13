#pragma once
#include "Llm.h"
#include "../core/Config.h"
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <functional>

namespace acerciae {

// The only module that talks to a model. Runs the tool-call loop and validates structured output against a schema
// before returning it. Providers, models and keys come from each server's settings through the profile resolver;
// a channel whose server has no live provider runs in mock mode. Live calls are metered by the server's AI policy.
class LlmGateway {
public:
    using ToolExecutor = std::function<Json::Value(const std::string& name, const Json::Value& args)>;
    // A channel's endpoint for a use: text, a text override (text_chronicle, text_assist, text_writing) or embedding.
    using ProfileResolver = std::function<std::optional<LlmProfile>(const std::string& channelId, const std::string& use)>;
    struct Outcome {
        bool ok = false;
        std::string error;
        long providerStatus = 0; // HTTP status, separate from transport/schema failures
        Json::Value data;          // validated structured output
        int llmCalls = 0;
        int toolCalls = 0;
        std::string rawContent;
        Json::Value providerContent;   // the final assistant turn as the provider returned it (replayable, see Replay.h)
        std::string provider, model;   // the protocol (anthropic | openai_compatible | chat_completions | mock) and model that produced it
    };

    explicit LlmGateway(const Config& cfg);
    // Tests: every channel uses this client.
    LlmGateway(const Config& cfg, std::unique_ptr<ILlmClient> client);

    void setProfileResolver(ProfileResolver r) { resolver_ = std::move(r); }
    void setMeter(AiMeter* meter) { meter_ = meter; }

    // Runs the request; when `exec` is provided tool calls are executed and fed back (max `maxRounds`).
    // The final content must be JSON matching req.responseSchema (if set).
    Outcome runStructured(LlmRequest req, ToolExecutor exec = nullptr, int maxRounds = 4);
    // The text use a task runs on decides these (a task's group may be overridden; see ai/ProviderCatalog.h): callers
    // pass the task they are about to run. Without one: the server's text use.
    std::string mode(const std::string& channelId, const std::string& task = "") const { return clientFor(channelId, task).client->mode(); }
    std::string modelName(const std::string& channelId, const std::string& task = "") const { return clientFor(channelId, task).client->modelName(); }
    bool isMock(const std::string& channelId, const std::string& task = "") const { return mode(channelId, task) == "mock"; }
    std::string embeddingModel(const std::string& channelId) const;
    // Embeddings through the server's embedding use (1536 dimensions); empty when it has none.
    std::vector<float> embed(const std::string& channelId, const std::string& text);
    bool embeddingsAvailable(const std::string& channelId) const;
    Json::Value status(const std::string& channelId, const std::string& task = "") const;
    static std::string languageName(const std::string& code);   // "zh-CN" -> "Simplified Chinese"; "" for English
    struct Limits { int maxTokens; int timeoutMs; };
    Limits limitsForTask(const std::string& task) const;
    bool retryFailedVnChunks() const { return cfg_.vnScriptRetryFailedChunks; }
private:
    // provider: the kind; protocol: how its turns are shaped for replay (anthropic | openai_compatible (Responses) | chat_completions | mock).
    struct Resolved { std::shared_ptr<ILlmClient> client; std::string language; std::string ruleSystem; std::string provider, protocol = "mock"; bool fixed = false; };
    Resolved clientFor(const std::string& channelId, const std::string& task = "") const;
    static Json::Value extractJson(const std::string& content);
    std::optional<LlmEndpoint> embeddingEndpoint(const std::string& channelId) const;
    const Config& cfg_;
    std::shared_ptr<ILlmClient> fixed_;   // tests only
    std::shared_ptr<ILlmClient> mock_;
    ProfileResolver resolver_;
    AiMeter* meter_ = nullptr;
    mutable std::mutex mu_;
    mutable std::map<std::string, std::shared_ptr<ILlmClient>> clients_;   // per distinct endpoint (bounded)
};

} // namespace acerciae
