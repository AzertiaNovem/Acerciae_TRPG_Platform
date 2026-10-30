#include "TtsService.h"
#include "../servers/AiPolicyService.h"
#include "StudioPolicy.h"
#include "PresentationService.h"
#include "LogStudioService.h"
#include "../ws/Notifier.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include "../core/Log.h"
#include "../knowledge/Visibility.h"
#include "MediaService.h"
#include "../servers/ServerSettingsService.h"
#include <chrono>
#include <future>
#include <set>

namespace acerciae::logstudio {
static int utf8Chars(const std::string& s) { int n=0; for (unsigned char c : s) if ((c & 0xc0) != 0x80) ++n; return n; }
static DbParam opt(const std::string& s) { return s.empty() ? dbNull() : DbParam(s); }
static std::string envs(const char* k, const char* d) { const char* v = std::getenv(k); return (v && *v) ? std::string(v) : std::string(d); }

TtsService::TtsService(const Config& cfg, Db& db, ObjectStore& store, Notifier& n, PresentationService& pres, ServerSettingsService& settings, AiPolicyService& policy) : cfg_(cfg), db_(db), store_(store), notifier_(n), pres_(pres), provider_(makeTtsProvider()), settings_(settings), policy_(policy) {
    concurrency_ = std::max(1, std::atoi(envs("TTS_CONCURRENCY", "2").c_str()));
}
std::shared_ptr<TtsProvider> TtsService::providerFor(const std::string& channelId) {
    auto ch=db_.queryOne("SELECT server_id FROM channels WHERE id=$1",{channelId});
    if(ch.isNull()) throw notFound("channel not found");
    auto c=settings_.ttsConfig(ch["server_id"].asString());
    if(c.provider=="disabled") throw ApiError(403,"tts_disabled","Speech is turned off on this server (Server settings → AI)");
    if(c.provider!="qwen"&&c.provider!="openai") return provider_;
    Json::Value v; v["provider"]=c.provider; v["api_key"]=c.apiKey; if(!c.apiBase.empty())v["api_base"]=c.apiBase; if(!c.model.empty())v["model"]=c.model; if(!c.voice.empty())v["voice"]=c.voice;
    auto key=crypto::sha256Hex(json::dump(v));std::lock_guard<std::mutex> guard(providersMu_);
    auto it=providers_.find(key);if(it!=providers_.end())return it->second;
    auto made=std::shared_ptr<TtsProvider>(makeTtsProvider(v));if(providers_.size()>32)providers_.clear();providers_[key]=made;return made;
}
TtsService::~TtsService() { stop(); }
void TtsService::start() { if (running_.exchange(true)) return; try { db_.exec("UPDATE tts_jobs SET status='pending' WHERE status='running' AND updated_at<now()-interval '5 minutes'"); } catch (...) {} worker_ = std::thread([this] { workerLoop(); }); }
void TtsService::stop() { if (!running_.exchange(false)) return; cv_.notify_all(); if (worker_.joinable()) worker_.join(); }

Json::Value TtsService::status(const ChannelAccess& a) {
    auto provider = providerFor(a.channelId);
    Json::Value s; s["provider"] = provider->name(); s["mock"] = provider->isMock(); s["official_model"] = provider->officialModel(); s["preview_model"] = provider->previewModel(); s["capabilities"] = provider->capabilities(); s["concurrency"] = concurrency_;
    s["note"] = provider->isMock() ? "MOCK TTS MODE: audio files are synthetic tones labelled as mock. A server maintainer picks a speech provider in Server settings → AI." : "live"; return s;
}
Json::Value TtsService::availableVoices(const ChannelAccess& a) {
    auto provider = providerFor(a.channelId); Json::Value v(Json::arrayValue); for (auto& x : provider->listAvailableVoices()) { Json::Value j; j["id"] = x.id; j["name"] = x.name; j["language"] = x.language; j["gender"] = x.gender; j["description"] = x.description; j["type"] = x.type; v.append(j); } return v; }

// ---- voice profiles --------------------------------------------------------------------------------
Json::Value TtsService::listVoices(const ChannelAccess& a) {
    // Every member casts from the same voices: narrator voices and player characters' voices are shared. A voice
    // bound to an NPC stays with the Keeper (its name would reveal the NPC), and only the owner sees consent records.
    auto rows = db_.queryJson("SELECT v.*, c.name AS character_name, (SELECT count(*) FROM tts_audio_assets t WHERE t.voice_profile_id=v.id) AS cached_lines FROM voice_profiles v LEFT JOIN characters c ON c.id=v.character_id WHERE v.channel_id=$1"+std::string(a.isGm?"":" AND (v.character_id IS NULL OR c.kind='pc' OR v.created_by=$2 OR c.user_id=$2)")+" ORDER BY v.created_at", a.isGm?DbParams{a.channelId}:DbParams{a.channelId,a.userId});
    if (!a.isGm) for (auto& v : rows) { if (v["created_by"].asString() != a.userId) { v["consent_metadata"] = Json::Value(); v["editable"] = false; } else v["editable"] = true; }
    return rows;
}
Json::Value TtsService::voiceRow(const std::string& channelId, const std::string& id) { auto v = db_.queryOne("SELECT * FROM voice_profiles WHERE id=$1 AND channel_id=$2", {id, channelId}); if (v.isNull()) throw notFound("voice profile not found"); return v; }
Json::Value TtsService::createVoice(const ChannelAccess& a, const Json::Value& body, const std::string& refAudio, const std::string& /*refMime*/) {
    auto provider = providerFor(a.channelId);
    auto type = json::str(body, "voice_type", "preset");
    if (type != "preset" && type != "design" && type != "clone") throw badRequest("voice_type must be preset|design|clone");
    auto charId = json::str(body, "character_id");
    if (!charId.empty()) { auto c = db_.queryOne("SELECT user_id FROM characters WHERE id=$1 AND channel_id=$2", {charId, a.channelId}); if (c.isNull()) throw badRequest("character not in channel"); if (!a.isGm && (c["user_id"].isNull() || c["user_id"].asString() != a.userId)) throw forbidden("not your character"); }
    std::string voiceId = json::str(body, "voice_id"); Json::Value consent = body["consent_metadata"]; Json::Value meta;
    auto model = json::str(body, "model_id", provider->officialModel());
    auto dict = json::str(body, "pronunciation_dictionary_id"); if (!dict.empty() && db_.queryOne("SELECT id FROM pronunciation_dictionaries WHERE id=$1 AND channel_id=$2", {dict,a.channelId}).isNull()) throw badRequest("dictionary not in channel");
    if(!provider->isMock()&&(type=="design"||type=="clone")) requireCloudPermission(db_,a.channelId);
    if (type == "design") {
        auto prompt = json::requireStr(body, "design_prompt");
        VoiceProfileCreateRequest r; r.kind = "design"; r.targetModel = model; r.preferredName = json::str(body, "name", "voice"); r.designPrompt = prompt; r.language = json::str(body, "language", "zh");
        auto res = provider->createVoiceProfile(r); if (!res.ok) throw ApiError(502, "tts_error", res.error); voiceId = res.voiceId; meta = res.providerMeta;
    } else if (type == "clone") {
        // Consent is mandatory and recorded. Cloning real people without authorisation is refused by policy; the
        // statement is stored with the profile for audit.
        if (!consent.isObject() || !json::toBool(consent, "consent_given") || json::str(consent, "rights_holder").empty() || json::str(consent, "statement").empty())
            throw badRequest("voice cloning requires consent_metadata {consent_given:true, rights_holder, statement} confirming you hold the rights to this voice");
        if (!MediaService::allowedMime(MediaService::sniffMime(refAudio, "voice.wav"), "audio")) throw badRequest("invalid reference audio");
        if (refAudio.empty()) throw badRequest("reference audio file required for cloning");
        if (refAudio.size() > 20 * 1024 * 1024) throw badRequest("reference audio too large (20 MB max)");
        consent["recorded_at"] = text::nowIso(); consent["recorded_by"] = a.userId; consent["reference_bytes"] = (Json::UInt64)refAudio.size();
        VoiceProfileCreateRequest r; r.kind = "clone"; r.targetModel = model; r.preferredName = json::str(body, "name", "voice"); r.referenceAudio = refAudio; r.referenceMime = MediaService::sniffMime(refAudio, "voice.wav"); r.language = json::str(body, "language", "zh");
        auto res = provider->createVoiceProfile(r); if (!res.ok) throw ApiError(502, "tts_error", res.error); voiceId = res.voiceId; meta = res.providerMeta;
    } else if (voiceId.empty()) throw badRequest("voice_id required for preset voices");
    Json::Value params = body["synthesis_parameters"].isObject() ? body["synthesis_parameters"] : Json::Value(Json::objectValue);
    auto row = db_.queryOne("INSERT INTO voice_profiles(channel_id, character_id, name, provider, model_id, voice_id, voice_type, language, dialect, style_instruction, pronunciation_dictionary_id, synthesis_parameters, consent_metadata, design_prompt, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15) RETURNING *",
        {a.channelId, opt(charId), json::str(body, "name", voiceId), provider->name(), model, voiceId, type, json::str(body, "language", "zh"), json::str(body, "dialect"), json::str(body, "style_instruction"), opt(json::str(body, "pronunciation_dictionary_id")), json::dump(params), consent.isObject() ? DbParam(json::dump(consent)) : dbNull(), opt(json::str(body, "design_prompt")), a.userId});
    row["provider_meta"] = meta; return row;
}
Json::Value TtsService::updateVoice(const ChannelAccess& a, const std::string& id, const Json::Value& body) {
    auto cur = voiceRow(a.channelId, id);
    if (!a.isGm && cur["created_by"].asString() != a.userId) throw forbidden("not your voice profile");
    auto charId=json::str(body,"character_id",json::str(cur,"character_id"));
    if(!charId.empty()) { auto c=db_.queryOne("SELECT user_id FROM characters WHERE id=$1 AND channel_id=$2",{charId,a.channelId});if(c.isNull()||(!a.isGm&&c["user_id"]!=a.userId))throw forbidden("not your character"); }
    auto dictionary=json::str(body,"pronunciation_dictionary_id",json::str(cur,"pronunciation_dictionary_id"));if(!dictionary.empty()&&db_.queryOne("SELECT id FROM pronunciation_dictionaries WHERE id=$1 AND channel_id=$2",{dictionary,a.channelId}).isNull())throw badRequest("dictionary not in channel");
    // Any change to identity/instruction/parameters bumps the version → new cache keys for affected lines only.
    return db_.queryOne("UPDATE voice_profiles SET name=$3, character_id=$4, voice_id=$5, language=$6, dialect=$7, style_instruction=$8, pronunciation_dictionary_id=$9, synthesis_parameters=$10::jsonb, model_id=$11, version=version+1, updated_at=now() WHERE id=$1 AND channel_id=$2 RETURNING *",
        {id, a.channelId, json::str(body, "name", cur["name"].asString()), opt(json::str(body, "character_id", cur["character_id"].isNull() ? "" : cur["character_id"].asString())), json::str(body, "voice_id", cur["voice_id"].asString()), json::str(body, "language", cur["language"].asString()), json::str(body, "dialect", cur["dialect"].asString()), json::str(body, "style_instruction", cur["style_instruction"].asString()),
         opt(json::str(body, "pronunciation_dictionary_id", cur["pronunciation_dictionary_id"].isNull() ? "" : cur["pronunciation_dictionary_id"].asString())), json::dump(body["synthesis_parameters"].isObject() ? body["synthesis_parameters"] : cur["synthesis_parameters"]), json::str(body, "model_id", cur["model_id"].asString())});
}
Json::Value TtsService::deleteVoice(const ChannelAccess& a, const std::string& id) { auto cur = voiceRow(a.channelId, id); if (!a.isGm && cur["created_by"].asString() != a.userId) throw forbidden("not your voice profile"); db_.exec("DELETE FROM voice_profiles WHERE id=$1", {id}); Json::Value v; v["deleted"] = true; return v; }

// ---- dictionaries ------------------------------------------------------------------------------------
Json::Value TtsService::listDictionaries(const ChannelAccess& a) { if(!a.isGm)return Json::Value(Json::arrayValue); return db_.queryJson("SELECT * FROM pronunciation_dictionaries WHERE channel_id=$1 ORDER BY name", {a.channelId}); }
Json::Value TtsService::saveDictionary(const ChannelAccess& a, const std::string& id, const Json::Value& body) {
    if (!a.isGm) throw forbidden("GM role required");
    Json::Value entries(Json::arrayValue);
    for (auto& e : body["entries"]) { if (!e.isObject() || json::str(e, "term").empty()) continue; Json::Value x; x["term"] = json::str(e, "term"); x["reading"] = json::str(e, "reading"); x["mode"] = json::str(e, "mode", "replace"); x["language"] = json::str(e, "language", "zh"); entries.append(x); }
    if (id.empty()) return db_.queryOne("INSERT INTO pronunciation_dictionaries(channel_id, name, entries) VALUES($1,$2,$3::jsonb) RETURNING *", {a.channelId, json::str(body, "name", "Campaign pronunciations"), json::dump(entries)});
    auto cur = db_.queryOne("SELECT id FROM pronunciation_dictionaries WHERE id=$1 AND channel_id=$2", {id, a.channelId}); if (cur.isNull()) throw notFound("dictionary not found");
    return db_.queryOne("UPDATE pronunciation_dictionaries SET name=$2, entries=$3::jsonb, version=version+1, updated_at=now() WHERE id=$1 RETURNING *", {id, json::str(body, "name", "Campaign pronunciations"), json::dump(entries)});
}
// Display text is never changed; this produces the *spoken* text only. Phoneme-mode entries fall back to the
// reading when the provider has no phoneme hint API.
std::string TtsService::applyDictionary(const std::string& textIn, const Json::Value& entries, bool phonemeSupported) {
    std::string t = textIn;
    if (!entries.isArray()) return t;
    for (auto& e : entries) {
        auto term = json::str(e, "term"), reading = json::str(e, "reading"); if (term.empty() || reading.empty()) continue;
        if (json::str(e, "mode") == "phoneme" && phonemeSupported) continue;
        size_t pos = 0; while ((pos = t.find(term, pos)) != std::string::npos) { t.replace(pos, term.size(), reading); pos += reading.size(); }
    }
    return t;
}

static void pronunciationHints(Json::Value& params,const Json::Value& entries,bool supported) {
    if(!supported) return;
    for(const auto& e:entries) if(json::str(e,"mode")=="phoneme"&&!json::str(e,"term").empty()&&!json::str(e,"reading").empty()) {
        Json::Value hint; hint[e["term"].asString()]=e["reading"]; params["hot_fix"]["pronunciation"].append(hint);
    }
}

std::string TtsService::cacheKey(const std::string& provider, const std::string& model, const std::string& voiceId, int voiceVersion, const std::string& text, const std::string& instruction, int dictVersion, const Json::Value& params) {
    return crypto::sha256Hex(provider + "\n" + model + "\n" + voiceId + "\n" + std::to_string(voiceVersion) + "\n" + text + "\n" + instruction + "\n" + std::to_string(dictVersion) + "\n" + json::dump(params));
}

std::vector<TtsService::LinePlan> TtsService::plan(const ChannelAccess& a, const std::string& presentationId, const Json::Value& scope, bool force, const std::string& modelOverride) {
    auto provider = providerFor(a.channelId);
    auto p = pres_.get(a, presentationId);
    std::set<std::string> eventFilter; for (auto& id : json::strArray(scope["event_ids"])) eventFilter.insert(id);
    std::set<std::string> sceneFilter; for (auto& id : json::strArray(scope["scene_ids"])) sceneFilter.insert(id);
    // Voice resolution: explicit per-line profile → character's profile → none (line skipped, reported).
    std::map<std::string, Json::Value> voiceByChar; std::map<std::string, Json::Value> voiceById;
    for (auto& v : db_.queryJson("SELECT * FROM voice_profiles WHERE channel_id=$1 ORDER BY created_at", {a.channelId})) { voiceById[v["id"].asString()] = v; if (!v["character_id"].isNull() && !voiceByChar.count(v["character_id"].asString())) voiceByChar[v["character_id"].asString()] = v; }
    std::map<std::string, Json::Value> dicts; for (auto& d : db_.queryJson("SELECT * FROM pronunciation_dictionaries WHERE channel_id=$1", {a.channelId})) dicts[d["id"].asString()] = d;
    std::vector<LinePlan> out;
    for (auto& e : p["events"]) {
        if (e["hidden"].asBool()) continue;
        auto kind = e["display_kind"].asString(); if (kind == "ooc" || kind == "system" || kind == "media" || kind == "scene_change") continue;
        if (!eventFilter.empty() && !eventFilter.count(e["id"].asString())) continue;
        if (!sceneFilter.empty() && (e["scene_id"].isNull() || !sceneFilter.count(e["scene_id"].asString()))) continue;
        Json::Value voice;
        if (!e["voice_profile_id"].isNull() && voiceById.count(e["voice_profile_id"].asString())) voice = voiceById[e["voice_profile_id"].asString()];
        else if (!e["speaker_character_id"].isNull() && voiceByChar.count(e["speaker_character_id"].asString())) voice = voiceByChar[e["speaker_character_id"].asString()];
        else if (kind == "narration" || kind == "dice") { for (auto& [id, v] : voiceById) if (v["character_id"].isNull()) { voice = v; break; } }
        if (voice.isNull()) continue;
        if (voice["provider"] != provider->name()) throw badRequest("voice profile belongs to a different provider; recreate it for the configured provider");
        LinePlan l; l.eventId = e["id"].asString(); l.voiceProfileId = voice["id"].asString(); l.voiceId = voice["voice_id"].asString(); l.modelId = modelOverride.empty() ? voice["model_id"].asString() : modelOverride; l.voiceVersion = voice["version"].asInt(); l.params = voice["synthesis_parameters"]; l.language = voice["language"].asString();
        std::string spoken = e["tts_text"].isNull() || e["tts_text"].asString().empty() ? e["display_text"].asString() : e["tts_text"].asString();
        if (!voice["pronunciation_dictionary_id"].isNull() && dicts.count(voice["pronunciation_dictionary_id"].asString())) { auto& d = dicts[voice["pronunciation_dictionary_id"].asString()]; spoken = applyDictionary(spoken, d["entries"], provider->supportsPhonemeHints()); l.dictVersion = d["version"].asInt(); pronunciationHints(l.params,d["entries"],provider->supportsPhonemeHints()); }
        l.text = spoken;
        std::string ident = voice["style_instruction"].asString() + (json::str(voice,"dialect").empty()?"":"; dialect: "+json::str(voice,"dialect")), line = e["style_instruction"].asString();
        l.instruction = ident.empty() ? line : (line.empty() ? ident : ident + "; " + line);
        l.params["language"] = l.language; l.cacheKey = cacheKey(a.channelId + ":" + l.voiceProfileId + ":" + provider->cacheNamespace(), l.modelId, l.voiceId, l.voiceVersion, l.text, l.instruction, l.dictVersion, l.params);
        auto hit = db_.queryOne("SELECT id FROM tts_audio_assets WHERE cache_key=$1", {l.cacheKey});
        if (!hit.isNull()) { l.cached = true; l.cachedAudioId = hit["id"].asString(); }
        if (!force && l.cached && e["audio_asset_id"] == l.cachedAudioId) continue;
        out.push_back(l);
    }
    return out;
}

Json::Value TtsService::estimate(const ChannelAccess& a, const std::string& presentationId, const Json::Value& scope) {
    auto provider = providerFor(a.channelId);
    auto lines = plan(a, presentationId, scope, json::toBool(scope, "force"), json::str(scope, "model_id"));
    Json::Value out; int chars = 0, cached = 0, fresh = 0; double cost = 0;
    for (auto& l : lines) { if (l.cached) cached++; else { fresh++; chars += utf8Chars(l.text); cost += provider->estimateSynthesisCost(l.modelId, utf8Chars(l.text)); } }
    auto used = usage(a);
    out["lines"] = (int)lines.size(); out["cached_lines"] = cached; out["lines_to_synthesize"] = fresh; out["chars"] = chars; out["estimated_cost"] = cost; out["currency_note"] = "Configured character-price estimate only. Qwen 3.1 Flash uses token billing; exact provider charges are unknown before synthesis."; out["cost_known"] = provider->isMock() || (std::atof(envs("TTS_PRICE_PER_10K_CHARS","0").c_str()) > 0 && provider->officialModel().find("flash") == std::string::npos);
    for(const auto& l:lines) if(!l.cached&&!provider->isMock()&&l.modelId.find("flash")!=std::string::npos) out["cost_known"]=false;
    out["budget_chars"] = used["budget_chars"]; out["used_chars"] = used["used_chars"]; out["within_budget"] = used["used_chars"].asInt64() + chars <= used["budget_chars"].asInt64(); out["provider"] = provider->name(); out["mock"] = provider->isMock();
    return out;
}
Json::Value TtsService::usage(const ChannelAccess& a) {
    auto provider = providerFor(a.channelId);
    auto r = db_.queryOne("SELECT (SELECT tts_budget_chars FROM channels WHERE id=$1) AS budget_chars, coalesce((SELECT sum(chars) FROM tts_usage_records WHERE channel_id=$1 AND NOT cached),0) AS used_chars, coalesce((SELECT sum(estimated_cost) FROM tts_usage_records WHERE channel_id=$1 AND NOT cached),0) AS estimated_cost, (SELECT count(*) FROM tts_audio_assets WHERE channel_id=$1) AS cached_assets, (SELECT count(*) FROM tts_usage_records WHERE channel_id=$1 AND cached) AS cache_hits", {a.channelId});
    r["provider"] = provider->name(); return r;
}

std::string TtsService::synthesizeLine(const std::string& channelId, const LinePlan& l, const std::string& userId, std::string& error, bool& retryable) {
    // One synthesis per cache key at a time (the cache makes the second caller a hit). No database transaction or
    // connection is held while the provider runs.
    {
        std::unique_lock<std::mutex> lk(inflightMu_);
        inflightCv_.wait(lk, [&] { return !inflight_.count(l.cacheKey); });
        inflight_.insert(l.cacheKey);
    }
    struct Release { TtsService* s; const std::string& k; ~Release() { { std::lock_guard<std::mutex> g(s->inflightMu_); s->inflight_.erase(k); } s->inflightCv_.notify_all(); } } release{this, l.cacheKey};
    auto provider = providerFor(channelId);
    auto hit = db_.queryOne("SELECT id FROM tts_audio_assets WHERE cache_key=$1", {l.cacheKey});
    if (!hit.isNull()) { db_.exec("INSERT INTO tts_usage_records(channel_id, provider, model_id, chars, estimated_cost, cached) VALUES($1,$2,$3,$4,0,true)", {channelId, provider->name(), l.modelId, (int64_t)utf8Chars(l.text)}); return hit["id"].asString(); }
    if (!provider->isMock()) requireCloudPermission(db_, channelId);
    TtsSynthesisRequest req; req.modelId = l.modelId; req.voiceId = l.voiceId; req.text = l.text; req.language = l.language; req.instruction = l.instruction; req.parameters = l.params;
    // Charge the channel's character budget up front (under the channel row lock) and refund it if synthesis fails.
    auto usage = db_.tx([&](pqxx::work& w) {
        auto budget = Db::queryOne(w, "SELECT tts_budget_chars FROM channels WHERE id=$1 FOR UPDATE", {channelId});
        auto used = Db::queryOne(w, "SELECT coalesce(sum(chars),0) AS n FROM tts_usage_records WHERE channel_id=$1 AND NOT cached", {channelId});
        if (used["n"].asInt64() + utf8Chars(l.text) > budget["tts_budget_chars"].asInt64()) throw ApiError(429, "budget_exceeded", "channel TTS budget exhausted");
        return Db::queryOne(w, "INSERT INTO tts_usage_records(channel_id,provider,model_id,chars,estimated_cost,cached) VALUES($1,$2,$3,$4,$5,false) RETURNING id",
            {channelId, provider->name(), l.modelId, (int64_t)utf8Chars(l.text), provider->estimateSynthesisCost(l.modelId, utf8Chars(l.text))});
    });
    TtsSynthesisResult res;
    try {
        std::shared_ptr<void> slot = provider->isMock() ? nullptr : policy_.acquire(channelId);
        res = provider->synthesize(req);
    } catch (const std::exception& e) { res.ok = false; res.error = e.what(); res.retryable = true; }
    if (!res.ok) {
        db_.exec("DELETE FROM tts_usage_records WHERE id=$1", {usage["id"].asString()});
        error = res.error; retryable = res.retryable; return "";
    }
    auto key = safeObjectKey(channelId, "tts", res.mime == "audio/wav" ? "wav" : "mp3");
    store_.put(key, res.audioBytes, res.mime);
    int dur = res.durationMs ? res.durationMs : (res.mime == "audio/wav" ? wavDurationMs(res.audioBytes) : 0);
    auto row = db_.queryOne("INSERT INTO tts_audio_assets(channel_id, cache_key, provider, model_id, voice_id, voice_profile_id, voice_profile_version, spoken_text, style_instruction, dictionary_version, synthesis_parameters, object_key, mime, bytes, duration_ms, word_timestamps, is_mock, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18) ON CONFLICT (cache_key) DO UPDATE SET bytes=EXCLUDED.bytes RETURNING id",
        {channelId, l.cacheKey, provider->name(), l.modelId, l.voiceId, opt(l.voiceProfileId), (int64_t)l.voiceVersion, l.text, l.instruction, (int64_t)l.dictVersion, json::dump(l.params), key, res.mime, (int64_t)res.audioBytes.size(), dur ? DbParam((int64_t)dur) : dbNull(), res.wordTimestamps.isNull() ? dbNull() : DbParam(json::dump(res.wordTimestamps)), provider->isMock(), opt(userId)});
    return row["id"].asString();
}

Json::Value TtsService::preview(const ChannelAccess& a, const Json::Value& body) {
    auto provider = providerFor(a.channelId);
    auto voice = voiceRow(a.channelId, json::requireStr(body, "voice_profile_id"));
    if(!a.isGm&&voice["created_by"]!=a.userId) {
        auto c=db_.queryOne("SELECT user_id FROM characters WHERE id=$1 AND channel_id=$2",{opt(json::str(voice,"character_id")),a.channelId});
        if(c.isNull()||c["user_id"]!=a.userId) throw forbidden("only the character owner or GM may audition this voice");
    }
    if(voice["provider"]!=provider->name()) throw badRequest("voice profile belongs to a different provider");
    auto textIn = json::requireStr(body, "text"); if (textIn.size() > 600) throw badRequest("preview text too long (600 chars max)");
    LinePlan l; l.voiceProfileId = voice["id"].asString(); l.voiceId = voice["voice_id"].asString(); l.modelId = json::str(body, "model_id", (voice["voice_type"].asString() == "preset" ? provider->previewModel() : voice["model_id"].asString())); l.voiceVersion = voice["version"].asInt(); l.params = voice["synthesis_parameters"]; l.language = voice["language"].asString();
    l.text = textIn;
    if (!voice["pronunciation_dictionary_id"].isNull()) { auto d = db_.queryOne("SELECT * FROM pronunciation_dictionaries WHERE id=$1", {voice["pronunciation_dictionary_id"].asString()}); if (!d.isNull()) { l.text = applyDictionary(l.text, d["entries"], provider->supportsPhonemeHints()); l.dictVersion = d["version"].asInt(); pronunciationHints(l.params,d["entries"],provider->supportsPhonemeHints()); } }
    std::string ident = voice["style_instruction"].asString() + (json::str(voice,"dialect").empty()?"":"; dialect: "+json::str(voice,"dialect")), line = json::str(body, "style_instruction"); l.instruction = ident.empty() ? line : (line.empty() ? ident : ident + "; " + line);
    l.params["language"] = l.language; l.cacheKey = cacheKey(a.channelId + ":" + l.voiceProfileId + ":" + provider->cacheNamespace(), l.modelId, l.voiceId, l.voiceVersion, l.text, l.instruction, l.dictVersion, l.params);
    auto u = usage(a); if (u["used_chars"].asInt64() + (int64_t)utf8Chars(l.text) > u["budget_chars"].asInt64() && db_.queryOne("SELECT 1 AS x FROM tts_audio_assets WHERE cache_key=$1", {l.cacheKey}).isNull()) throw ApiError(429, "budget_exceeded", "channel TTS budget exhausted");
    std::string err; bool retry = false; auto id = synthesizeLine(a.channelId, l, a.userId, err, retry);
    if (id.empty()) throw ApiError(502, "tts_error", err);
    auto row = db_.queryOne("SELECT id, mime, duration_ms, is_mock, spoken_text, word_timestamps IS NOT NULL AS has_word_timestamps FROM tts_audio_assets WHERE id=$1", {id});
    row["spoken_text_note"] = l.text != textIn ? "pronunciation dictionary applied to the spoken text only" : ""; row["cache_key"] = l.cacheKey;
    return row;
}

Json::Value TtsService::createJob(const ChannelAccess& a, const std::string& presentationId, const Json::Value& body) {
    auto provider = providerFor(a.channelId);
    auto p = pres_.presentationRow(a, presentationId); if (!(a.isGm || p["created_by"].asString() == a.userId)) throw forbidden("not your presentation");
    Json::Value scope = body.isMember("scope") && body["scope"].isObject() ? body["scope"] : Json::Value(Json::objectValue);
    bool force = json::toBool(body, "force"); scope["force"] = force; auto kind = json::str(body, "kind", "batch"); auto model = json::str(body, "model_id");
    auto lines = plan(a, presentationId, scope, force, model);
    if (lines.empty()) throw badRequest("nothing to synthesize: no visible lines with a voice profile in scope (assign voices to characters first)");
    int chars = 0, cached = 0; double cost = 0; for (auto& l : lines) { if (l.cached) cached++; else { chars += utf8Chars(l.text); cost += provider->estimateSynthesisCost(l.modelId, utf8Chars(l.text)); } }
    auto u = usage(a); if (u["used_chars"].asInt64() + chars > u["budget_chars"].asInt64()) throw ApiError(429, "budget_exceeded", "this job would exceed the channel's TTS budget (" + std::to_string(u["used_chars"].asInt64() + chars) + " / " + std::to_string(u["budget_chars"].asInt64()) + " chars)");
    // Idempotency: identical scope on the same presentation version → same job.
    auto idem = crypto::sha256Hex(presentationId + json::dump(scope) + std::to_string(p["version"].asInt()) + model + kind);
    for (const auto& l : lines) idem = crypto::sha256Hex(idem + l.cacheKey);
    auto existing = db_.queryOne("SELECT * FROM tts_jobs WHERE idempotency_key=$1", {idem});
    if (!existing.isNull()) {
        if(json::toBool(body,"retry")&&(existing["status"]=="failed"||existing["status"]=="cancelled")) {
            auto job=db_.queryOne("UPDATE tts_jobs SET status='pending',done=0,failed=0,cached=0,error=NULL,updated_at=now() WHERE id=$1 AND status IN ('failed','cancelled') RETURNING *",{existing["id"].asString()});
            cv_.notify_all(); if(!job.isNull()) return job;
        }
        return existing;
    }
    Json::Value result; result["planned"] = (int)lines.size(); result["cached"] = cached; result["chars"] = chars; result["estimated_cost"] = cost; Json::Value evs(Json::arrayValue); for (auto& l : lines) evs.append(l.eventId); result["event_ids"] = evs; result["model_id"] = model;
    auto job = db_.queryOne("INSERT INTO tts_jobs(channel_id, presentation_id, kind, scope, status, total, estimated_chars, estimated_cost, provider, idempotency_key, result, created_by) VALUES($1,$2,$3,$4::jsonb,'pending',$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *",
        {a.channelId, presentationId, kind, json::dump(scope), (int64_t)lines.size(), (int64_t)chars, cost, provider->name(), idem, json::dump(result), a.userId});
    cv_.notify_all();
    return job;
}
Json::Value TtsService::getJob(const ChannelAccess& a, const std::string& jobId) { auto j = db_.queryOne("SELECT * FROM tts_jobs WHERE id=$1 AND channel_id=$2", {jobId, a.channelId}); if (j.isNull()) throw notFound("job not found"); pres_.presentationRow(a,j["presentation_id"].asString()); return j; }
Json::Value TtsService::listJobs(const ChannelAccess& a, const std::string& presentationId) { pres_.presentationRow(a,presentationId); return db_.queryJson("SELECT * FROM tts_jobs WHERE channel_id=$1 AND ($2::text = '' OR presentation_id::text=$2) ORDER BY created_at DESC LIMIT 50", {a.channelId, presentationId}); }
Json::Value TtsService::cancelJob(const ChannelAccess& a, const std::string& jobId) { auto j=getJob(a, jobId); if (!a.isGm && j["created_by"] != a.userId) throw forbidden("not your job"); return db_.queryOne("UPDATE tts_jobs SET status=CASE WHEN status IN ('pending','running') THEN 'cancelled' ELSE status END, updated_at=now() WHERE id=$1 RETURNING *", {jobId}); }

bool TtsService::fetchAudio(const ChannelAccess& a, const std::string& audioId, std::string& bytes, std::string& mime) {
    auto row = db_.queryOne("SELECT * FROM tts_audio_assets WHERE id=$1 AND channel_id=$2", {audioId, a.channelId});
    if (row.isNull()) return false;
    if (!a.isGm) {
        // A player may hear a line only if it belongs to a presentation event whose canonical event they may read,
        // or if they requested the preview themselves.
        auto refs = db_.queryJson("SELECT pe.canonical_event_id,pe.merged_event_ids,lp.id AS presentation_id FROM presentation_events pe JOIN log_presentations lp ON lp.id=pe.presentation_id WHERE pe.audio_asset_id=$1",{audioId});
        bool allowed = refs.empty() && row["created_by"] == a.userId;
        for (const auto& ref : refs) {
            try { pres_.presentationRow(a,ref["presentation_id"].asString()); } catch (const ApiError&) { continue; }
            auto ids=json::strArray(ref["merged_event_ids"]); ids.push_back(ref["canonical_event_id"].asString());
            auto n=db_.queryOne("SELECT count(*) AS n FROM log_events le WHERE le.channel_id=$1 AND le.id = ANY(" + Visibility::uuidArray(ids) + ") AND " + visibleLogFilter(a, storyState(db_, a.channelId), "le"),{a.channelId});
            if(n["n"].asInt64()==(int64_t)std::set<std::string>(ids.begin(),ids.end()).size()) {allowed=true;break;}
        }
        if(!allowed) return false;
    }
    auto data = store_.get(row["object_key"].asString()); if (!data) return false;
    bytes = std::move(*data); mime = row["mime"].asString(); return true;
}

// ---- worker -------------------------------------------------------------------------------------------
void TtsService::workerLoop() {
    while (running_) {
        try {
            db_.exec("UPDATE tts_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,updated_at=now() WHERE status='running' AND updated_at<now()-interval '5 minutes'");
            auto job = db_.queryOne("UPDATE tts_jobs SET status='running', started_at=coalesce(started_at, now()), attempts=attempts+1, updated_at=now() WHERE id = (SELECT id FROM tts_jobs WHERE status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id");
            if (!job.isNull()) { runJob(job["id"].asString()); continue; }
        } catch (const std::exception& e) { ALOG_ERROR << "tts worker: " << e.what(); }
        std::unique_lock<std::mutex> lk(mu_); cv_.wait_for(lk, std::chrono::milliseconds(2000), [&] { return !running_.load(); });
    }
}
Json::Value TtsService::processJobNow(const std::string& jobId) { db_.exec("UPDATE tts_jobs SET status='running', started_at=now(), attempts=attempts+1 WHERE id=$1 AND status='pending'", {jobId}); runJob(jobId); return db_.queryOne("SELECT * FROM tts_jobs WHERE id=$1", {jobId}); }

void TtsService::runJob(const std::string& jobId) {
    auto job = db_.queryOne("SELECT j.*, p.created_by AS owner FROM tts_jobs j LEFT JOIN log_presentations p ON p.id=j.presentation_id WHERE j.id=$1", {jobId});
    if (job.isNull()) return;
    auto channelId = job["channel_id"].asString(); auto presId = job["presentation_id"].asString();
    AuthService auth(db_,cfg_); ChannelAccess sys; sys.channelId=channelId; sys.userId=job["created_by"].asString();
    auto progress = [&](int done, int failed, int cached) { db_.exec("UPDATE tts_jobs SET done=$2, failed=$3, cached=$4, updated_at=now() WHERE id=$1", {jobId, (int64_t)done, (int64_t)failed, (int64_t)cached}); Json::Value p; p["job_id"] = jobId; p["presentation_id"] = presId; p["done"] = done; p["failed"] = failed; p["cached"] = cached; p["total"] = job["total"]; notifier_.studioEvent(channelId, "tts.progress", p, true); };
    try {
        sys=auth.channelAccess(sys.userId,channelId);
        Json::Value scoped = job["scope"]; scoped["event_ids"] = job["result"]["event_ids"];
        auto lines = plan(sys, presId, scoped, json::toBool(job["scope"], "force"), json::str(job["result"], "model_id"));
        std::atomic<int> done{0}, failed{0}, cached{0}; std::mutex emu; Json::Value errors(Json::arrayValue);
        std::vector<std::future<void>> inflight;
        auto work = [&](LinePlan l) {
            for (int attempt = 0; attempt < 3; ++attempt) {
                if (db_.queryOne("SELECT status FROM tts_jobs WHERE id=$1", {jobId})["status"].asString() == "cancelled") return;
                std::string err; bool retry = false; bool wasCached = !db_.queryOne("SELECT 1 AS x FROM tts_audio_assets WHERE cache_key=$1", {l.cacheKey}).isNull();
                auto id = synthesizeLine(channelId, l, sys.userId, err, retry);
                if (!id.empty()) {
                    if (db_.queryOne("SELECT status FROM tts_jobs WHERE id=$1",{jobId})["status"] == "cancelled") return;
                    auto latest=plan(sys,presId,scoped,true,json::str(job["result"],"model_id"));
                    auto match=std::find_if(latest.begin(),latest.end(),[&](const auto& current){return current.eventId==l.eventId&&current.cacheKey==l.cacheKey;});
                    if(match==latest.end()) { failed++; progress(done,failed,cached); return; }
                    auto dur = db_.queryOne("SELECT duration_ms FROM tts_audio_assets WHERE id=$1", {id});
                    db_.exec("UPDATE presentation_events SET audio_asset_id=$2, actual_audio_duration_ms=$3, updated_at=now() WHERE id=$1", {l.eventId, id, dur["duration_ms"].isNull() ? dbNull() : DbParam((int64_t)dur["duration_ms"].asInt())});
                    if (wasCached) cached++; done++; progress(done, failed, cached); return;
                }
                if (!retry) { std::lock_guard<std::mutex> g(emu); Json::Value e; e["event_id"] = l.eventId; e["error"] = err; errors.append(e); failed++; progress(done, failed, cached); return; }
                std::this_thread::sleep_for(std::chrono::milliseconds(800 * (1 << attempt)));
                if (attempt == 2) { std::lock_guard<std::mutex> g(emu); Json::Value e; e["event_id"] = l.eventId; e["error"] = err + " (after retries)"; errors.append(e); failed++; progress(done, failed, cached); }
            }
        };
        for (auto& l : lines) {
            if (!running_ && !db_.queryOne("SELECT 1 AS x FROM tts_jobs WHERE id=$1 AND status='running'", {jobId}).isNull()) {}
            inflight.push_back(std::async(std::launch::async, work, l));
            if ((int)inflight.size() >= concurrency_) { for (auto& f : inflight) f.get(); inflight.clear(); }
        }
        for (auto& f : inflight) f.get();
        auto st = db_.queryOne("SELECT status FROM tts_jobs WHERE id=$1", {jobId})["status"].asString();
        Json::Value result = job["result"]; result["errors"] = errors;
        db_.exec("UPDATE tts_jobs SET status=$2, result=$3::jsonb, finished_at=now(), updated_at=now() WHERE id=$1", {jobId, st == "cancelled" ? "cancelled" : (failed > 0 ? "failed" : "completed"), json::dump(result)});
        db_.exec("UPDATE log_presentations SET version=version+1, updated_at=now() WHERE id=$1", {presId});
        Json::Value p; p["job_id"] = jobId; p["presentation_id"] = presId; p["status"] = st == "cancelled" ? "cancelled" : failed > 0 ? "failed" : "completed"; p["done"] = done.load(); p["failed"] = failed.load(); p["cached"] = cached.load(); notifier_.studioEvent(channelId, "tts.finished", p, true);
    } catch (const std::exception& e) {
        ALOG_ERROR << "tts job " << jobId << " failed: " << e.what();
        bool again = job["attempts"].asInt() < job["max_attempts"].asInt();
        db_.exec("UPDATE tts_jobs SET status=$2, error=$3, updated_at=now(), finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1 AND status<>'cancelled'", {jobId, again ? "pending" : "failed", std::string(e.what())});
    }
}

} // namespace
