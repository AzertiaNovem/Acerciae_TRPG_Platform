#pragma once
#include "Llm.h"

namespace acerciae {
// Talks to any endpoint implementing OpenAI Chat Completions (POST {base}/chat/completions), streamed: OpenAI-compatible
// gateways, Alibaba's compatible mode, OpenRouter and Volcano Engine Ark. Tool calls go back to the gateway loop.
class ChatCompletionsClient : public ILlmClient {
public:
    explicit ChatCompletionsClient(LlmEndpoint ep) : ep_(std::move(ep)) {}
    LlmResponse complete(const LlmRequest& req) override;
    std::string mode() const override { return "live"; }
    std::string modelName() const override { return ep_.model; }
    static Json::Value requestBody(const LlmRequest& req, const LlmEndpoint& ep);
    static LlmResponse parseResponse(const Json::Value& body);
    // The Chat Completions base of an endpoint (Alibaba: {host}/compatible-mode/v1).
    static std::string baseUrl(const LlmEndpoint& ep);
private:
    LlmEndpoint ep_;
};
}
