#pragma once
#include "Llm.h"
#include "../core/Config.h"
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <functional>

namespace acerciae {

// The only module that talks to a model. Owns the clients, enforces timeouts/limits from config,
// runs the tool-call loop and validates structured output against a schema before returning it.
// Each server may bring its own endpoint/model/reasoning effort/language; requests carry a channel id and the
// profile resolver maps it to that server's settings (no resolver or no profile = the process default).
class LlmGateway {
public:
    using ToolExecutor = std::function<Json::Value(const std::string& name, const Json::Value& args)>;
    using ProfileResolver = std::function<std::optional<LlmProfile>(const std::string& channelId)>;
    struct Outcome {
        bool ok = false;
        std::string error;
        Json::Value data;          // validated structured output
        int llmCalls = 0;
        int toolCalls = 0;
        std::string rawContent;
    };

    explicit LlmGateway(const Config& cfg);
    LlmGateway(const Config& cfg, std::unique_ptr<ILlmClient> client);

    void setProfileResolver(ProfileResolver r) { resolver_ = std::move(r); }

    // Runs the request; when `exec` is provided tool calls are executed and fed back (max `maxRounds`).
    // The final content must be JSON matching req.responseSchema (if set).
    Outcome runStructured(LlmRequest req, ToolExecutor exec = nullptr, int maxRounds = 4);
    std::string mode(const std::string& channelId = "") const { return clientFor(channelId).client->mode(); }
    std::string modelName(const std::string& channelId = "") const { return clientFor(channelId).client->modelName(); }
    bool isMock(const std::string& channelId = "") const { return mode(channelId) == "mock"; }
    std::vector<float> embed(const std::string& text) { return client_->embed(text); }
    Json::Value status(const std::string& channelId = "") const;
    static std::string languageName(const std::string& code);   // "zh-CN" -> "Simplified Chinese"; "" for English
private:
    struct Resolved { std::shared_ptr<ILlmClient> client; std::string language; bool custom = false; };
    Resolved clientFor(const std::string& channelId) const;
    static Json::Value extractJson(const std::string& content);
    const Config& cfg_;
    std::shared_ptr<ILlmClient> client_;
    std::shared_ptr<ILlmClient> mock_;
    ProfileResolver resolver_;
    mutable std::mutex mu_;
    mutable std::map<std::string, std::shared_ptr<ILlmClient>> clients_;   // per distinct endpoint
};

} // namespace acerciae
