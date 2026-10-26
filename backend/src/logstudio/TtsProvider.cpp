#include "TtsProvider.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include <curl/curl.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cctype>

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
};

// ---- Qwen (Alibaba Cloud Model Studio / DashScope) provider ---------------------------------------
// Qwen-Audio 3.1 non-streaming HTTP contract verified against official documentation on 2026-10-26.
// Use a workspace-specific regional API base; a real account/key is still required for live verification.
static size_t wcb(char* p, size_t s, size_t n, void* u) { auto& out=*static_cast<std::string*>(u); if(s*n>50*1024*1024-out.size()) return 0; out.append(p, s*n); return s*n; }
class QwenTtsProvider : public TtsProvider {
public:
    QwenTtsProvider(const Json::Value& config) {
        apiKey_ = json::str(config,"api_key",env("QWEN_API_KEY", "")); base_ = json::str(config,"api_base",env("QWEN_API_BASE", "https://dashscope.aliyuncs.com")); if (!base_.empty() && base_.back() == '/') base_.pop_back();
        official_ = json::str(config,"model",env("QWEN_TTS_MODEL_OFFICIAL", "qwen-audio-3.1-tts-plus")); preview_ = env("QWEN_TTS_MODEL_PREVIEW", "qwen-audio-3.1-tts-flash");
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
        if (st == 429 || st >= 500) { r.error = "qwen http " + std::to_string(st) + ": " + resp.substr(0, 300); r.retryable = true; return r; }
        if (st < 200 || st >= 300) { r.error = "qwen http " + std::to_string(st) + ": " + resp.substr(0, 300); return r; }
        Json::Value j; try { j = json::parse(resp); } catch (...) { r.error = "qwen: unparseable response"; return r; }
        r.providerMeta["request_id"] = j["request_id"]; r.providerMeta["usage"] = j["usage"];
        const auto& audio = j["output"]["audio"];
        std::string url = json::str(audio, "url"), data = json::str(audio, "data");
        if (!data.empty()) { r.audioBytes = base64Decode(data); }
        else if (!url.empty()) {
            // Vendor URLs are temporary (hours). Download now; never persist the URL as the asset location.
            long dst = 0; std::string derr; r.audioBytes = getUrl(url, dst, derr);
            if (!derr.empty() || dst < 200 || dst >= 300) { r.error = "failed to download audio from vendor url (" + std::to_string(dst) + " " + derr + ")"; r.retryable = true; return r; }
        } else { r.error = "qwen: no audio in response: " + resp.substr(0, 300); return r; }
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
        if (!err.empty() || st < 200 || st >= 300) { r.error = "voice " + req.kind + " failed: http " + std::to_string(st) + " " + err + " " + resp.substr(0, 300); return r; }
        try { auto j = json::parse(resp); r.voiceId = json::str(j["output"], "voice"); if (r.voiceId.empty()) r.voiceId = json::str(j["output"], "voice_id"); r.providerMeta = j["output"]; r.providerMeta["request_id"] = j["request_id"]; } catch (...) {}
        if (r.voiceId.empty()) { r.error = "voice " + req.kind + ": no voice id in response: " + resp.substr(0, 300); return r; }
        r.ok = true; return r;
    }
    double estimateSynthesisCost(const std::string&, int chars) override { return pricePer10k_ * chars / 10000.0; }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = "only if returned by the API (not assumed)"; c["voice_design"] = true; c["voice_clone"] = true; c["phoneme_hints"] = true; c["api_base"] = base_; c["synth_endpoint"] = synthPath_; c["enroll_endpoint"] = enrollPath_; c["instruction_field"] = instructionField_; c["note"] = "Qwen-Audio 3.1 HTTP contract checked 2026-10-26; preset availability depends on model and region. Live account validation still required."; return c; }
private:
    std::string post(const std::string& path, const std::string& body, long& st, std::string& err) {
        CURL* c = curl_easy_init(); std::string out; struct curl_slist* h = nullptr;
        h = curl_slist_append(h, "Content-Type: application/json"); h = curl_slist_append(h, ("Authorization: Bearer " + apiKey_).c_str());
        curl_easy_setopt(c, CURLOPT_URL, (base_ + path).c_str()); curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str()); curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
        curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb); curl_easy_setopt(c, CURLOPT_WRITEDATA, &out); curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeoutMs_);
        auto rc = curl_easy_perform(c); if (rc != CURLE_OK) err = curl_easy_strerror(rc); curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &st); curl_slist_free_all(h); curl_easy_cleanup(c); return out;
    }
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

std::unique_ptr<TtsProvider> makeTtsProvider(const Json::Value& overrides) {
    auto mode = env("TTS_PROVIDER", "auto"); bool haveKey = !json::str(overrides,"api_key",env("QWEN_API_KEY", "")).empty();
    if (!overrides.isNull() || mode == "qwen" || (mode == "auto" && haveKey)) { if (!haveKey) ALOG_WARN << "TTS_PROVIDER=qwen but QWEN_API_KEY is empty"; ALOG_INFO << "TTS provider: qwen"; return std::make_unique<QwenTtsProvider>(overrides); }
    ALOG_INFO << "TTS provider: MOCK (no QWEN_API_KEY)"; return std::make_unique<MockTtsProvider>();
}

} // namespace
