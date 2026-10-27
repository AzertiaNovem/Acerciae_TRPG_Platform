#include "ServerSettingsService.h"
#include "../dice/Dice.h"
#include "../ws/Notifier.h"
#include "../knowledge/Visibility.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include <algorithm>
#include <curl/curl.h>

namespace acerciae {

const std::vector<std::string>& ServerSettingsService::languages() {
    static const std::vector<std::string> l = {"en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt", "it"};
    return l;
}

static const char* FEATURES[] = {"consistency", "dice", "inspiration", "log_studio", "coc7_points"};

static std::string keyHint(const std::string& key) {
    return key.size() > 8 ? "…" + key.substr(key.size() - 4) : "set";
}
static void checkUrl(const std::string& u) {
    if (u.empty()) return;
    if (u.size() > 300 || u.find_first_of("\r\n\t ") != std::string::npos || (u.rfind("https://", 0) != 0 && u.rfind("http://", 0) != 0)) throw badRequest("API base must be an http(s) URL");
    auto* parsed = curl_url();
    if (!parsed) throw badRequest("invalid API base URL");
    bool valid = curl_url_set(parsed, CURLUPART_URL, u.c_str(), 0) == CURLUE_OK;
    for (auto part : {CURLUPART_USER, CURLUPART_PASSWORD, CURLUPART_QUERY, CURLUPART_FRAGMENT}) {
        char* value = nullptr;
        if (curl_url_get(parsed, part, &value, 0) == CURLUE_OK) valid = false;
        curl_free(value);
    }
    curl_url_cleanup(parsed);
    if (!valid) throw badRequest("API base must not contain credentials, query parameters or fragments");
}
static void checkLen(const std::string& v, std::size_t n, const char* what) {
    if (v.size() > n) throw badRequest(std::string(what) + " is too long");
}

bool ServerSettingsService::isMaintainer(const std::string& userId, const std::string& serverId) {
    auto r = db_.queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    return !r.isNull() && (r["role"].asString() == "owner" || r["role"].asString() == "admin");
}

Json::Value ServerSettingsService::row(const std::string& serverId) {
    db_.exec("INSERT INTO server_settings(server_id) VALUES($1) ON CONFLICT DO NOTHING", {serverId});
    return db_.queryOne("SELECT ss.*, s.name AS server_name FROM server_settings ss JOIN servers s ON s.id=ss.server_id WHERE ss.server_id=$1", {serverId});
}

Json::Value ServerSettingsService::publicView(const Json::Value& r, const std::string& serverId) {
    Json::Value v;
    v["server_id"] = serverId; v["name"] = r["server_name"]; v["language"] = r["language"];
    for (auto* f : FEATURES) v["features"][f] = r[std::string("feature_") + f].asBool();
    bool live = !r["llm_api_key_sealed"].asString().empty() || !cfg_.llmApiKey.empty();
    v["llm_mode"] = live ? "live" : "mock";
    return v;
}

Json::Value ServerSettingsService::get(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    auto r = row(serverId);
    if (r.isNull()) throw notFound("server not found");
    auto v = publicView(r, serverId);
    bool maint = isMaintainer(p.userId, serverId);
    v["is_maintainer"] = maint;
    if (!maint) return v;
    Json::Value llm;
    llm["provider"] = r["llm_provider"]; llm["default_provider"] = cfg_.llmProvider;
    llm["api_base"] = r["llm_api_base"]; llm["model"] = r["llm_model"]; llm["reasoning_effort"] = r["llm_reasoning_effort"];
    llm["api_key_set"] = !r["llm_api_key_sealed"].asString().empty(); llm["api_key_hint"] = r["llm_api_key_hint"];
    llm["default_api_base"] = cfg_.llmApiBase; llm["default_model"] = cfg_.llmModel; llm["default_key_configured"] = !cfg_.llmApiKey.empty();
    v["llm"] = llm;
    Json::Value tts;
    tts["api_base"] = r["tts_api_base"]; tts["model"] = r["tts_model"]; tts["voice"] = r["tts_voice"];
    tts["api_key_set"] = !r["tts_api_key_sealed"].asString().empty(); tts["api_key_hint"] = r["tts_api_key_hint"];
    v["tts"] = tts;
    Json::Value image;
    image["provider"] = r["image_provider"]; image["api_base"] = r["image_api_base"]; image["model"] = r["image_model"];
    image["size"] = r["image_size"]; image["quality"] = r["image_quality"];
    image["api_key_set"] = !r["image_api_key_sealed"].asString().empty(); image["api_key_hint"] = r["image_api_key_hint"];
    image["default_provider"] = logstudio::imageConfigFromEnv().provider;
    v["image"] = image;
    v["updated_at"] = r["updated_at"];
    Json::Value langs(Json::arrayValue); for (auto& l : languages()) langs.append(l);
    v["languages"] = langs;
    return v;
}

Json::Value ServerSettingsService::update(const Principal& p, const std::string& serverId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    auto cur = row(serverId);
    auto str = [&](const Json::Value& obj, const char* k, const std::string& def) { return obj.isObject() && obj[k].isString() ? text::trim(obj[k].asString()) : def; };
    const Json::Value& llm = b["llm"]; const Json::Value& tts = b["tts"]; const Json::Value& image = b["image"];

    auto name = str(b, "name", cur["server_name"].asString());
    if (name.empty() || name.size() > 80) throw badRequest("server name must be 1-80 chars");
    auto language = str(b, "language", cur["language"].asString());
    if (std::find(languages().begin(), languages().end(), language) == languages().end()) throw badRequest("unsupported language");

    auto llmProvider = str(llm, "provider", cur["llm_provider"].asString());
    if (llmProvider != "" && llmProvider != "openai_compatible" && llmProvider != "anthropic") throw badRequest("unsupported LLM provider");
    auto imageProvider = str(image, "provider", cur["image_provider"].asString());
    if (imageProvider != "inherit" && imageProvider != "disabled" && imageProvider != "mock" && imageProvider != "gpt_image") throw badRequest("unsupported image provider");
    auto imageBase = str(image, "api_base", cur["image_api_base"].asString()); checkUrl(imageBase);
    auto imageModel = str(image, "model", cur["image_model"].asString()); checkLen(imageModel, 120, "image model");
    auto imageSize = str(image, "size", cur["image_size"].asString());
    if (imageSize != "auto" && imageSize != "1024x1024" && imageSize != "1536x1024" && imageSize != "1024x1536") throw badRequest("unsupported image size");
    auto imageQuality = str(image, "quality", cur["image_quality"].asString());
    if (imageQuality != "auto" && imageQuality != "low" && imageQuality != "medium" && imageQuality != "high") throw badRequest("unsupported image quality");
    auto llmBase = str(llm, "api_base", cur["llm_api_base"].asString()); checkUrl(llmBase);
    auto llmModel = str(llm, "model", cur["llm_model"].asString()); checkLen(llmModel, 120, "model name");
    auto effort = str(llm, "reasoning_effort", cur["llm_reasoning_effort"].asString());
    if (effort != "" && effort != "minimal" && effort != "low" && effort != "medium" && effort != "high") throw badRequest("reasoning_effort must be minimal, low, medium, high or empty");
    auto ttsBase = str(tts, "api_base", cur["tts_api_base"].asString()); checkUrl(ttsBase);
    auto ttsModel = str(tts, "model", cur["tts_model"].asString()); checkLen(ttsModel, 120, "TTS model");
    auto ttsVoice = str(tts, "voice", cur["tts_voice"].asString()); checkLen(ttsVoice, 120, "TTS voice");

    // Keys: a non-empty api_key replaces the stored one; clear_api_key removes it; otherwise it is left alone.
    auto sealed = [&](const Json::Value& obj, const char* col, const char* hintCol) -> std::pair<std::string, std::string> {
        std::pair<std::string, std::string> out{cur[col].asString(), cur[hintCol].asString()};
        if (json::toBool(obj, "clear_api_key")) out = {"", ""};
        auto k = str(obj, "api_key", "");
        if (k.find_first_of("\r\n") != std::string::npos) throw badRequest("invalid API key");
        if (!k.empty()) { checkLen(k, 500, "API key"); out = {crypto::sealSecret(cfg_.authSecret, k), keyHint(k)}; }
        return out;
    };
    auto [llmKey, llmHint] = sealed(llm, "llm_api_key_sealed", "llm_api_key_hint");
    auto [ttsKey, ttsHint] = sealed(tts, "tts_api_key_sealed", "tts_api_key_hint");
    auto [imageKey, imageHint] = sealed(image, "image_api_key_sealed", "image_api_key_hint");
    if (llmProvider == "anthropic" && !llmKey.empty() && llmModel.empty() && cfg_.llmProvider != "anthropic") throw badRequest("model is required for Anthropic");
    if (imageProvider == "gpt_image" && imageModel.empty()) throw badRequest("image model is required for GPT Image");

    bool feat[5];
    for (int i = 0; i < 5; ++i) feat[i] = json::toBool(b["features"], FEATURES[i], cur[std::string("feature_") + FEATURES[i]].asBool());

    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE servers SET name=$2 WHERE id=$1", {serverId, name});
        Db::exec(w, "UPDATE server_settings SET language=$2, llm_api_base=$3, llm_api_key_sealed=$4, llm_api_key_hint=$5, llm_model=$6, llm_reasoning_effort=$7, "
                    "tts_api_base=$8, tts_api_key_sealed=$9, tts_api_key_hint=$10, tts_model=$11, tts_voice=$12, "
                    "feature_consistency=$13, feature_dice=$14, feature_inspiration=$15, feature_log_studio=$17, feature_coc7_points=$18, updated_by=$16, updated_at=now() WHERE server_id=$1",
            {serverId, language, llmBase, llmKey, llmHint, llmModel, effort, ttsBase, ttsKey, ttsHint, ttsModel, ttsVoice, feat[0], feat[1], feat[2], p.userId, feat[3], feat[4]});
        Db::exec(w, "UPDATE server_settings SET llm_provider=$2, image_provider=$3, image_api_base=$4, image_api_key_sealed=$5, image_api_key_hint=$6, image_model=$7, image_size=$8, image_quality=$9 WHERE server_id=$1",
                 {serverId, llmProvider, imageProvider, imageBase, imageKey, imageHint, imageModel, imageSize, imageQuality});
    });
    auto fresh = row(serverId);
    notifier_.serverSettingsChanged(serverId, publicView(fresh, serverId));
    return get(p, serverId);
}

bool ServerSettingsService::featureEnabled(const std::string& serverId, const std::string& feature) {
    if (std::find(std::begin(FEATURES), std::end(FEATURES), feature) == std::end(FEATURES)) return false;
    auto r = db_.queryOne("SELECT feature_" + feature + " AS enabled FROM server_settings WHERE server_id=$1", {serverId});
    return r.isNull() || r["enabled"].asBool();   // no row yet = defaults (everything on)
}
void ServerSettingsService::requireFeature(const std::string& serverId, const std::string& feature) {
    if (!featureEnabled(serverId, feature)) throw ApiError(403, "feature_disabled", "This feature is turned off by the server maintainer");
}

std::optional<LlmProfile> ServerSettingsService::profileForChannel(const std::string& channelId) {
    auto r = db_.queryOne("SELECT ss.* FROM channels c JOIN server_settings ss ON ss.server_id=c.server_id WHERE c.id=$1", {channelId});
    if (r.isNull()) return std::nullopt;
    LlmProfile p;
    p.language = r["language"].asString();
    auto& e = p.endpoint;
    // The server's API base is only honoured together with the server's own key: otherwise a maintainer could point
    // the process-wide key at a URL of their choosing and capture it.
    e.provider = cfg_.llmProvider;
    e.apiBase = cfg_.llmApiBase; e.apiKey = cfg_.llmApiKey;
    e.model = r["llm_model"].asString().empty() ? cfg_.llmModel : r["llm_model"].asString();
    e.reasoningEffort = r["llm_reasoning_effort"].asString();
    e.embeddingModel = cfg_.llmEmbeddingModel; e.timeoutMs = cfg_.llmTimeoutMs; e.maxTokens = cfg_.llmMaxTokens;
    auto sealed = r["llm_api_key_sealed"].asString();
    if (!sealed.empty()) {
        // Do not fall back to a different credential on decryption failure.
        e.apiKey = crypto::openSecret(cfg_.authSecret, sealed);
        e.provider = r["llm_provider"].asString().empty() ? cfg_.llmProvider : r["llm_provider"].asString();
        e.apiBase = r["llm_api_base"].asString();
        if (e.apiBase.empty()) e.apiBase = e.provider == cfg_.llmProvider ? cfg_.llmApiBase :
            (e.provider == "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
    }
    if (e.provider == "anthropic") { e.reasoningEffort.clear(); e.embeddingModel.clear(); }
    return p;
}

ServerSettingsService::TtsConfig ServerSettingsService::ttsConfig(const std::string& serverId) {
    auto r = row(serverId);
    TtsConfig t;
    if (r.isNull()) return t;
    t.apiBase = r["tts_api_base"].asString(); t.model = r["tts_model"].asString(); t.voice = r["tts_voice"].asString(); t.language = r["language"].asString();
    auto sealed = r["tts_api_key_sealed"].asString();
    if (!sealed.empty()) { try { t.apiKey = crypto::openSecret(cfg_.authSecret, sealed); } catch (const std::exception& e) { ALOG_WARN << "cannot unseal TTS key: " << e.what(); } }
    return t;
}

logstudio::ImageConfig ServerSettingsService::imageConfigForChannel(const std::string& channelId) {
    auto r = db_.queryOne("SELECT ss.* FROM channels c JOIN server_settings ss ON ss.server_id=c.server_id WHERE c.id=$1", {channelId});
    if (r.isNull() || r["image_provider"] == "inherit") return logstudio::imageConfigFromEnv();
    logstudio::ImageConfig c;
    c.provider = r["image_provider"].asString();
    if (c.provider == "disabled" || c.provider == "mock") return c;
    c.apiBase = r["image_api_base"].asString().empty() ? "https://api.openai.com/v1" : r["image_api_base"].asString();
    c.model = r["image_model"].asString(); c.size = r["image_size"].asString(); c.quality = r["image_quality"].asString();
    if (!r["image_api_key_sealed"].asString().empty()) c.apiKey = crypto::openSecret(cfg_.authSecret, r["image_api_key_sealed"].asString());
    // Custom image endpoints never borrow the platform, text LLM or TTS credential.
    return c;
}

// ---- dice text groups --------------------------------------------------------------------------------
Json::Value ServerSettingsService::builtinTexts() {
    Json::Value v; Json::Value keys(Json::arrayValue);
    for (auto& k : dice::textKeys()) keys.append(k);
    v["keys"] = keys; v["en"] = dice::builtinTexts("en"); v["zh"] = dice::builtinTexts("zh");
    return v;
}
void ServerSettingsService::validateTexts(const Json::Value& texts) {
    if (!texts.isObject()) throw badRequest("texts must be an object of key -> template");
    auto keys = dice::textKeys();
    for (auto& k : texts.getMemberNames()) {
        if (std::find(keys.begin(), keys.end(), k) == keys.end()) throw badRequest("unknown text key: " + k);
        if (!texts[k].isString()) throw badRequest("text for " + k + " must be a string");
        if (texts[k].asString().size() > 500) throw badRequest("text for " + k + " is too long (max 500)");
    }
}
static Json::Value cleanTexts(const Json::Value& texts) {
    Json::Value out(Json::objectValue);
    for (auto& k : texts.getMemberNames()) if (!texts[k].asString().empty()) out[k] = texts[k];
    return out;
}
Json::Value ServerSettingsService::listTextGroups(const Principal& p, const std::string& serverId) {
    auth_.requireServerMember(p.userId, serverId);
    return db_.queryJson("SELECT g.id, g.name, g.base, g.texts, g.updated_at, u.display_name AS created_by_name FROM dice_text_groups g LEFT JOIN users u ON u.id=g.created_by WHERE g.server_id=$1 ORDER BY g.created_at", {serverId});
}
Json::Value ServerSettingsService::createTextGroup(const Principal& p, const std::string& serverId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    auto name = text::trim(json::requireStr(b, "name"));
    if (name.empty() || name.size() > 60) throw badRequest("name must be 1-60 chars");
    auto base = json::str(b, "base", "en"); if (base != "en" && base != "zh") throw badRequest("base must be en or zh");
    Json::Value texts = b.isMember("texts") ? b["texts"] : Json::Value(Json::objectValue);
    validateTexts(texts);
    auto n = db_.queryOne("SELECT count(*) AS n FROM dice_text_groups WHERE server_id=$1", {serverId});
    if (n["n"].asInt() >= 50) throw badRequest("at most 50 text groups per server");
    try {
        return db_.queryOne("INSERT INTO dice_text_groups(server_id, name, base, texts, created_by) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id, name, base, texts, updated_at",
            {serverId, name, base, json::dump(cleanTexts(texts)), p.userId});
    } catch (const pqxx::unique_violation&) { throw conflict("a text group with that name already exists"); }
}
Json::Value ServerSettingsService::updateTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (!Visibility::isUuid(groupId)) throw notFound("text group not found");
    auto cur = db_.queryOne("SELECT * FROM dice_text_groups WHERE id=$1 AND server_id=$2", {groupId, serverId});
    if (cur.isNull()) throw notFound("text group not found");
    auto name = text::trim(json::str(b, "name", cur["name"].asString()));
    if (name.empty() || name.size() > 60) throw badRequest("name must be 1-60 chars");
    auto base = json::str(b, "base", cur["base"].asString()); if (base != "en" && base != "zh") throw badRequest("base must be en or zh");
    Json::Value texts = b.isMember("texts") ? b["texts"] : cur["texts"];
    validateTexts(texts);
    try {
        return db_.queryOne("UPDATE dice_text_groups SET name=$3, base=$4, texts=$5::jsonb, updated_at=now() WHERE id=$1 AND server_id=$2 RETURNING id, name, base, texts, updated_at",
            {groupId, serverId, name, base, json::dump(cleanTexts(texts))});
    } catch (const pqxx::unique_violation&) { throw conflict("a text group with that name already exists"); }
}
Json::Value ServerSettingsService::deleteTextGroup(const Principal& p, const std::string& serverId, const std::string& groupId) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (!Visibility::isUuid(groupId)) throw notFound("text group not found");
    db_.tx([&](pqxx::work& w) {
        Db::exec(w, "UPDATE channels SET dice_text_group='' WHERE server_id=$1 AND dice_text_group=$2", {serverId, groupId});
        Db::exec(w, "DELETE FROM dice_text_groups WHERE id=$1 AND server_id=$2", {groupId, serverId});
    });
    Json::Value v; v["ok"] = true; return v;
}

} // namespace acerciae
