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
    using ProfileResolver = std::function<std::optional<LlmProfile>(const std::string& channelId)>;
    struct Outcome {
        bool ok = false;
        std::string error;
        long providerStatus = 0; // HTTP status, separate from transport/schema failures
        Json::Value data;          // validated structured output
        int llmCalls = 0;
        int toolCalls = 0;
        std::string rawContent;
    };

    explicit LlmGateway(const Config& cfg);
    // Tests: every channel uses this client.
    LlmGateway(const Config& cfg, std::unique_ptr<ILlmClient> client);

    void setProfileResolver(ProfileResolver r) { resolver_ = std::move(r); }
    void setMeter(AiMeter* meter) { meter_ = meter; }

    // Runs the request; when `exec` is provided tool calls are executed and fed back (max `maxRounds`).
    // The final content must be JSON matching req.responseSchema (if set).
    Outcome runStructured(LlmRequest req, ToolExecutor exec = nullptr, int maxRounds = 4);
    std::string mode(const std::string& channelId) const { return clientFor(channelId).client->mode(); }
    std::string modelName(const std::string& channelId) const { return clientFor(channelId).client->modelName(); }
    bool isMock(const std::string& channelId) const { return mode(channelId) == "mock"; }
    // Embeddings through the channel's server provider; empty when it has none (mock, Anthropic, no embedding model).
    std::vector<float> embed(const std::string& channelId, const std::string& text);
    bool embeddingsAvailable(const std::string& channelId) const;
    Json::Value status(const std::string& channelId) const;
    static std::string languageName(const std::string& code);   // "zh-CN" -> "Simplified Chinese"; "" for English
private:
    struct Resolved { std::shared_ptr<ILlmClient> client; std::string language; std::string provider; std::string embeddingModel; bool fixed = false; };
    Resolved clientFor(const std::string& channelId, bool moduleTask = false) const;
    static Json::Value extractJson(const std::string& content);
    const Config& cfg_;
    std::shared_ptr<ILlmClient> fixed_;   // tests only
    std::shared_ptr<ILlmClient> mock_;
    ProfileResolver resolver_;
    AiMeter* meter_ = nullptr;
    mutable std::mutex mu_;
    mutable std::map<std::string, std::shared_ptr<ILlmClient>> clients_;   // per distinct endpoint (bounded)
};

} // namespace acerciae
