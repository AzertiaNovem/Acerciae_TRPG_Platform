#pragma once
#include "Llm.h"

namespace acerciae {
// Non-streaming Messages API. Tool results stay in the existing permission-checked gateway loop.
class AnthropicClient final : public ILlmClient {
public:
    explicit AnthropicClient(LlmEndpoint endpoint) : ep_(std::move(endpoint)) {}
    LlmResponse complete(const LlmRequest& req) override;
    std::string mode() const override { return "live"; }
    std::string modelName() const override { return ep_.model; }
    static Json::Value requestBody(const LlmRequest& req, const LlmEndpoint& ep);
    static LlmResponse parseResponse(const Json::Value& body);
private:
    LlmEndpoint ep_;
};
}
