// AI providers and model uses of a server (see ai/ProviderCatalog.h), and the translation of the old single-provider
// settings ({llm, image, tts}) that older clients still send and read.
#include "ServerSettingsService.h"
#include "../ai/ProviderCatalog.h"
#include "../ws/Notifier.h"
#include "../knowledge/Visibility.h"
#include "../core/Crypto.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/NetGuard.h"
#include "../core/Text.h"
#include <algorithm>

namespace acerciae {
namespace cat = ai::catalog;

namespace {
std::string keyHint(const std::string& key) { return key.size() > 8 ? "…" + key.substr(key.size() - 4) : "set"; }
void checkUrl(const std::string& u) {
    try { net::checkEndpointSyntax(u); } catch (const std::invalid_argument& e) { throw badRequest(e.what()); }
}
std::string str(const Json::Value& obj, const char* k, const std::string& def) {
    return obj.isObject() && obj[k].isString() ? text::trim(obj[k].asString()) : def;
}
void checkSecret(const std::string& v) {
    if (v.size() > 2000) throw badRequest("a secret is too long");
    if (v.find_first_of("\r\n") != std::string::npos) throw badRequest("invalid API key");
}
// The settings a use takes: text reasoning effort; image size and quality; the speech voice.
Json::Value cleanUseOptions(const std::string& capability, const Json::Value& in) {
    Json::Value out(Json::objectValue);
    if (in.isNull()) return out;
    if (!in.isObject()) throw badRequest("use options must be an object");
    for (const auto& key : in.getMemberNames()) {
        const auto& v = in[key];
        if (!v.isString()) throw badRequest(key + " must be a string");
        auto value = text::trim(v.asString());
        if (capability == "text" && key == "reasoning_effort") {
            if (value != "" && value != "minimal" && value != "low" && value != "medium" && value != "high") throw badRequest("reasoning_effort must be minimal, low, medium, high or empty");
        } else if ((capability == "image_generation" || capability == "image_edit") && key == "size") {
            if (value != "" && value != "auto" && value != "1024x1024" && value != "1536x1024" && value != "1024x1536") throw badRequest("unsupported image size");
        } else if ((capability == "image_generation" || capability == "image_edit") && key == "quality") {
            if (value != "" && value != "auto" && value != "low" && value != "medium" && value != "high") throw badRequest("unsupported image quality");
        } else if (capability == "tts" && key == "voice") {
            if (value.size() > 120) throw badRequest("TTS voice is too long");
        } else throw badRequest("unknown option " + key + " for this use");
        if (!value.empty()) out[key] = value;
    }
    return out;
}
// The default mode of a use with no row.
std::string defaultMode(const std::string& use) { auto* u = cat::use(use); return u ? (*u)["default"].asString() : "disabled"; }
bool allowsMode(const std::string& use, const std::string& mode) {
    auto* u = cat::use(use);
    if (!u) return false;
    for (const auto& m : (*u)["modes"]) if (m.asString() == mode) return true;
    return false;
}
} // namespace

std::string ServerSettingsService::serverOfChannel(const std::string& channelId) {
    auto r = db_.queryOne("SELECT server_id FROM channels WHERE id=$1", {channelId});
    return r.isNull() ? "" : r["server_id"].asString();
}

ServerSettingsService::UseRow ServerSettingsService::useRow(const std::string& serverId, const std::string& use) {
    auto r = db_.queryOne("SELECT mode, provider_id, model, options FROM server_ai_uses WHERE server_id=$1 AND use=$2", {serverId, use});
    UseRow row;
    if (r.isNull()) { row.mode = defaultMode(use); row.options = Json::Value(Json::objectValue); return row; }
    row.mode = r["mode"].asString(); row.providerId = r["provider_id"].isString() ? r["provider_id"].asString() : "";
    row.model = r["model"].asString(); row.options = r["options"].isObject() ? r["options"] : Json::Value(Json::objectValue);
    if (row.mode == "provider" && row.providerId.empty()) { row.mode = defaultMode(use); row.model.clear(); }   // its provider is gone
    return row;
}
void ServerSettingsService::writeUse(const std::string& serverId, const std::string& use, const UseRow& row) {
    db_.exec("INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model, options, updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,now()) "
             "ON CONFLICT (server_id, use) DO UPDATE SET mode=EXCLUDED.mode, provider_id=EXCLUDED.provider_id, model=EXCLUDED.model, options=EXCLUDED.options, updated_at=now()",
             // A mock or switched-off use may remember a provider (the old settings kept a key with the mock mode).
             {serverId, use, row.mode, row.providerId.empty() ? dbNull() : DbParam(row.providerId), row.model,
              json::dump(row.options.isObject() ? row.options : Json::Value(Json::objectValue))});
}
Json::Value ServerSettingsService::providerRow(const std::string& serverId, const std::string& providerId) {
    if (!Visibility::isUuid(providerId)) return Json::Value();
    return db_.queryOne("SELECT * FROM server_ai_providers WHERE id=$1 AND server_id=$2", {providerId, serverId});
}
ai::ProviderAccess ServerSettingsService::unseal(const Json::Value& r) {
    ai::ProviderAccess a;
    a.id = r["id"].asString(); a.name = r["name"].asString(); a.kind = r["kind"].asString();
    a.options = r["options"].isObject() ? r["options"] : Json::Value(Json::objectValue);
    a.apiBase = r["api_base"].asString();
    if (a.apiBase.empty()) a.apiBase = cat::defaultApiBase(a.kind);
    auto region = a.option("region", "us-east-1");
    for (std::string::size_type at; (at = a.apiBase.find("{region}")) != std::string::npos;) a.apiBase.replace(at, 8, region);
    // Throws when a key cannot be unsealed (AUTH_SECRET changed): never fall back to another credential.
    if (!r["api_key_sealed"].asString().empty()) a.apiKey = crypto::openSecret(cfg_.authSecret, r["api_key_sealed"].asString());
    if (r["secrets"].isObject())
        for (const auto& k : r["secrets"].getMemberNames()) {
            auto sealed = r["secrets"][k]["sealed"].asString();
            if (!sealed.empty()) a.secrets[k] = crypto::openSecret(cfg_.authSecret, sealed);
        }
    return a;
}

ai::UseConfig ServerSettingsService::useConfig(const std::string& serverId, const std::string& use) {
    ai::UseConfig c; c.use = use;
    auto row = useRow(serverId, use);
    if (row.mode == "inherit") {
        // Text overrides follow text; image editing follows image generation.
        auto parent = use == "image_edit" ? "image_generation" : "text";
        auto inherited = useConfig(serverId, parent);
        inherited.use = use;
        return inherited;
    }
    c.mode = row.mode; c.model = row.model; c.options = row.options;
    if (row.mode != "provider") return c;
    auto p = providerRow(serverId, row.providerId);
    if (p.isNull()) { c.mode = defaultMode(use) == "inherit" ? "disabled" : defaultMode(use); return c; }
    c.provider = unseal(p);
    return c;
}

// ---- views ------------------------------------------------------------------------------------------------------
Json::Value ServerSettingsService::aiView(const std::string& serverId) {
    Json::Value v;
    Json::Value providers(Json::arrayValue);
    auto uses = db_.queryJson("SELECT use, mode, provider_id, model, options FROM server_ai_uses WHERE server_id=$1", {serverId});
    for (const auto& r : db_.queryJson("SELECT * FROM server_ai_providers WHERE server_id=$1 ORDER BY created_at, name", {serverId})) {
        Json::Value p;
        p["id"] = r["id"]; p["name"] = r["name"]; p["kind"] = r["kind"]; p["api_base"] = r["api_base"];
        p["api_key_set"] = !r["api_key_sealed"].asString().empty(); p["api_key_hint"] = r["api_key_hint"];
        p["options"] = r["options"].isObject() ? r["options"] : Json::Value(Json::objectValue);
        p["secrets"] = Json::Value(Json::objectValue);
        if (r["secrets"].isObject())
            for (const auto& k : r["secrets"].getMemberNames()) { p["secrets"][k]["set"] = true; p["secrets"][k]["hint"] = r["secrets"][k]["hint"]; }
        p["used_by"] = Json::Value(Json::arrayValue);
        for (const auto& u : uses) if (u["mode"] == "provider" && u["provider_id"] == r["id"]) p["used_by"].append(u["use"]);
        p["updated_at"] = r["updated_at"];
        providers.append(p);
    }
    v["providers"] = providers;
    Json::Value out(Json::objectValue);
    for (const auto& u : cat::uses()) {
        auto id = u["id"].asString();
        auto row = useRow(serverId, id);
        Json::Value j;
        j["provider"] = row.mode == "provider" ? row.providerId : row.mode;   // a provider id, mock, disabled or inherit
        j["model"] = row.model; j["options"] = row.options;
        out[id] = j;
    }
    v["uses"] = out;
    return v;
}

// ---- providers --------------------------------------------------------------------------------------------------
namespace {
struct ProviderWrite {
    std::string name, kind, apiBase, key, hint;
    Json::Value options = Json::Value(Json::objectValue), secrets = Json::Value(Json::objectValue);
};
}

static ProviderWrite validateProvider(const Config& cfg, const Json::Value& b, const Json::Value& cur) {
    ProviderWrite w;
    if (!b.isObject()) throw badRequest("provider must be an object");
    w.kind = cur.isNull() ? str(b, "kind", "") : cur["kind"].asString();
    if (!cur.isNull() && b.isMember("kind") && str(b, "kind", "") != w.kind) throw badRequest("a provider's kind cannot change; add a new provider instead");
    auto* kind = cat::kind(w.kind);
    if (!kind) throw badRequest("unsupported provider kind");
    w.name = str(b, "name", cur.isNull() ? (*kind)["label"].asString() : cur["name"].asString());
    if (w.name.empty() || w.name.size() > 60 || w.name.find_first_of("\r\n\t") != std::string::npos) throw badRequest("provider name must be 1-60 characters on one line");
    w.apiBase = str(b, "api_base", cur.isNull() ? "" : cur["api_base"].asString());
    if (!w.apiBase.empty()) { if (w.apiBase.size() > 500) throw badRequest("endpoint is too long"); checkUrl(w.apiBase); }
    w.key = cur.isNull() ? "" : cur["api_key_sealed"].asString();
    w.hint = cur.isNull() ? "" : cur["api_key_hint"].asString();
    if (json::toBool(b, "clear_api_key", false)) { w.key.clear(); w.hint.clear(); }
    auto key = str(b, "api_key", "");
    if (!key.empty()) { checkSecret(key); w.key = crypto::sealSecret(cfg.authSecret, key); w.hint = keyHint(key); }
    w.options = cur.isNull() || !cur["options"].isObject() ? Json::Value(Json::objectValue) : cur["options"];
    w.secrets = cur.isNull() || !cur["secrets"].isObject() ? Json::Value(Json::objectValue) : cur["secrets"];
    const auto& options = b["options"]; const auto& secrets = b["secrets"];
    if (!options.isNull() && !options.isObject()) throw badRequest("options must be an object");
    if (!secrets.isNull() && !secrets.isObject()) throw badRequest("secrets must be an object");
    auto field = [&](const std::string& k) -> const Json::Value* { for (const auto& f : (*kind)["fields"]) if (f["key"].asString() == k) return &f; return nullptr; };
    if (options.isObject())
        for (const auto& k : options.getMemberNames()) {
            auto* f = field(k);
            if (!f || (*f)["type"] == "secret") throw badRequest("unknown field " + k + " for this provider");
            if (!options[k].isString()) throw badRequest(k + " must be a string");
            auto value = text::trim(options[k].asString());
            if (value.size() > 300 || value.find_first_of("\r\n") != std::string::npos) throw badRequest(k + " is invalid");
            if ((*f)["type"] == "url" && !value.empty()) checkUrl(value);
            if (value.empty()) w.options.removeMember(k); else w.options[k] = value;
        }
    if (secrets.isObject())
        for (const auto& k : secrets.getMemberNames()) {
            auto* f = field(k);
            if (!f || (*f)["type"] != "secret" || k == "api_key") throw badRequest("unknown secret " + k + " for this provider");
            if (secrets[k].isNull() || (secrets[k].isString() && secrets[k].asString().empty())) { w.secrets.removeMember(k); continue; }
            if (!secrets[k].isString()) throw badRequest(k + " must be a string");
            auto value = text::trim(secrets[k].asString()); checkSecret(value);
            w.secrets[k]["sealed"] = crypto::sealSecret(cfg.authSecret, value); w.secrets[k]["hint"] = keyHint(value);
        }
    for (const auto& f : (*kind)["fields"]) {
        if (!f["required"].asBool()) continue;
        auto k = f["key"].asString();
        bool set = k == "api_key" ? !w.key.empty() : f["type"] == "secret" ? w.secrets.isMember(k) : w.options.isMember(k);
        if (!set) throw badRequest(f["label"].asString() + " is required for " + (*kind)["label"].asString());
    }
    return w;
}

Json::Value ServerSettingsService::createProvider(const Principal& p, const std::string& serverId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    auto w = validateProvider(cfg_, b, Json::Value());
    auto n = db_.queryOne("SELECT count(*) AS n FROM server_ai_providers WHERE server_id=$1", {serverId});
    if (n["n"].asInt() >= 30) throw badRequest("at most 30 AI providers per server");
    std::string id;
    try {
        id = db_.queryOne("INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint, options, secrets, created_by) "
                          "VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id",
                          {serverId, w.name, w.kind, w.apiBase, w.key, w.hint, json::dump(w.options), json::dump(w.secrets), p.userId})["id"].asString();
    } catch (const pqxx::unique_violation&) { throw conflict("a provider with that name already exists"); }
    auto view = aiView(serverId);
    for (const auto& pr : view["providers"]) if (pr["id"].asString() == id) return pr;
    return Json::Value();
}

Json::Value ServerSettingsService::updateProvider(const Principal& p, const std::string& serverId, const std::string& providerId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    auto cur = providerRow(serverId, providerId);
    if (cur.isNull()) throw notFound("provider not found");
    auto w = validateProvider(cfg_, b, cur);
    try {
        db_.exec("UPDATE server_ai_providers SET name=$3, api_base=$4, api_key_sealed=$5, api_key_hint=$6, options=$7::jsonb, secrets=$8::jsonb, updated_at=now() "
                 "WHERE id=$1 AND server_id=$2", {providerId, serverId, w.name, w.apiBase, w.key, w.hint, json::dump(w.options), json::dump(w.secrets)});
    } catch (const pqxx::unique_violation&) { throw conflict("a provider with that name already exists"); }
    for (const auto& pr : aiView(serverId)["providers"]) if (pr["id"].asString() == providerId) return pr;
    return Json::Value();
}

Json::Value ServerSettingsService::deleteProvider(const Principal& p, const std::string& serverId, const std::string& providerId) {
    auth_.requireServerAdmin(p.userId, serverId);
    if (providerRow(serverId, providerId).isNull()) throw notFound("provider not found");
    db_.tx([&](pqxx::work& w) {
        for (const auto& u : Db::queryJson(w, "SELECT use, mode FROM server_ai_uses WHERE server_id=$1 AND provider_id=$2", {serverId, providerId}))
            Db::exec(w, "UPDATE server_ai_uses SET mode=$3, provider_id=NULL, model=CASE WHEN mode='provider' THEN '' ELSE model END, updated_at=now() WHERE server_id=$1 AND use=$2",
                     {serverId, u["use"].asString(), u["mode"].asString() == "provider" ? defaultMode(u["use"].asString()) : u["mode"].asString()});
        Db::exec(w, "DELETE FROM server_ai_providers WHERE id=$1 AND server_id=$2", {providerId, serverId});
    });
    notifier_.serverSettingsChanged(serverId, publicView(row(serverId), serverId));
    return aiView(serverId);
}

// ---- uses -------------------------------------------------------------------------------------------------------
Json::Value ServerSettingsService::updateUses(const Principal& p, const std::string& serverId, const Json::Value& b) {
    auth_.requireServerAdmin(p.userId, serverId);
    const auto& uses = b.isMember("uses") ? b["uses"] : b;
    if (!uses.isObject()) throw badRequest("uses must be an object of use -> {provider, model, options}");
    std::vector<std::pair<std::string, UseRow>> writes;
    for (const auto& use : uses.getMemberNames()) {
        auto* entry = cat::use(use);
        if (!entry) throw badRequest("unknown use " + use);
        const auto& u = uses[use];
        if (!u.isObject()) throw badRequest("each use must be an object");
        auto current = useRow(serverId, use);
        UseRow row;
        auto provider = str(u, "provider", current.mode == "provider" ? current.providerId : current.mode);
        auto capability = (*entry)["capability"].asString();
        if (provider == "mock" || provider == "disabled" || provider == "inherit") {
            if (!allowsMode(use, provider)) throw badRequest(std::string("“") + provider + "” is not available for " + (*entry)["label"].asString());
            row.mode = provider;
        } else {
            auto pr = providerRow(serverId, provider);
            if (pr.isNull()) throw badRequest("unknown provider for " + (*entry)["label"].asString());
            if (!cat::supports(pr["kind"].asString(), capability))
                throw badRequest(pr["name"].asString() + " (" + (*cat::kind(pr["kind"].asString()))["label"].asString() + ") cannot be used for " + (*entry)["label"].asString());
            row.mode = "provider"; row.providerId = provider;
            row.model = str(u, "model", current.mode == "provider" && current.providerId == provider ? current.model : "");
            if (row.model.empty()) throw badRequest("a model is required for " + (*entry)["label"].asString());
            if (row.model.size() > 200 || row.model.find_first_of("\r\n\t") != std::string::npos) throw badRequest("model name is invalid");
        }
        row.options = u.isMember("options") ? cleanUseOptions(capability, u["options"]) : current.options;
        writes.emplace_back(use, row);
    }
    for (const auto& [use, row] : writes) writeUse(serverId, use, row);
    notifier_.serverSettingsChanged(serverId, publicView(row(serverId), serverId));
    return aiView(serverId);
}

// ---- resolution for calls ---------------------------------------------------------------------------------------
std::optional<LlmProfile> ServerSettingsService::profileForChannel(const std::string& channelId, const std::string& use) {
    auto r = db_.queryOne("SELECT c.server_id, c.rule_system, coalesce(ss.language, 'en') AS language FROM channels c "
                          "LEFT JOIN server_settings ss ON ss.server_id=c.server_id WHERE c.id=$1", {channelId});
    if (r.isNull()) return std::nullopt;
    LlmProfile p;
    p.language = r["language"].asString();
    p.ruleSystem = r["rule_system"].asString();
    auto& e = p.endpoint;
    e.timeoutMs = cfg_.llmTimeoutMs; e.maxTokens = cfg_.llmMaxTokens;
    auto c = useConfig(r["server_id"].asString(), use);
    if (!c.live()) { e.provider = c.mode == "mock" ? "mock" : "disabled"; return p; }
    e.provider = c.provider.kind;
    e.apiBase = c.provider.apiBase;
    e.apiKey = c.provider.apiKey;
    e.model = c.model;
    // Only the APIs that take a reasoning effort are sent one.
    if (c.provider.kind == "openai" || c.provider.kind == "responses" || c.provider.kind == "openrouter") e.reasoningEffort = c.option("reasoning_effort");
    if (use == "embedding") e.embeddingModel = c.model;
    e.access = c.provider;
    return p;
}

ServerSettingsService::TtsConfig ServerSettingsService::ttsConfig(const std::string& serverId) {
    TtsConfig t;
    t.language = language(serverId);
    auto c = useConfig(serverId, "tts");
    t.provider = c.live() ? c.provider.kind : c.mode;
    if (!c.live()) return t;
    t.apiBase = c.provider.apiBase; t.apiKey = c.provider.apiKey; t.model = c.model; t.voice = c.option("voice"); t.access = c.provider;
    return t;
}

static logstudio::ImageConfig imageConfigOf(const ai::UseConfig& c) {
    logstudio::ImageConfig out;
    out.provider = c.live() ? c.provider.kind : c.mode;
    if (!c.live()) return out;
    out.apiBase = c.provider.apiBase; out.apiKey = c.provider.apiKey; out.model = c.model;
    out.size = c.option("size", "auto"); out.quality = c.option("quality", "auto");
    out.access = c.provider;
    return out;
}
logstudio::ImageConfig ServerSettingsService::imageConfigForChannel(const std::string& channelId) {
    auto serverId = serverOfChannel(channelId);
    if (serverId.empty()) return logstudio::ImageConfig();   // disabled
    auto generation = useConfig(serverId, "image_generation");
    auto out = imageConfigOf(generation);
    // Editing set apart from generation (another provider or model, or turned off): reference requests go there. An
    // editing use identical to generation (as migrated from the single image provider) is the same provider, so its
    // configuration id, which queued jobs are checked against, does not change.
    auto edit = useRow(serverId, "image_edit"), gen = useRow(serverId, "image_generation");
    bool same = edit.mode == gen.mode && edit.providerId == gen.providerId && edit.model == gen.model && edit.options == gen.options;
    if (edit.mode != "inherit" && !same) out.edit = std::make_shared<logstudio::ImageConfig>(imageConfigOf(useConfig(serverId, "image_edit")));
    return out;
}

// ---- the old single-provider settings ---------------------------------------------------------------------------
namespace {
// The old provider names and the kinds they stand for. Kinds are accepted as they are.
std::string legacyKind(const std::string& group, const std::string& provider) {
    if (group == "llm") return provider == "openai_compatible" ? "responses" : provider;
    if (group == "image") return provider == "gpt_image" ? "openai" : provider;
    return provider == "qwen" ? "alibaba" : provider;
}
std::string legacyName(const std::string& group, const std::string& kind) {
    if (group == "llm") return kind == "responses" ? "openai_compatible" : kind;
    if (group == "image") return kind == "openai" ? "gpt_image" : kind;
    return kind == "alibaba" ? "qwen" : kind;
}
}

Json::Value ServerSettingsService::legacyAiView(const std::string& serverId) {
    Json::Value v;
    auto group = [&](const char* name, const char* use) {
        auto row = useRow(serverId, use);
        Json::Value g;
        if (row.mode == "inherit") row = useRow(serverId, "text");
        Json::Value pr = row.providerId.empty() ? Json::Value() : providerRow(serverId, row.providerId);
        g["provider"] = row.mode != "provider" ? Json::Value(row.mode) : pr.isNull() ? Json::Value("disabled") : Json::Value(legacyName(name, pr["kind"].asString()));
        g["api_base"] = pr.isNull() ? "" : pr["api_base"].asString();
        g["model"] = row.model;
        g["api_key_set"] = !pr.isNull() && !pr["api_key_sealed"].asString().empty();
        g["api_key_hint"] = pr.isNull() ? "" : pr["api_key_hint"].asString();
        return std::make_pair(g, row);
    };
    auto [llm, text] = group("llm", "text");
    llm["reasoning_effort"] = text.options["reasoning_effort"].isString() ? text.options["reasoning_effort"] : Json::Value("");
    auto embedding = useRow(serverId, "embedding");
    llm["embedding_model"] = embedding.mode == "provider" && embedding.providerId == text.providerId ? embedding.model : "";
    v["llm"] = llm;
    auto [image, gen] = group("image", "image_generation");
    image["size"] = gen.options["size"].isString() ? gen.options["size"] : Json::Value("auto");
    image["quality"] = gen.options["quality"].isString() ? gen.options["quality"] : Json::Value("auto");
    v["image"] = image;
    auto [tts, speech] = group("tts", "tts");
    tts["voice"] = speech.options["voice"].isString() ? speech.options["voice"] : Json::Value("");
    v["tts"] = tts;
    return v;
}

void ServerSettingsService::applyLegacyAi(const Principal& p, const std::string& serverId, const Json::Value& b) {
    struct Group { const char* name; const char* use; const char* capability; const char* newName; };
    const auto view = legacyAiView(serverId);
    for (const Group g : {Group{"llm", "text", "text", "Language model"}, Group{"image", "image_generation", "image_generation", "Images"}, Group{"tts", "tts", "tts", "Voice"}}) {
        const auto& in = b[g.name];
        if (!in.isObject()) continue;
        // A group sent back as it was read (older clients save every group) changes nothing.
        bool changed = !str(in, "api_key", "").empty() || json::toBool(in, "clear_api_key", false);
        for (const auto& k : in.getMemberNames())
            if (k != "api_key" && k != "clear_api_key" && k != "api_key_set" && k != "api_key_hint" && !(in[k] == view[g.name][k])) changed = true;
        if (!changed) continue;
        auto current = useRow(serverId, g.use);
        Json::Value pr = current.providerId.empty() ? Json::Value() : providerRow(serverId, current.providerId);
        std::string currentProvider = current.mode != "provider" || pr.isNull() ? current.mode : legacyName(g.name, pr["kind"].asString());
        auto provider = str(in, "provider", currentProvider);
        // Field checks the old settings made, kept with their messages.
        auto apiBase = str(in, "api_base", pr.isNull() ? "" : pr["api_base"].asString());
        if (!apiBase.empty()) checkUrl(apiBase);
        auto model = str(in, "model", current.model);
        if (model.size() > 120) throw badRequest(std::string(g.name == std::string("llm") ? "model name" : g.name == std::string("image") ? "image model" : "TTS model") + " is too long");
        Json::Value options = current.options;
        if (std::string(g.name) == "llm" && in.isMember("reasoning_effort")) options["reasoning_effort"] = str(in, "reasoning_effort", "");
        if (std::string(g.name) == "image") { if (in.isMember("size")) options["size"] = str(in, "size", "auto"); if (in.isMember("quality")) options["quality"] = str(in, "quality", "auto"); }
        if (std::string(g.name) == "tts" && in.isMember("voice")) options["voice"] = str(in, "voice", "");
        options = cleanUseOptions(g.capability, options);

        if (provider == "mock" || provider == "disabled") {
            if (!allowsMode(g.use, provider)) throw badRequest(std::string("unsupported ") + (std::string(g.name) == "llm" ? "LLM" : std::string(g.name) == "image" ? "image" : "speech") + " provider");
            // The old settings kept the endpoint and key with the mock mode: they stay on the remembered provider.
            auto key = str(in, "api_key", "");
            if (!key.empty()) { checkSecret(key); if (key.size() > 500) throw badRequest("API key is too long"); }
            std::string remembered = pr.isNull() ? "" : pr["id"].asString();
            if (!pr.isNull()) {
                std::string sealed = pr["api_key_sealed"].asString(), hint = pr["api_key_hint"].asString();
                if (json::toBool(in, "clear_api_key", false)) { sealed.clear(); hint.clear(); }
                if (!key.empty()) { sealed = crypto::sealSecret(cfg_.authSecret, key); hint = keyHint(key); }
                db_.exec("UPDATE server_ai_providers SET api_base=$2, api_key_sealed=$3, api_key_hint=$4, updated_at=now() WHERE id=$1", {remembered, apiBase, sealed, hint});
            } else if (!key.empty()) {
                std::string kind = std::string(g.name) == "llm" ? "responses" : "openai", name = g.newName;
                for (int i = 2; !db_.queryOne("SELECT 1 AS x FROM server_ai_providers WHERE server_id=$1 AND name=$2", {serverId, name}).isNull(); ++i) name = std::string(g.newName) + " " + std::to_string(i);
                remembered = db_.queryOne("INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
                                          {serverId, name, kind, apiBase, crypto::sealSecret(cfg_.authSecret, key), keyHint(key), p.userId})["id"].asString();
            }
            UseRow row; row.mode = provider; row.options = options; row.model = model; row.providerId = remembered;
            writeUse(serverId, g.use, row);
            if (std::string(g.name) == "image") { UseRow edit; edit.mode = "inherit"; edit.options = Json::Value(Json::objectValue); writeUse(serverId, "image_edit", edit); }
            continue;
        }
        auto kind = legacyKind(g.name, provider);
        if (!cat::supports(kind, g.capability))
            throw badRequest(std::string("unsupported ") + (std::string(g.name) == "llm" ? "LLM" : std::string(g.name) == "image" ? "image" : "speech") + " provider");
        // The same kind keeps its provider; another kind gets a provider of its own.
        bool reuse = !pr.isNull() && pr["kind"].asString() == kind;
        // The old settings had one key and endpoint per group: switching the protocol kept them.
        std::string sealed = pr.isNull() ? "" : pr["api_key_sealed"].asString(), hint = pr.isNull() ? "" : pr["api_key_hint"].asString();
        if (json::toBool(in, "clear_api_key", false)) { sealed.clear(); hint.clear(); }
        auto key = str(in, "api_key", "");
        if (!key.empty()) { checkSecret(key); if (key.size() > 500) throw badRequest("API key is too long"); sealed = crypto::sealSecret(cfg_.authSecret, key); hint = keyHint(key); }
        if (sealed.empty()) {
            if (std::string(g.name) == "llm") throw badRequest("an API key is required for a live LLM provider");
            if (std::string(g.name) == "image") throw badRequest(kind == "openai" ? "an API key is required for GPT Image" : "an API key is required for this image provider");
            throw badRequest(kind == "alibaba" ? "an API key is required for Qwen speech" : kind == "openai" ? "an API key is required for OpenAI speech" : "an API key is required for this speech provider");
        }
        if (model.empty()) {
            if (std::string(g.name) == "llm") throw badRequest("a model is required for a live LLM provider");
            if (std::string(g.name) == "image") throw badRequest(kind == "openai" ? "image model is required for GPT Image" : "an image model is required");
        }
        std::string providerId;
        if (reuse) {
            providerId = pr["id"].asString();
            db_.exec("UPDATE server_ai_providers SET api_base=$2, api_key_sealed=$3, api_key_hint=$4, updated_at=now() WHERE id=$1", {providerId, apiBase, sealed, hint});
        } else {
            std::string name = g.newName;
            for (int i = 2; !db_.queryOne("SELECT 1 AS x FROM server_ai_providers WHERE server_id=$1 AND name=$2", {serverId, name}).isNull(); ++i) name = std::string(g.newName) + " " + std::to_string(i);
            providerId = db_.queryOne("INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
                                      {serverId, name, kind, apiBase, sealed, hint, p.userId})["id"].asString();
        }
        UseRow row; row.mode = "provider"; row.providerId = providerId; row.model = model; row.options = options;
        writeUse(serverId, g.use, row);
        if (std::string(g.name) == "image") {
            UseRow edit = row; if (!cat::supports(kind, "image_edit")) { edit.mode = "inherit"; edit.providerId.clear(); }
            writeUse(serverId, "image_edit", edit);
        }
        if (std::string(g.name) == "llm" && in.isMember("embedding_model")) {
            auto embedding = str(in, "embedding_model", "");
            if (embedding.size() > 120) throw badRequest("embedding model is too long");
            UseRow e;
            if (!embedding.empty() && cat::supports(kind, "embedding")) { e.mode = "provider"; e.providerId = providerId; e.model = embedding; }
            else e.mode = "disabled";
            e.options = Json::Value(Json::objectValue);
            writeUse(serverId, "embedding", e);
        }
    }
}

} // namespace acerciae
