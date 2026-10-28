#pragma once
#include <json/json.h>
#include <string>
#include <vector>
#include <functional>
#include <memory>

namespace acerciae {

struct LlmMessage {
    std::string role;           // system | user | assistant | tool
    std::string content;
    Json::Value toolCalls;      // assistant: [{id, name, arguments(json string)}]
    std::string toolCallId;     // tool: id of the call this answers
    std::string name;           // tool: tool name
    Json::Value providerContent; // Anthropic blocks preserved when returning tool results
    bool isError = false;        // tool: the call failed (sent as is_error where the provider supports it)
};

struct LlmToolSpec {
    std::string name;
    std::string description;
    Json::Value parameters;     // JSON schema
};

// Where and how to reach a model: a server's own provider settings (there is no platform-wide default).
struct LlmEndpoint {
    std::string provider = "mock";  // mock | openai_compatible | anthropic
    std::string apiBase;
    std::string apiKey;            // empty => mock mode
    std::string model;
    std::string reasoningEffort;   // '' | minimal | low | medium | high (sent as reasoning_effort)
    std::string embeddingModel;
    int timeoutMs = 60000;
    int maxTokens = 2048;
};
// What a channel's server asks for: its endpoint and the language human-readable output should be written in.
struct LlmProfile {
    LlmEndpoint endpoint;
    std::string language;          // BCP-47-ish code, '' or 'en' = English
};

struct LlmRequest {
    std::string channelId;      // selects the server's LLM profile; empty = mock
    std::string task;           // observer_extract | consolidate | consistency | inspiration | module_structure
    std::string system;
    std::vector<LlmMessage> messages;
    std::vector<LlmToolSpec> tools;
    Json::Value responseSchema; // when set, the final answer must validate against it
    double temperature = 0.2;
    int maxTokens = 2048;
};

struct LlmResponse {
    Json::Value providerContent;
    bool ok = false;
    std::string error;
    std::string content;
    Json::Value toolCalls = Json::Value(Json::arrayValue);   // [{id, name, arguments}]
    int promptTokens = 0, completionTokens = 0;
};

// A server's AI policy as seen by the gateway: the token budget and the number of AI calls it may run at once.
// Implemented by AiPolicyService; every live call checks the budget, holds a slot while it runs and records usage.
class AiMeter {
public:
    virtual ~AiMeter() = default;
    virtual void checkTokens(const std::string& channelId) = 0;                    // throws std::runtime_error when spent
    virtual std::shared_ptr<void> acquire(const std::string& channelId) = 0;       // throws when no slot frees up in time
    virtual void recordTokens(const std::string& channelId, const std::string& task, int promptTokens, int completionTokens) = 0;
};

// Pluggable backend. Implementations: OpenAiCompatClient, AnthropicClient, MockLlmClient.
class ILlmClient {
public:
    virtual ~ILlmClient() = default;
    virtual LlmResponse complete(const LlmRequest& req) = 0;
    virtual std::string mode() const = 0;      // "live" | "mock"
    virtual std::string modelName() const = 0;
    virtual std::vector<float> embed(const std::string& text) { (void)text; return {}; }
};

} // namespace acerciae
