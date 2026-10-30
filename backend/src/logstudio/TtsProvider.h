#pragma once
#include <json/json.h>
#include <string>
#include <vector>
#include <memory>
#include <optional>

namespace acerciae::logstudio {

struct TtsVoice { std::string id; std::string name; std::string language; std::string gender; std::string description; std::string type = "preset"; };

struct TtsSynthesisRequest {
    std::string modelId;            // provider model
    std::string voiceId;
    std::string text;               // the text actually spoken (dictionary already applied)
    std::string language;           // zh | en | auto | dialect code
    std::string instruction;        // identity-level + line-level delivery instruction, already combined
    Json::Value parameters;         // speed, pitch, format, …
};
struct TtsSynthesisResult {
    bool ok = false;
    std::string error;
    bool retryable = false;         // rate limit / transient → worker retries with backoff
    std::string audioBytes;
    std::string mime = "audio/wav";
    int durationMs = 0;
    Json::Value wordTimestamps;     // null unless the provider really returned them
    Json::Value providerMeta;       // request id, raw usage, …
};
struct VoiceProfileCreateRequest {
    std::string kind;               // design | clone
    std::string targetModel;
    std::string preferredName;
    std::string designPrompt;       // design
    std::string referenceAudio;     // clone: raw bytes
    std::string referenceMime;
    std::string language;
};
struct VoiceProfileCreateResult { bool ok = false; std::string error; std::string voiceId; Json::Value providerMeta; };

// Pluggable speech synthesis. Decoupled from business services; the player never talks to a provider.
class TtsProvider {
public:
    virtual ~TtsProvider() = default;
    virtual std::string name() const = 0;                        // qwen | openai | mock
    virtual bool isMock() const = 0;
    virtual std::string cacheNamespace() const { return name(); }
    virtual std::string officialModel() const = 0;
    virtual std::string previewModel() const = 0;
    virtual TtsSynthesisResult synthesize(const TtsSynthesisRequest& req) = 0;
    virtual std::vector<TtsVoice> listAvailableVoices() = 0;
    virtual VoiceProfileCreateResult createVoiceProfile(const VoiceProfileCreateRequest& req) = 0;
    virtual Json::Value getSynthesisStatus(const std::string& providerJobId) { Json::Value v; v["status"] = "n/a"; v["note"] = "synchronous provider"; (void)providerJobId; return v; }
    virtual double estimateSynthesisCost(const std::string& modelId, int chars) = 0;   // in the configured currency unit
    virtual bool cancelPendingJob(const std::string& providerJobId) { (void)providerJobId; return false; }
    virtual bool supportsPhonemeHints() const { return false; }
    virtual Json::Value capabilities() const = 0;
};

// {provider: "qwen" | "openai", api_key, api_base?, model?, voice?} makes that provider; anything else the labelled mock.
std::unique_ptr<TtsProvider> makeTtsProvider(const Json::Value& config = Json::Value());
int wavDurationMs(const std::string& bytes);        // 0 if not a PCM WAV
std::string makeWav(const std::vector<int16_t>& samples, int sampleRate);

} // namespace
