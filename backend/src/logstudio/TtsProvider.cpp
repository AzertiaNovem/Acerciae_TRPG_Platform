#include "TtsProvider.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include <curl/curl.h>
#include "../core/NetGuard.h"
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <map>

namespace acerciae::logstudio {

static std::string env(const char* k, const char* d) { const char* v = std::getenv(k); return (v && *v) ? std::string(v) : std::string(d); }

std::string makeWav(const std::vector<int16_t>& s, int rate) {
    std::string out; auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) out += (char)((v >> (8 * i)) & 0xFF); }; auto u16 = [&](uint16_t v) { out += (char)(v & 0xFF); out += (char)(v >> 8); };
    uint32_t dataBytes = (uint32_t)s.size() * 2;
    out += "RIFF"; u32(36 + dataBytes); out += "WAVE"; out += "fmt "; u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16); out += "data"; u32(dataBytes);
    for (int16_t v : s) u16((uint16_t)v);
    return out;
}
int wavDurationMs(const std::string& b) {
    if (b.size() < 44 || b.compare(0, 4, "RIFF") != 0 || b.compare(8, 4, "WAVE") != 0) return 0;
    uint32_t byteRate = 0; size_t i = 12;
    while (i + 8 <= b.size()) {
        std::string id = b.substr(i, 4); uint32_t len = (unsigned char)b[i+4] | ((unsigned char)b[i+5] << 8) | ((unsigned char)b[i+6] << 16) | ((unsigned char)b[i+7] << 24);
        if(len>b.size()-i-8) return 0;
        if (id == "fmt " && i + 20 <= b.size()) byteRate = (unsigned char)b[i+16] | ((unsigned char)b[i+17] << 8) | ((unsigned char)b[i+18] << 16) | ((unsigned char)b[i+19] << 24);
        if (id == "data") return byteRate ? (int)((double)len * 1000.0 / byteRate) : 0;
        i += 8 + len + (len & 1);
    }
    return 0;
}

namespace {
Json::Value param(const char* key, const char* label, double min, double max, double step, double def) {
    Json::Value p; p["key"] = key; p["label"] = label; p["min"] = min; p["max"] = max; p["step"] = step; p["default"] = def; return p;
}
Json::Value languages(std::initializer_list<std::pair<const char*, const char*>> l) {
    Json::Value v(Json::arrayValue); for (auto& [id, label] : l) { Json::Value x; x["id"] = id; x["label"] = label; v.append(x); } return v;
}
Json::Value strings(std::initializer_list<const char*> l) { Json::Value v(Json::arrayValue); for (auto* s : l) v.append(s); return v; }
}
Json::Value sanitizeSynthesisParameters(const Json::Value& features, const Json::Value& params) {
    Json::Value out(Json::objectValue);
    if (!params.isObject()) return out;
    for (const auto& p : features["params"]) {
        auto key = p["key"].asString();
        if (!params[key].isNumeric()) continue;
        out[key] = std::min(p["max"].asDouble(), std::max(p["min"].asDouble(), params[key].asDouble()));
    }
    return out;
}

// ---- Mock provider: real, playable WAV that is unmistakably synthetic (tone sequence), labelled mock ----
class MockTtsProvider : public TtsProvider {
public:
    std::string name() const override { return "mock"; }
    bool isMock() const override { return true; }
    std::string officialModel() const override { return "mock-tts-official"; }
    std::string previewModel() const override { return "mock-tts-flash"; }
    TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) override {
        TtsSynthesisResult r; r.ok = true; r.mime = "audio/wav";
        int rate = 16000; size_t n = text::words(req.text).size() + req.text.size() / 3; double sec = std::min(14.0, std::max(0.6, 0.11 * (double)std::max<size_t>(n, 1)));
        if (req.parameters.isMember("speed") && req.parameters["speed"].isNumeric() && req.parameters["speed"].asDouble() > 0) sec /= req.parameters["speed"].asDouble();
        // base pitch from voice id so different voices are audibly different; instruction nudges tempo
        unsigned h = 0; for (char c : req.voiceId) h = h * 31 + (unsigned char)c; double base = 180 + (h % 7) * 35;
        double tempo = req.instruction.find("slow") != std::string::npos || req.instruction.find("慢") != std::string::npos ? 1.3 : (req.instruction.find("fast") != std::string::npos ? 0.8 : 1.0);
        std::vector<int16_t> s; s.reserve((size_t)(rate * sec));
        for (size_t i = 0; i < (size_t)(rate * sec); ++i) { double t = (double)i / rate; int syl = (int)(t / (0.18 * tempo)); double f = base * (1 + 0.12 * ((syl * 7 + (int)req.text.size()) % 5 - 2) / 5.0); double envl = 0.5 * (1 - std::cos(2 * M_PI * std::fmod(t, 0.18 * tempo) / (0.18 * tempo))); s.push_back((int16_t)(3000 * envl * std::sin(2 * M_PI * f * t))); }
        r.audioBytes = makeWav(s, rate); r.durationMs = (int)(sec * 1000);
        r.providerMeta["mock"] = true; r.providerMeta["note"] = "MOCK TTS: synthetic tone, not speech. Configure QWEN_API_KEY for real synthesis.";
        return r;
    }
    std::vector<TtsVoice> listAvailableVoices() override {
        return { {"mock-cherry", "Cherry (mock)", "zh", "female", "placeholder preset"}, {"mock-ethan", "Ethan (mock)", "en", "male", "placeholder preset"}, {"mock-serena", "Serena (mock)", "zh", "female", "placeholder preset"}, {"mock-dylan", "Dylan (mock, Beijing dialect)", "zh-dialect", "male", "placeholder preset"} };
    }
    VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest& req) override {
        VoiceProfileCreateResult r; r.ok = true; r.voiceId = "mock-" + req.kind + "-" + std::to_string(std::hash<std::string>{}(req.designPrompt + req.preferredName + std::to_string(req.referenceAudio.size())) % 100000);
        r.providerMeta["mock"] = true; return r;
    }
    double estimateSynthesisCost(const std::string&, int) override { return 0.0; }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = false; c["voice_design"] = true; c["voice_clone"] = true; c["phoneme_hints"] = false; c["note"] = "mock provider: generates tone WAVs; no external calls"; return c; }
    Json::Value features() const override {
        Json::Value f; f["label"] = "Mock"; f["voice_design"] = true; f["voice_clone"] = true;
        f["languages"] = languages({{"zh", "Mandarin"}, {"en", "English"}, {"auto", "Auto (mixed)"}}); f["language_note"] = "";
        f["dialect"] = Json::Value(); f["instructions"] = true; f["instruction_note"] = "Slow/fast in an instruction changes the tone tempo.";
        f["params"].append(param("speed", "Speed", 0.5, 2, 0.1, 1)); f["phoneme_dictionary"] = false; f["models"] = Json::Value(Json::arrayValue);
        f["highlights"] = strings({"Synthetic tones for trying every flow without a provider"}); return f;
    }
};

// ---- Qwen (Alibaba Cloud Model Studio / DashScope) provider ---------------------------------------
// Qwen-Audio 3.1 non-streaming HTTP contract verified against official documentation on 2026-10-26.
// Use a workspace-specific regional API base; a real account/key is still required for live verification.
static size_t wcb(char* p, size_t s, size_t n, void* u) { auto& out=*static_cast<std::string*>(u); if(s*n>50*1024*1024-out.size()) return 0; out.append(p, s*n); return s*n; }
// JSON POST with a bearer key to a pinned (SSRF-checked) address; the body is returned whatever the status.
static std::string postJson(const std::string& url, const std::string& apiKey, const std::string& body, long timeoutMs, long& st, std::string& err) {
    std::unique_ptr<net::PinnedRequest> pinned;
    try { pinned = std::make_unique<net::PinnedRequest>(url); } catch (const std::exception& e) { err = e.what(); st = 0; return ""; }
    CURL* c = curl_easy_init(); std::string out; struct curl_slist* h = nullptr;
    h = curl_slist_append(h, "Content-Type: application/json"); h = curl_slist_append(h, ("Authorization: Bearer " + apiKey).c_str());
    pinned->apply(c, 50u * 1024 * 1024); curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str()); curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb); curl_easy_setopt(c, CURLOPT_WRITEDATA, &out); curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeoutMs);
    auto rc = curl_easy_perform(c); if (rc != CURLE_OK) err = curl_easy_strerror(rc); curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &st); curl_slist_free_all(h); curl_easy_cleanup(c); return out;
}
class QwenTtsProvider : public TtsProvider {
public:
    QwenTtsProvider(const Json::Value& config) {
        // Key, API base and model come from the server's settings; the remaining protocol details have operator overrides.
        apiKey_ = json::str(config, "api_key", ""); base_ = json::str(config, "api_base", ""); if (base_.empty()) base_ = "https://dashscope.aliyuncs.com";
        while (!base_.empty() && base_.back() == '/') base_.pop_back();
        official_ = json::str(config, "model", ""); if (official_.empty()) official_ = "qwen-audio-3.1-tts-plus";
        preview_ = env("QWEN_TTS_MODEL_PREVIEW", "qwen-audio-3.1-tts-flash");
        synthPath_ = env("QWEN_TTS_ENDPOINT", "/api/v1/services/audio/tts/SpeechSynthesizer");
        enrollPath_ = env("QWEN_VOICE_ENROLL_ENDPOINT", "/api/v1/services/audio/tts/customization"); enrollModel_ = env("QWEN_VOICE_ENROLL_MODEL", "voice-enrollment"); designModel_ = env("QWEN_VOICE_DESIGN_MODEL", "voice-enrollment");
        instructionField_ = env("QWEN_TTS_INSTRUCTION_FIELD", "instruction"); pricePer10k_ = std::atof(env("TTS_PRICE_PER_10K_CHARS", "0").c_str()); timeoutMs_ = std::atol(env("QWEN_TIMEOUT_MS", "60000").c_str());
    }
    bool supportsPhonemeHints() const override { return true; }
    std::string name() const override { return "qwen"; }
    std::string cacheNamespace() const override { return "qwen:" + crypto::sha256Hex(base_+apiKey_); }
    bool isMock() const override { return false; }
    std::string officialModel() const override { return official_; }
    std::string previewModel() const override { return preview_; }
    TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) override {
        TtsSynthesisResult r;
        Json::Value body; body["model"] = req.modelId.empty() ? official_ : req.modelId;
        body["input"]["text"] = req.text; body["input"]["voice"] = req.voiceId;
        if (!req.language.empty() && req.language != "auto") body["input"]["language_hints"].append(req.language=="zh-dialect"?"zh":req.language);
        if (!req.instruction.empty()) body["input"][instructionField_] = req.instruction;
        for (const auto& key : {"sample_rate", "volume", "rate", "pitch", "seed", "hot_fix"}) if (req.parameters.isMember(key)) body["input"][key] = req.parameters[key];
        if (req.parameters.isMember("speed")) body["input"]["rate"] = req.parameters["speed"];
        body["input"]["format"] = "wav"; // bounded, measurable audio; no invented MP3 duration
        long st = 0; std::string err; auto resp = post(synthPath_, json::dump(body), st, err);
        if (!err.empty()) { r.error = "transport: " + err; r.retryable = true; return r; }
        if (st < 200 || st >= 300) {
            ALOG_WARN << "Qwen speech HTTP " << st << ": " << resp.substr(0, 300);
            r.error = "the speech provider returned HTTP " + std::to_string(st); r.retryable = st == 429 || st >= 500; return r;
        }
        Json::Value j; try { j = json::parse(resp); } catch (...) { r.error = "qwen: unparseable response"; return r; }
        r.providerMeta["request_id"] = j["request_id"]; r.providerMeta["usage"] = j["usage"];
        const auto& audio = j["output"]["audio"];
        std::string url = json::str(audio, "url"), data = json::str(audio, "data");
        if (!data.empty()) { r.audioBytes = base64Decode(data); }
        else if (!url.empty()) {
            // Vendor URLs are temporary (hours). Download now; never persist the URL as the asset location.
            long dst = 0; std::string derr; r.audioBytes = getUrl(url, dst, derr);
            if (!derr.empty() || dst < 200 || dst >= 300) { r.error = "failed to download audio from vendor url (" + std::to_string(dst) + " " + derr + ")"; r.retryable = true; return r; }
        } else { ALOG_WARN << "Qwen speech without audio: " << resp.substr(0, 300); r.error = "the speech provider returned no audio"; return r; }
        if (r.audioBytes.size() < 44 || wavDurationMs(r.audioBytes) <= 0) { r.error = "provider returned invalid or empty WAV audio"; return r; }
        r.mime = r.audioBytes.compare(0, 4, "RIFF") == 0 ? "audio/wav" : (r.audioBytes.compare(0, 3, "ID3") == 0 || ((unsigned char)r.audioBytes[0] == 0xFF)) ? "audio/mpeg" : "audio/wav";
        r.durationMs = r.mime == "audio/wav" ? wavDurationMs(r.audioBytes) : 0;
        if (j["output"].isMember("timestamps") && j["output"]["timestamps"].isArray()) r.wordTimestamps = j["output"]["timestamps"];   // only when the API really returns them
        r.ok = true; return r;
    }
    std::vector<TtsVoice> listAvailableVoices() override {
        // Qwen TTS presets are documented, not listable through an API; the list is configurable via QWEN_TTS_VOICES="id:name:lang,…".
        std::vector<TtsVoice> v; auto conf = env("QWEN_TTS_VOICES", "longanhuan_v3.1:Anhuan:zh:female,longanlingxin_v3.1:Lingxin:zh:female,xunanchuan_v3.1:Nanchuan:zh:male,longanfengyue_v3.1:Fengyue:zh:female");
        std::string cur; std::vector<std::string> parts; for (char c : conf) { if (c == ',') { parts.push_back(cur); cur.clear(); } else cur += c; } parts.push_back(cur);
        for (auto& p : parts) { std::vector<std::string> f; std::string x; for (char c : p) { if (c == ':') { f.push_back(x); x.clear(); } else x += c; } f.push_back(x); if (f.size() >= 2) v.push_back({f[0], f[1], f.size() > 2 ? f[2] : "zh", f.size() > 3 ? f[3] : "", "Qwen preset"}); }
        return v;
    }
    VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest& req) override {
        VoiceProfileCreateResult r;
        Json::Value body; body["model"] = req.kind == "design" ? designModel_ : enrollModel_;
        body["input"]["action"] = "create_voice"; body["input"]["target_model"] = req.targetModel.empty() ? official_ : req.targetModel;
        std::string prefix; for (unsigned char c : req.preferredName) if (c < 128 && std::isalnum(c) && prefix.size() < 10) prefix += c;
        body["input"]["prefix"] = prefix.empty() ? "acerciae" : prefix;
        if (req.kind == "design") { body["input"]["voice_prompt"] = req.designPrompt; body["input"]["preview_text"] = req.language == "en" ? "Welcome to this reading of our campaign journal." : "欢迎收听我们的跑团记录，这是角色声音的试听片段。"; }
        else body["input"]["audio"] = "data:" + req.referenceMime + ";base64," + base64Encode(req.referenceAudio);
        if (!req.language.empty()) body["input"]["language_hints"].append(req.language=="zh-dialect"?"zh":req.language);
        long st = 0; std::string err; auto resp = post(enrollPath_, json::dump(body), st, err);
        if (!err.empty() || st < 200 || st >= 300) { ALOG_WARN << "Qwen voice " << req.kind << " HTTP " << st << " " << err << ": " << resp.substr(0, 300); r.error = "voice " + req.kind + " failed" + (err.empty() ? " (HTTP " + std::to_string(st) + ")" : ": " + err); return r; }
        try { auto j = json::parse(resp); r.voiceId = json::str(j["output"], "voice"); if (r.voiceId.empty()) r.voiceId = json::str(j["output"], "voice_id"); r.providerMeta = j["output"]; r.providerMeta["request_id"] = j["request_id"]; } catch (...) {}
        if (r.voiceId.empty()) { ALOG_WARN << "Qwen voice " << req.kind << " without id: " << resp.substr(0, 300); r.error = "voice " + req.kind + ": the provider returned no voice id"; return r; }
        r.ok = true; return r;
    }
    double estimateSynthesisCost(const std::string&, int chars) override { return pricePer10k_ * chars / 10000.0; }
    Json::Value features() const override {
        Json::Value f; f["label"] = "Qwen"; f["voice_design"] = true; f["voice_clone"] = true;
        f["languages"] = languages({{"zh", "Mandarin"}, {"en", "English"}, {"auto", "Auto (mixed)"}, {"zh-dialect", "Chinese dialect"}});
        f["language_note"] = "Sent as a language hint.";
        Json::Value d; d["label"] = "Dialect"; d["placeholder"] = "e.g. Beijing, Sichuan, Cantonese"; f["dialect"] = d;
        f["instructions"] = true; f["instruction_note"] = "Identity and delivery are sent as the model's instruction.";
        f["params"].append(param("rate", "Rate", 0.5, 2, 0.05, 1)); f["params"].append(param("pitch", "Pitch", 0.5, 2, 0.05, 1)); f["params"].append(param("volume", "Volume", 0, 100, 1, 50));
        f["phoneme_dictionary"] = true; f["models"] = Json::Value(Json::arrayValue);
        f["highlights"] = strings({"Voice design from a description", "Voice cloning with recorded consent", "Language hints and Chinese dialects", "Rate, pitch and volume per voice", "Pinyin pronunciations"});
        return f;
    }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = "only if returned by the API (not assumed)"; c["voice_design"] = true; c["voice_clone"] = true; c["phoneme_hints"] = true; c["api_base"] = base_; c["synth_endpoint"] = synthPath_; c["enroll_endpoint"] = enrollPath_; c["instruction_field"] = instructionField_; c["note"] = "Qwen-Audio 3.1 HTTP contract checked 2026-10-26; preset availability depends on model and region. Live account validation still required."; return c; }
private:
    std::string post(const std::string& path, const std::string& body, long& st, std::string& err) { return postJson(base_ + path, apiKey_, body, timeoutMs_, st, err); }
    std::string getUrl(const std::string& url, long& st, std::string& err) {
        // SSRF guard: only follow https URLs on the vendor's result hosts.
        CURLU* parsed = curl_url(); char* host = nullptr; char* scheme = nullptr; char* user = nullptr;
        bool valid = curl_url_set(parsed, CURLUPART_URL, url.c_str(), 0) == CURLUE_OK && curl_url_get(parsed, CURLUPART_HOST, &host, 0) == CURLUE_OK && curl_url_get(parsed, CURLUPART_SCHEME, &scheme, 0) == CURLUE_OK;
        std::string h = host ? host : "", protocol = scheme ? scheme : "";
        auto suffix = [&](const std::string& end) { return h.size() > end.size() && h.compare(h.size()-end.size(), end.size(), end) == 0; };
        valid = valid && (protocol == "https" || protocol == "http") && (suffix(".aliyuncs.com") || suffix(".alicdn.com")) && curl_url_get(parsed, CURLUPART_USER, &user, 0) != CURLUE_OK;
        curl_free(host); curl_free(scheme); curl_free(user); curl_url_cleanup(parsed);
        if (!valid) { err = "refused non-vendor url"; st = 0; return ""; }
        std::string secureUrl = protocol == "http" ? "https" + url.substr(4) : url;
        CURL* c = curl_easy_init(); std::string out; curl_easy_setopt(c, CURLOPT_URL, secureUrl.c_str()); curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb); curl_easy_setopt(c, CURLOPT_WRITEDATA, &out); curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeoutMs_); curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L); curl_easy_setopt(c, CURLOPT_MAXFILESIZE_LARGE, (curl_off_t)(60LL * 1024 * 1024));
        auto rc = curl_easy_perform(c); if (rc != CURLE_OK) err = curl_easy_strerror(rc); curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &st); curl_easy_cleanup(c); return out;
    }
    static std::string base64Encode(const std::string& in) { static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string o; int val = 0, bits = -6; for (unsigned char c : in) { val = (val << 8) + c; bits += 8; while (bits >= 0) { o += t[(val >> bits) & 0x3F]; bits -= 6; } } if (bits > -6) o += t[((val << 8) >> (bits + 8)) & 0x3F]; while (o.size() % 4) o += '='; return o; }
    static std::string base64Decode(const std::string& in) { std::string o; std::vector<int> T(256, -1); for (int i = 0; i < 64; ++i) T["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[i]] = i; int val = 0, bits = -8; for (unsigned char c : in) { if (T[c] == -1) continue; val = (val << 6) + T[c]; bits += 6; if (bits >= 0) { o += (char)((val >> bits) & 0xFF); bits -= 8; } } return o; }
    std::string apiKey_, base_, official_, preview_, synthPath_, enrollPath_, enrollModel_, designModel_, instructionField_; double pricePer10k_ = 0; long timeoutMs_ = 60000;
};

// ---- OpenAI speech: POST {api_base}/audio/speech ---------------------------------------------------
// gpt-4o-mini-tts unless the server names another model with the same contract (a later gpt-*-tts, tts-1, tts-1-hd).
// The audio is requested as raw 24 kHz 16-bit mono PCM and wrapped as WAV here, so every clip has a measured duration.
// Preset voices only: the API has no voice design or cloning.
class OpenAiTtsProvider : public TtsProvider {
public:
    OpenAiTtsProvider(const Json::Value& config) {
        apiKey_ = json::str(config, "api_key", ""); base_ = json::str(config, "api_base", ""); if (base_.empty()) base_ = "https://api.openai.com/v1";
        while (!base_.empty() && base_.back() == '/') base_.pop_back();
        model_ = json::str(config, "model", ""); if (model_.empty()) model_ = "gpt-4o-mini-tts";
        voice_ = json::str(config, "voice", ""); if (voice_.empty()) voice_ = "alloy";
        pricePer10k_ = std::atof(env("TTS_PRICE_PER_10K_CHARS", "0").c_str()); timeoutMs_ = std::atol(env("OPENAI_TTS_TIMEOUT_MS", "60000").c_str());
    }
    std::string name() const override { return "openai"; }
    std::string cacheNamespace() const override { return "openai:" + crypto::sha256Hex(base_ + apiKey_); }
    bool isMock() const override { return false; }
    std::string officialModel() const override { return model_; }
    std::string previewModel() const override { return model_; }
    TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) override {
        TtsSynthesisResult r;
        int chars = 0; for (unsigned char c : req.text) if ((c & 0xc0) != 0x80) ++chars;
        if (chars > 4096) { r.error = "the line is longer than the 4096 characters OpenAI speech accepts"; return r; }
        Json::Value body; body["model"] = req.modelId.empty() ? model_ : req.modelId;
        body["input"] = req.text; body["voice"] = req.voiceId.empty() ? voice_ : req.voiceId; body["response_format"] = "pcm";
        // tts-1 and tts-1-hd ignore delivery instructions; the gpt-*-tts models take them.
        // The API has no language field: a chosen language is asked for in the instructions.
        static const std::map<std::string, std::string> spoken = {{"zh", "Mandarin Chinese"}, {"zh-dialect", "Chinese"}, {"en", "English"}, {"ja", "Japanese"}, {"ko", "Korean"}, {"es", "Spanish"}, {"fr", "French"}, {"de", "German"}, {"ru", "Russian"}, {"pt", "Portuguese"}, {"it", "Italian"}};
        auto lang = spoken.find(req.language);
        std::string instructions = lang == spoken.end() ? req.instruction : "Speak in " + lang->second + "." + (req.instruction.empty() ? "" : " " + req.instruction);
        if (!instructions.empty() && body["model"].asString().rfind("tts-1", 0) != 0) body["instructions"] = instructions;
        if (req.parameters.isMember("speed") && req.parameters["speed"].isNumeric()) body["speed"] = std::min(4.0, std::max(0.25, req.parameters["speed"].asDouble()));
        long st = 0; std::string err; auto resp = postJson(base_ + "/audio/speech", apiKey_, json::dump(body), timeoutMs_, st, err);
        if (!err.empty()) { r.error = "transport: " + err; r.retryable = true; return r; }
        if (st < 200 || st >= 300) {
            ALOG_WARN << "OpenAI speech HTTP " << st << ": " << resp.substr(0, 300);
            r.error = "the speech provider returned HTTP " + std::to_string(st); r.retryable = st == 429 || st >= 500; return r;
        }
        if (resp.size() < 2 || resp[0] == '{') { ALOG_WARN << "OpenAI speech without audio: " << resp.substr(0, 300); r.error = "the speech provider returned no audio"; return r; }
        std::vector<int16_t> samples(resp.size() / 2);
        for (size_t i = 0; i < samples.size(); ++i) samples[i] = (int16_t)((unsigned char)resp[2 * i] | ((unsigned char)resp[2 * i + 1] << 8));
        r.audioBytes = makeWav(samples, 24000); r.mime = "audio/wav"; r.durationMs = wavDurationMs(r.audioBytes);
        r.providerMeta["model"] = body["model"]; r.providerMeta["voice"] = body["voice"];
        r.ok = true; return r;
    }
    std::vector<TtsVoice> listAvailableVoices() override {
        // The API has no voice listing; OPENAI_TTS_VOICES="id,id,…" overrides the documented presets.
        std::vector<TtsVoice> v; std::string cur;
        auto add = [&] { if (!cur.empty()) { auto label = cur; label[0] = (char)std::toupper((unsigned char)label[0]); v.push_back({cur, label, "multi", "", "OpenAI preset"}); } cur.clear(); };
        for (char c : env("OPENAI_TTS_VOICES", "alloy,ash,ballad,coral,echo,fable,nova,onyx,sage,shimmer,verse,marin,cedar")) { if (c == ',') add(); else if (!std::isspace((unsigned char)c)) cur += c; }
        add(); return v;
    }
    VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest&) override {
        VoiceProfileCreateResult r; r.error = "OpenAI speech has preset voices only; voice design and cloning need the Qwen provider"; return r;
    }
    double estimateSynthesisCost(const std::string&, int chars) override { return pricePer10k_ * chars / 10000.0; }
    Json::Value features() const override {
        Json::Value f; f["label"] = "OpenAI"; f["voice_design"] = false; f["voice_clone"] = false;
        f["languages"] = languages({{"auto", "Follow the text"}, {"zh", "Mandarin Chinese"}, {"en", "English"}, {"ja", "Japanese"}, {"ko", "Korean"}, {"es", "Spanish"}, {"fr", "French"}, {"de", "German"}, {"ru", "Russian"}, {"pt", "Portuguese"}, {"it", "Italian"}});
        f["language_note"] = "Asked for in the instructions; the model reads the language from the text otherwise.";
        Json::Value d; d["label"] = "Accent"; d["placeholder"] = "e.g. soft Scottish, Boston, Taiwanese Mandarin"; f["dialect"] = d;
        f["instructions"] = true; f["instruction_note"] = "Free-form: tone, emotion, pacing, whispering, character. Ignored by tts-1 models.";
        f["params"].append(param("speed", "Speed", 0.25, 4, 0.05, 1)); f["phoneme_dictionary"] = false;
        Json::Value models(Json::arrayValue); models.append(model_); for (auto* m : {"gpt-4o-mini-tts", "tts-1-hd", "tts-1"}) if (model_ != m) models.append(m); f["models"] = models;
        f["highlights"] = strings({"13 preset voices", "Free-form delivery instructions", "Spoken language and accent", "Speed per voice", "Model per voice"});
        return f;
    }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = false; c["voice_design"] = false; c["voice_clone"] = false; c["phoneme_hints"] = false; c["instructions"] = model_.rfind("tts-1", 0) != 0; c["api_base"] = base_; c["model"] = model_; c["note"] = "OpenAI /audio/speech: preset voices, delivery instructions on gpt-*-tts models, 24 kHz PCM wrapped as WAV."; return c; }
private:
    std::string apiKey_, base_, model_, voice_; double pricePer10k_ = 0; long timeoutMs_ = 60000;
};

std::unique_ptr<TtsProvider> makeTtsProvider(const Json::Value& config) {
    if (json::str(config, "provider") == "qwen") return std::make_unique<QwenTtsProvider>(config);
    if (json::str(config, "provider") == "openai") return std::make_unique<OpenAiTtsProvider>(config);
    return std::make_unique<MockTtsProvider>();
}

} // namespace
