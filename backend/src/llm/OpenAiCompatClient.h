#pragma once
#include "Llm.h"

namespace acerciae {
// Talks to any endpoint implementing the OpenAI Responses API (POST {api_base}/responses), streamed. Embeddings use
// {api_base}/embeddings. Tool results stay in the permission-checked gateway loop.
class OpenAiCompatClient : public ILlmClient {
public:
    explicit OpenAiCompatClient(LlmEndpoint ep) : ep_(std::move(ep)) {}
    LlmResponse complete(const LlmRequest& req) override;
    std::string mode() const override { return "live"; }
    std::string modelName() const override { return ep_.model; }
    std::vector<float> embed(const std::string& text) override;
    static Json::Value requestBody(const LlmRequest& req, const LlmEndpoint& ep);
    static LlmResponse parseResponse(const Json::Value& body);
private:
    std::string post(const std::string& path, const std::string& body, long& status, std::string& err);
    LlmEndpoint ep_;
};
}
