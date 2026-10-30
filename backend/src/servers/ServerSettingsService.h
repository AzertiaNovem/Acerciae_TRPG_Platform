#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "../llm/Llm.h"
#include "../logstudio/ImageProvider.h"
#include <json/json.h>
#include <optional>

namespace acerciae {
class Notifier;
class AiPolicyService;

// Per-server settings owned by the server's maintainers (owner and admins): the AI providers (LLM, images, speech)
// with their keys, the AI policy (budgets, concurrency), output language, which user-facing features are available,
// and the dice reply text groups. There are no platform AI keys: a server without its own provider runs mock AI.
// API keys are sealed at rest and never leave the backend; clients only learn whether one is set.
class ServerSettingsService {
public:
    ServerSettingsService(const Config& cfg, Db& db, AuthService& auth, AiPolicyService& policy, Notifier& notifier) : cfg_(cfg), db_(db), auth_(auth), policy_(policy), notifier_(notifier) {}

    bool isMaintainer(const std::string& userId, const std::string& serverId);
    // Members get the public view (language, features, effective LLM mode); maintainers also get the configuration.
    Json::Value get(const Principal& p, const std::string& serverId);
    Json::Value update(const Principal& p, const std::string& serverId, const Json::Value& body);

    // Features: "consistency" | "dice" | "inspiration".
    bool featureEnabled(const std::string& serverId, const std::string& feature);
    void requireFeature(const std::string& serverId, const std::string& feature);   // 403 feature_disabled
    std::string language(const std::string& serverId);   // the server language ("en" before settings exist)

    // LLM profile for the gateway: the server's own provider, or mock when it has none.
    std::optional<LlmProfile> profileForChannel(const std::string& channelId);

    // For the TTS integration: the server's speech provider (disabled | mock | qwen | openai) with the key unsealed.
    struct TtsConfig { std::string provider = "mock", apiBase, apiKey, model, voice, language; };
    TtsConfig ttsConfig(const std::string& serverId);

    logstudio::ImageConfig imageConfigForChannel(const std::string& channelId);

    // Dice reply text groups
    Json::Value listTextGroups(const Principal& p, const std::string& serverId);
    Json::Value createTextGroup(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value updateTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId, const Json::Value& body);
    Json::Value deleteTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId);
    static Json::Value builtinTexts();   // {keys:[...], en:{...}, zh:{...}}

    static const std::vector<std::string>& languages();
private:
    Json::Value row(const std::string& serverId);
    Json::Value publicView(const Json::Value& r, const std::string& serverId);
    void validateTexts(const Json::Value& texts);
    const Config& cfg_; Db& db_; AuthService& auth_; AiPolicyService& policy_; Notifier& notifier_;
};

} // namespace acerciae
