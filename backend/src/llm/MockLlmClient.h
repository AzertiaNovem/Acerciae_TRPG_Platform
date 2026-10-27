#pragma once
#include "Llm.h"

namespace acerciae {
// Deterministic, rule-based stand-in for the model. It understands the same task contexts and
// produces the same JSON shapes as the live prompts, so every pipeline (observer, consolidator,
// consistency, inspiration, module structuring) runs end to end without an API key.
// Everything it emits cites the event ids it was given — it never invents sources.
class MockLlmClient : public ILlmClient {
public:
    LlmResponse complete(const LlmRequest& req) override;
    std::string mode() const override { return "mock"; }
    std::string modelName() const override { return "mock-rule-based-v1"; }

    // Exposed for unit tests.
    static Json::Value observerExtract(const Json::Value& ctx);
    static Json::Value consolidate(const Json::Value& ctx);
    static Json::Value consistency(const Json::Value& ctx);
    static Json::Value inspiration(const Json::Value& ctx);
    static Json::Value moduleStructure(const Json::Value& ctx);
private:
    static Json::Value lastUserJson(const LlmRequest& req);
};
}
