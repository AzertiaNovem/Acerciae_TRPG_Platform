// Speech providers beyond OpenAI-compatible and Qwen: Gemini (Interactions API), Amazon Polly, Volcano Engine Doubao
// speech. Each returns a WAV with a measured duration; preset voices only (no design or cloning).
#include "TtsProvider.h"
#include "../ai/AiHttp.h"
#include "../ai/AwsSigV4.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <drogon/utils/Utilities.h>
#include <atomic>
#include <chrono>

namespace acerciae::logstudio {
namespace http = ai::http;

namespace {
constexpr long kTimeoutMs = 90000;
std::vector<int16_t> pcm16(const std::string& bytes) {
    std::vector<int16_t> s(bytes.size() / 2);
    for (std::size_t i = 0; i < s.size(); ++i) s[i] = (int16_t)((unsigned char)bytes[2 * i] | ((unsigned char)bytes[2 * i + 1] << 8));
    return s;
}
TtsSynthesisResult wav(const std::string& pcm, int rate, const char* who) {
    TtsSynthesisResult r;
    if (pcm.size() < 2) { r.error = std::string(who) + " returned no audio"; return r; }
    r.audioBytes = makeWav(pcm16(pcm), rate); r.mime = "audio/wav"; r.durationMs = wavDurationMs(r.audioBytes); r.ok = true;
    return r;
}
TtsSynthesisResult httpFailure(const http::Result& res, const char* who) {
    TtsSynthesisResult r;
    if (!res.error.empty()) { r.error = "transport: " + res.error; r.retryable = true; return r; }
    ALOG_WARN << who << " speech HTTP " << res.status << ": " << llm::excerpt(res.body);
    r.error = "the speech provider returned HTTP " + std::to_string(res.status); r.retryable = res.status == 429 || res.status >= 500;
    return r;
}
int characters(const std::string& s) { int n = 0; for (unsigned char c : s) if ((c & 0xc0) != 0x80) ++n; return n; }
Json::Value strings(std::initializer_list<const char*> l) { Json::Value v(Json::arrayValue); for (auto* s : l) v.append(s); return v; }
Json::Value baseFeatures(const char* label, const std::string& model, std::initializer_list<const char*> models, std::initializer_list<const char*> highlights) {
    Json::Value f; f["label"] = label; f["voice_design"] = false; f["voice_clone"] = false;
    f["languages"] = Json::Value(Json::arrayValue); f["dialect"] = Json::Value(); f["instructions"] = false; f["params"] = Json::Value(Json::arrayValue);
    f["phoneme_dictionary"] = false;
    Json::Value m(Json::arrayValue); m.append(model); for (auto* x : models) if (model != x) m.append(x); f["models"] = m;
    f["highlights"] = strings(highlights);
    return f;
}
std::string requestId() {
    static std::atomic<unsigned> counter{0};
    auto h = crypto::sha256Hex(std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ":" + std::to_string(++counter));
    return h.substr(0, 8) + "-" + h.substr(8, 4) + "-4" + h.substr(13, 3) + "-a" + h.substr(17, 3) + "-" + h.substr(20, 12);
}

// ---- Gemini (Interactions API): raw 24 kHz PCM, 30 prebuilt voices, a delivery style per line ----
class GoogleTts final : public TtsProvider {
public:
    explicit GoogleTts(const Json::Value& c) : key_(json::str(c, "api_key")), base_(json::str(c, "api_base", "https://generativelanguage.googleapis.com/v1beta")),
        model_(json::str(c, "model", "gemini-3.8-flash-tts")), voice_(json::str(c, "voice", "Kore")) { if (voice_.empty()) voice_ = "Kore"; }
    std::string name() const override { return "google"; }
    std::string cacheNamespace() const override { return "google:" + crypto::sha256Hex(base_ + key_); }
    bool isMock() const override { return false; }
    std::string officialModel() const override { return model_; }
    std::string previewModel() const override { return model_; }
    TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) override {
        Json::Value body;
        body["model"] = req.modelId.empty() ? model_ : req.modelId; body["store"] = false;
        Json::Value text; text["type"] = "text"; text["text"] = req.text;
        if (!req.instruction.empty()) { Json::Value a; a["type"] = "speech_metadata"; a["style"] = req.instruction; text["annotations"].append(a); }
        Json::Value turn; turn["type"] = "user_input"; turn["content"].append(text);
        body["input"].append(turn);
        body["response_format"]["type"] = "audio"; body["response_format"]["mime_type"] = "audio/l16"; body["response_format"]["sample_rate"] = 24000;
        Json::Value voice; voice["voice"] = req.voiceId.empty() ? voice_ : req.voiceId;
        body["generation_config"]["speech_config"].append(voice);
        auto res = http::postOnce(http::joinUrl(base_, "/interactions"), {"Content-Type: application/json", "x-goog-api-key: " + key_}, json::dump(body), kTimeoutMs);
        if (!res.error.empty() || res.status < 200 || res.status >= 300) return httpFailure(res, "Gemini");
        try {
            auto j = json::parse(res.body);
            std::string data, mime; int rate = 24000;
            for (const auto& step : j["steps"]) for (const auto& b : step["content"]) if (b["type"] == "audio" && b["data"].isString()) { data += b["data"].asString(); mime = b["mime_type"].asString(); if (b["sample_rate"].isInt()) rate = b["sample_rate"].asInt(); }
            auto bytes = drogon::utils::base64Decode(data);
            if (mime.rfind("audio/wav", 0) == 0 && wavDurationMs(bytes) > 0) { TtsSynthesisResult r; r.audioBytes = bytes; r.mime = "audio/wav"; r.durationMs = wavDurationMs(bytes); r.ok = true; return r; }
            auto r = wav(bytes, rate, "Gemini"); r.providerMeta["model"] = body["model"]; r.providerMeta["voice"] = voice["voice"]; return r;
        } catch (const std::exception& e) { TtsSynthesisResult r; r.error = std::string("invalid Gemini speech response: ") + e.what(); return r; }
    }
    std::vector<TtsVoice> listAvailableVoices() override {
        std::vector<TtsVoice> v;
        for (auto* id : {"Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina",
                         "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix",
                         "Sadachbia", "Sadaltager", "Sulafat"}) v.push_back({id, id, "multi", "", "Gemini prebuilt voice"});
        return v;
    }
    VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest&) override { VoiceProfileCreateResult r; r.error = "Gemini speech has prebuilt voices only here"; return r; }
    double estimateSynthesisCost(const std::string&, int) override { return 0; }
    Json::Value features() const override {
        auto f = baseFeatures("Gemini", model_, {"gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"}, {"30 prebuilt voices", "Delivery style per line", "Many languages, read from the text"});
        f["instructions"] = true; f["instruction_note"] = "A delivery style: tone, emotion, pacing.";
        return f;
    }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = false; c["voice_design"] = false; c["voice_clone"] = false; c["phoneme_hints"] = false; c["instructions"] = true; c["model"] = model_; c["note"] = "Gemini Interactions API speech: 24 kHz PCM wrapped as WAV."; return c; }
private:
    std::string key_, base_, model_, voice_;
};

// ---- Amazon Polly (SigV4): 16 kHz PCM; the model is the engine ----
class PollyTts final : public TtsProvider {
public:
    explicit PollyTts(const Json::Value& c) {
        const auto& o = c["options"];
        region_ = json::str(o, "region", "us-east-1");
        endpoint_ = json::str(o, "polly_endpoint", "https://polly." + region_ + ".amazonaws.com");
        creds_ = {json::str(o, "access_key_id"), json::str(c, "api_key"), json::str(c["secrets"], "session_token"), region_};
        engine_ = json::str(c, "model", "neural"); voice_ = json::str(c, "voice", "Joanna"); if (voice_.empty()) voice_ = "Joanna";
    }
    std::string name() const override { return "aws"; }
    std::string cacheNamespace() const override { return "aws:" + crypto::sha256Hex(endpoint_ + creds_.accessKeyId); }
    bool isMock() const override { return false; }
    std::string officialModel() const override { return engine_; }
    std::string previewModel() const override { return engine_; }
    TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) override {
        if (characters(req.text) > 3000) { TtsSynthesisResult r; r.error = "the line is longer than the 3000 characters Polly accepts"; return r; }
        Json::Value body;
        body["Text"] = req.text; body["TextType"] = "text"; body["OutputFormat"] = "pcm"; body["SampleRate"] = "16000";
        body["VoiceId"] = req.voiceId.empty() ? voice_ : req.voiceId; body["Engine"] = req.modelId.empty() ? engine_ : req.modelId;
        auto payload = json::dump(body);
        auto res = call("POST", "/v1/speech", "", payload);
        if (!res.error.empty() || res.status < 200 || res.status >= 300) return httpFailure(res, "Polly");
        if (!res.body.empty() && res.body[0] == '{') { TtsSynthesisResult r; r.error = "Polly returned no audio"; return r; }
        auto r = wav(res.body, 16000, "Polly"); r.providerMeta["engine"] = body["Engine"]; r.providerMeta["voice"] = body["VoiceId"]; return r;
    }
    std::vector<TtsVoice> listAvailableVoices() override {
        std::vector<TtsVoice> v;
        auto res = call("GET", "/v1/voices", "Engine=" + ai::aws::uriEncode(engine_), "");
        if (res.error.empty() && res.status == 200) {
            try { for (const auto& x : json::parse(res.body)["Voices"]) v.push_back({x["Id"].asString(), x["Name"].asString(), x["LanguageCode"].asString(), x["Gender"].asString(), x["LanguageName"].asString()}); } catch (...) {}
        }
        if (v.empty()) for (auto* id : {"Joanna", "Matthew", "Ruth", "Stephen", "Amy", "Brian", "Zhiyu", "Takumi", "Kazuha", "Seoyeon", "Lucia", "Lea", "Vicki"}) v.push_back({id, id, "", "", "Polly voice"});
        return v;
    }
    VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest&) override { VoiceProfileCreateResult r; r.error = "Polly has preset voices only"; return r; }
    double estimateSynthesisCost(const std::string&, int) override { return 0; }
    Json::Value features() const override { return baseFeatures("Amazon Polly", engine_, {"neural", "generative", "long-form", "standard"}, {"Polly voices per engine", "Engine per voice"}); }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = false; c["voice_design"] = false; c["voice_clone"] = false; c["phoneme_hints"] = false; c["model"] = engine_; c["note"] = "Amazon Polly SynthesizeSpeech: 16 kHz PCM wrapped as WAV; the model is the engine."; return c; }
private:
    http::Result call(const std::string& method, const std::string& path, const std::string& query, const std::string& body) {
        ai::aws::Request req; req.method = method; req.host = http::hostOf(endpoint_); req.path = path; req.query = query; req.body = body;
        if (method == "POST") req.headers = {{"content-type", "application/json"}};
        auto headers = ai::aws::sign(req, creds_, "polly");
        auto url = http::joinUrl(endpoint_, path) + (query.empty() ? "" : "?" + query);
        return method == "POST" ? http::postOnce(url, headers, body, kTimeoutMs, 40u * 1024 * 1024) : http::get(url, headers, 20000, 2u * 1024 * 1024);
    }
    std::string region_, endpoint_, engine_, voice_;
    ai::aws::Credentials creds_;
};

// ---- Volcano Engine Doubao speech, V3 one-way stream: base64 PCM chunks in back-to-back JSON objects ----
std::vector<Json::Value> jsonObjects(const std::string& body) {
    std::vector<Json::Value> out; int depth = 0; bool inString = false, escaped = false; std::size_t start = 0;
    for (std::size_t i = 0; i < body.size(); ++i) {
        char c = body[i];
        if (inString) { if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') inString = false; continue; }
        if (c == '"') inString = true;
        else if (c == '{') { if (depth++ == 0) start = i; }
        else if (c == '}' && depth > 0 && --depth == 0) out.push_back(json::parse(body.substr(start, i - start + 1)));
    }
    return out;
}
class VolcengineTts final : public TtsProvider {
public:
    explicit VolcengineTts(const Json::Value& c) {
        const auto& o = c["options"]; const auto& s = c["secrets"];
        endpoint_ = json::str(o, "speech_endpoint", "https://openspeech.bytedance.com");
        apiKey_ = json::str(s, "speech_api_key"); appId_ = json::str(o, "speech_app_id"); token_ = json::str(s, "speech_access_token");
        resource_ = json::str(c, "model", json::str(o, "speech_resource_id", "seed-tts-2.0")); if (resource_.empty()) resource_ = "seed-tts-2.0";
        voice_ = json::str(c, "voice", "zh_female_vv_uranus_bigtts"); if (voice_.empty()) voice_ = "zh_female_vv_uranus_bigtts";
    }
    std::string name() const override { return "volcengine"; }
    std::string cacheNamespace() const override { return "volcengine:" + crypto::sha256Hex(endpoint_ + apiKey_ + appId_); }
    bool isMock() const override { return false; }
    std::string officialModel() const override { return resource_; }
    std::string previewModel() const override { return resource_; }
    TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) override {
        TtsSynthesisResult r;
        if (apiKey_.empty() && (appId_.empty() || token_.empty())) { r.error = "Doubao speech needs the speech API key, or the speech app ID and access token (Server settings → AI)"; return r; }
        Json::Value body;
        body["user"]["uid"] = "acerciae";
        body["req_params"]["text"] = req.text;
        body["req_params"]["speaker"] = req.voiceId.empty() ? voice_ : req.voiceId;
        body["req_params"]["audio_params"]["format"] = "pcm"; body["req_params"]["audio_params"]["sample_rate"] = 24000;
        if (req.parameters.isMember("speech_rate") && req.parameters["speech_rate"].isNumeric()) body["req_params"]["audio_params"]["speech_rate"] = req.parameters["speech_rate"].asInt();
        std::vector<std::string> headers = {"Content-Type: application/json", "X-Api-Resource-Id: " + (req.modelId.empty() ? resource_ : req.modelId), "X-Api-Request-Id: " + requestId()};
        if (!apiKey_.empty()) headers.push_back("X-Api-Key: " + apiKey_);
        else { headers.push_back("X-Api-App-Id: " + appId_); headers.push_back("X-Api-Access-Key: " + token_); }
        auto res = http::postOnce(http::joinUrl(endpoint_, "/api/v3/tts/unidirectional"), headers, json::dump(body), kTimeoutMs, 60u * 1024 * 1024);
        if (!res.error.empty() || res.status < 200 || res.status >= 300) return httpFailure(res, "Doubao");
        std::string pcm; bool finished = false;
        try {
            for (const auto& o : jsonObjects(res.body)) {
                auto code = o["code"].asInt64();
                if (code == 20000000) { finished = true; break; }
                if (code != 0) {
                    ALOG_WARN << "Doubao speech error " << code << ": " << o["message"].asString();
                    r.error = code == 40402003 ? "the line is too long for Doubao speech" : code == 45000000 ? "Doubao speech refused the voice or the request rate" : "Doubao speech failed (" + std::to_string(code) + ")";
                    r.retryable = code == 55000000; return r;
                }
                if (o["data"].isString()) pcm += drogon::utils::base64Decode(o["data"].asString());
            }
        } catch (const std::exception& e) { r.error = std::string("invalid Doubao speech response: ") + e.what(); return r; }
        if (!finished && pcm.empty()) { r.error = "Doubao speech ended without audio"; r.retryable = true; return r; }
        r = wav(pcm, 24000, "Doubao"); r.providerMeta["speaker"] = body["req_params"]["speaker"]; return r;
    }
    std::vector<TtsVoice> listAvailableVoices() override {
        std::vector<TtsVoice> v;
        for (auto* id : {"zh_female_vv_uranus_bigtts", "zh_female_xiaohe_uranus_bigtts", "zh_male_m191_uranus_bigtts", "zh_male_taocheng_uranus_bigtts", "zh_male_liufei_uranus_bigtts", "zh_male_sunwukong_uranus_bigtts"})
            v.push_back({id, id, "zh", "", "Doubao seed-tts-2.0 voice"});
        return v;
    }
    VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest&) override { VoiceProfileCreateResult r; r.error = "Doubao voice cloning is not offered here"; return r; }
    double estimateSynthesisCost(const std::string&, int) override { return 0; }
    Json::Value features() const override {
        auto f = baseFeatures("Doubao", resource_, {"seed-tts-2.0", "seed-tts-1.0"}, {"Doubao voices", "Speech rate per voice"});
        Json::Value p; p["key"] = "speech_rate"; p["label"] = "Speech rate"; p["min"] = -50; p["max"] = 100; p["step"] = 5; p["default"] = 0; f["params"].append(p);
        return f;
    }
    Json::Value capabilities() const override { Json::Value c; c["word_timestamps"] = false; c["voice_design"] = false; c["voice_clone"] = false; c["phoneme_hints"] = false; c["model"] = resource_; c["note"] = "Volcano Engine Doubao speech V3: 24 kHz PCM wrapped as WAV; the model is the resource ID."; return c; }
private:
    std::string endpoint_, apiKey_, appId_, token_, resource_, voice_;
};
} // namespace

std::unique_ptr<TtsProvider> makeExtraTtsProvider(const Json::Value& config) {
    auto kind = json::str(config, "provider");
    if (kind == "google") return std::make_unique<GoogleTts>(config);
    if (kind == "aws") return std::make_unique<PollyTts>(config);
    if (kind == "volcengine") return std::make_unique<VolcengineTts>(config);
    return nullptr;
}

} // namespace acerciae::logstudio
