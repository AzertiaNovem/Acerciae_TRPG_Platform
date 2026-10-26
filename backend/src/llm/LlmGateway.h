#pragma once
#include "Llm.h"
#include "../core/Config.h"
#include <memory>
#include <functional>

namespace acerciae {

// The only module that talks to a model. Owns the client, enforces timeouts/limits from config,
// runs the tool-call loop and validates structured output against a schema before returning it.
class LlmGateway {
public:
    using ToolExecutor = std::function<Json::Value(const std::string& name, const Json::Value& args)>;
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

    // Runs the request; when `exec` is provided tool calls are executed and fed back (max `maxRounds`).
    // The final content must be JSON matching req.responseSchema (if set).
    Outcome runStructured(LlmRequest req, ToolExecutor exec = nullptr, int maxRounds = 4);
    std::string mode() const { return client_->mode(); }
    std::string modelName() const { return client_->modelName(); }
    bool isMock() const { return client_->mode() == "mock"; }
    std::vector<float> embed(const std::string& text) { return client_->embed(text); }
    Json::Value status() const;
private:
    static Json::Value extractJson(const std::string& content);
    const Config& cfg_;
    std::unique_ptr<ILlmClient> client_;
};

} // namespace acerciae
