#pragma once
#include "../core/Config.h"
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include "../llm/Llm.h"
#include "../logstudio/ImageProvider.h"
#include "../ai/AiConfig.h"
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

    // Features: "consistency" | "dice" | "inspiration" | "log_studio" | "atmosphere" | "illustrations".
    bool featureEnabled(const std::string& serverId, const std::string& feature);
    void requireFeature(const std::string& serverId, const std::string& feature);   // 403 feature_disabled
    std::string language(const std::string& serverId);   // the server language ("en" before settings exist)

    // ---- AI providers and model uses (AiProviderSettings.cpp) ----
    // Maintainers add providers (an endpoint of a known kind with its keys) and assign a provider and a model to each
    // use; a use only takes a provider whose kind can do it (see ai/ProviderCatalog.h).
    Json::Value aiView(const std::string& serverId);   // {providers:[…], uses:{use: {provider, model, options}}}
    Json::Value createProvider(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value updateProvider(const Principal& p, const std::string& serverId, const std::string& providerId, const Json::Value& body);
    // Uses that named the provider go back to their default (text: mock, others: off or inherited).
    Json::Value deleteProvider(const Principal& p, const std::string& serverId, const std::string& providerId);
    Json::Value updateUses(const Principal& p, const std::string& serverId, const Json::Value& body);
    // A use resolved for a call: inherited uses followed, the provider's secrets unsealed (throws rather than falling back).
    ai::UseConfig useConfig(const std::string& serverId, const std::string& use);
    std::string serverOfChannel(const std::string& channelId);

    // LLM profile for the gateway: the endpoint of a use (text, a text override, or embedding) for a channel's server.
    std::optional<LlmProfile> profileForChannel(const std::string& channelId, const std::string& use = "text");

    // For the TTS integration: the server's speech use with the provider's secrets unsealed.
    struct TtsConfig { std::string provider = "mock", apiBase, apiKey, model, voice, language; ai::ProviderAccess access; };
    TtsConfig ttsConfig(const std::string& serverId);

    logstudio::ImageConfig imageConfigForChannel(const std::string& channelId);

    // Dice reply text groups
    Json::Value listTextGroups(const Principal& p, const std::string& serverId);
    Json::Value createTextGroup(const Principal& p, const std::string& serverId, const Json::Value& body);
    Json::Value updateTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId, const Json::Value& body);
    Json::Value deleteTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId);
    // A text group's dice avatar for a member of its server; throws 404 when there is none.
    struct DiceAvatar { std::string mime, bytes; int version = 0; };
    DiceAvatar diceAvatar(const Principal& p, const std::string& groupId);
    static Json::Value builtinTexts();   // {keys:[...], en:{...}, zh:{...}}

    static const std::vector<std::string>& languages();
private:
    Json::Value row(const std::string& serverId);
    Json::Value publicView(const Json::Value& r, const std::string& serverId);
    // The old single-provider settings ({llm, image, tts}): still read and written by older clients, translated to and
    // from providers and uses.
    Json::Value legacyAiView(const std::string& serverId);
    void applyLegacyAi(const Principal& p, const std::string& serverId, const Json::Value& body);
    struct UseRow { std::string mode, providerId, model; Json::Value options; };
    UseRow useRow(const std::string& serverId, const std::string& use);
    Json::Value providerRow(const std::string& serverId, const std::string& providerId);
    ai::ProviderAccess unseal(const Json::Value& providerRow);
    void writeUse(const std::string& serverId, const std::string& use, const UseRow& row);
    void validateTexts(const Json::Value& texts);
    const Config& cfg_; Db& db_; AuthService& auth_; AiPolicyService& policy_; Notifier& notifier_;
};

} // namespace acerciae
