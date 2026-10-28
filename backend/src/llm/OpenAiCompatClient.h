#pragma once
#include "Llm.h"

namespace acerciae {
// Talks to any OpenAI-compatible /chat/completions endpoint (OpenAI, Azure-style proxies, vLLM, Ollama, ...).
class OpenAiCompatClient : public ILlmClient {
public:
    explicit OpenAiCompatClient(LlmEndpoint ep) : ep_(std::move(ep)) {}
    LlmResponse complete(const LlmRequest& req) override;
    std::string mode() const override { return "live"; }
    std::string modelName() const override { return ep_.model; }
    std::vector<float> embed(const std::string& text) override;
private:
    std::string post(const std::string& path, const std::string& body, long& status, std::string& err);
    LlmEndpoint ep_;
};
}
