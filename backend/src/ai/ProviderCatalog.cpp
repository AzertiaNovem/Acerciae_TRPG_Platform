#include "ProviderCatalog.h"
#include "../core/Json.h"

namespace acerciae::ai::catalog {

// Field types: secret (sealed at rest, never returned), text (plain). "api_key" is each kind's main secret.
static const char* KINDS = R"JSON([
 {"id": "openai", "label": "OpenAI-compatible",
  "capabilities": ["text", "embedding", "image_generation", "image_edit", "tts"],
  "default_api_base": "https://api.openai.com/v1",
  "protocol": "Chat Completions, Embeddings, Images (generations and edits) and Audio speech",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "models": {"text": ["gpt-5.1", "gpt-5-mini"], "embedding": ["text-embedding-3-small", "text-embedding-3-large"],
             "image_generation": ["gpt-image-1", "gpt-image-1-mini"], "image_edit": ["gpt-image-1"], "tts": ["gpt-4o-mini-tts", "tts-1"]}},
 {"id": "anthropic", "label": "Anthropic-compatible",
  "capabilities": ["text"],
  "default_api_base": "https://api.anthropic.com/v1",
  "protocol": "Messages API",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "models": {"text": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]}},
 {"id": "responses", "label": "Responses API-compatible",
  "capabilities": ["text", "embedding"],
  "default_api_base": "https://api.openai.com/v1",
  "protocol": "Responses API (streamed, sealed reasoning kept between turns) and Embeddings",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "models": {"text": ["gpt-5.1", "gpt-5-mini"], "embedding": ["text-embedding-3-small"]}},
 {"id": "google", "label": "Google (Gemini Interactions)",
  "capabilities": ["embedding", "image_generation", "image_edit", "tts"],
  "default_api_base": "https://generativelanguage.googleapis.com/v1beta",
  "protocol": "Interactions API for images and speech; embedContent for embeddings",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "models": {"embedding": ["gemini-embedding-001", "gemini-embedding-2"], "image_generation": ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3-pro-image"],
             "image_edit": ["gemini-nano-banana-2.1", "gemini-3-pro-image"], "tts": ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]},
  "notes": "Speech voices: Kore, Puck, Charon, Zephyr, Fenrir, Leda, Aoede… (30 prebuilt)."},
 {"id": "aws", "label": "AWS (Bedrock and Polly)",
  "capabilities": ["embedding", "image_generation", "image_edit", "tts"],
  "default_api_base": "https://bedrock-runtime.{region}.amazonaws.com",
  "protocol": "Bedrock InvokeModel (Titan or Cohere embeddings, Stability image models on Bedrock) and Polly SynthesizeSpeech, signed with Signature Version 4",
  "fields": [{"key": "region", "label": "Region", "type": "text", "required": true, "placeholder": "us-east-1"},
             {"key": "access_key_id", "label": "Access key ID", "type": "text", "required": true},
             {"key": "api_key", "label": "Secret access key", "type": "secret", "required": true},
             {"key": "session_token", "label": "Session token (temporary credentials)", "type": "secret", "required": false},
             {"key": "polly_endpoint", "label": "Polly endpoint", "type": "url", "required": false, "placeholder": "https://polly.{region}.amazonaws.com"}],
  "models": {"embedding": ["amazon.titan-embed-text-v2:0", "cohere.embed-v4"], "image_generation": ["stability.sd3-5-large-v1:0", "stability.stable-image-ultra-v1:1"],
             "image_edit": ["stability.sd3-5-large-v1:0", "stability.stable-image-ultra-v1:1"], "tts": ["neural", "generative", "long-form", "standard"]},
  "notes": "Speech: the model is Polly's engine and the voice a Polly voice id (Joanna, Matthew…). Amazon's own image models have reached end of life; use Stability models hosted on Bedrock (us-west-2)."},
 {"id": "alibaba", "label": "Alibaba Cloud (Model Studio)",
  "capabilities": ["text", "embedding", "image_generation", "image_edit", "tts"],
  "default_api_base": "https://dashscope.aliyuncs.com",
  "protocol": "OpenAI-compatible mode for text and embeddings; DashScope Qwen-Image, Qwen-Image-Edit and Qwen TTS",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "api_base_hint": "International accounts: https://dashscope-intl.aliyuncs.com",
  "models": {"text": ["qwen-plus", "qwen-max", "qwen3-max"], "embedding": ["text-embedding-v4"], "image_generation": ["qwen-image-3.0", "qwen-image-3.0-pro", "qwen-image-2.1-turbo"],
             "image_edit": ["qwen-image-3.0", "qwen-image-2.1-pro", "qwen-image-edit-plus"], "tts": ["qwen3-tts-flash", "qwen-tts"]},
  "notes": "Speech voices: Cherry, Serena, Ethan, Chelsie… Workspace endpoints (https://{workspace}.cn-beijing.maas.aliyuncs.com) work too."},
 {"id": "openrouter", "label": "OpenRouter",
  "capabilities": ["text", "embedding", "image_generation", "image_edit", "tts"],
  "default_api_base": "https://openrouter.ai/api/v1",
  "protocol": "anthropic/* models through its Messages endpoint, other models through Chat Completions; Embeddings, Images and Audio speech endpoints",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "models": {"text": ["anthropic/claude-sonnet-5.5", "openai/gpt-5.1", "google/gemini-3-pro"], "embedding": ["openai/text-embedding-3-small"],
             "image_generation": ["google/gemini-nano-banana-2.1", "bytedance-seed/seedream-4.5"], "image_edit": ["google/gemini-nano-banana-2.1", "bytedance-seed/seedream-4.5"],
             "tts": ["openai/gpt-4o-mini-tts-2025-12-15", "mistralai/voxtral-mini-tts-2603"]}},
 {"id": "volcengine", "label": "Volcano Engine (Ark and Doubao Speech)",
  "capabilities": ["text", "image_generation", "image_edit", "tts"],
  "default_api_base": "https://ark.cn-beijing.volces.com/api/v3",
  "protocol": "Ark Chat Completions and Seedream images; Doubao speech synthesis",
  "fields": [{"key": "api_key", "label": "Ark API key", "type": "secret", "required": true},
             {"key": "speech_api_key", "label": "Speech API key (new console)", "type": "secret", "required": false},
             {"key": "speech_app_id", "label": "Speech app ID (old console)", "type": "text", "required": false},
             {"key": "speech_access_token", "label": "Speech access token (old console)", "type": "secret", "required": false},
             {"key": "speech_resource_id", "label": "Speech resource ID", "type": "text", "required": false, "placeholder": "seed-tts-2.0"},
             {"key": "speech_endpoint", "label": "Speech endpoint", "type": "url", "required": false, "placeholder": "https://openspeech.bytedance.com"}],
  "models": {"text": ["doubao-seed-2-1-pro", "doubao-seed-2-1-lite"], "image_generation": ["doubao-seedream-4-5-251128", "doubao-seedream-5-0-260128"],
             "image_edit": ["doubao-seedream-4-5-251128", "doubao-seedream-5-0-260128"], "tts": ["seed-tts-2.0"]},
  "notes": "Speech: the model is the resource ID (seed-tts-2.0) and the voice a speaker id such as zh_female_vv_uranus_bigtts. Speech needs the speech API key, or the app ID and access token."},
 {"id": "stability", "label": "Stability AI",
  "capabilities": ["image_generation", "image_edit"],
  "default_api_base": "https://api.stability.ai",
  "protocol": "Stable Image v2beta (generate; image-to-image for edits)",
  "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}],
  "models": {"image_generation": ["sd3.5-large", "core", "ultra"], "image_edit": ["sd3.5-large", "ultra"]},
  "notes": "Edits use image-to-image from the reference picture (sd3.5 models or ultra); character identity is kept less faithfully than with Gemini or GPT Image."}
])JSON";

static const char* USES = R"JSON([
 {"id": "text", "capability": "text", "modes": ["provider", "mock"], "default": "mock", "label": "Text"},
 {"id": "text_chronicle", "capability": "text", "modes": ["inherit", "provider", "mock"], "default": "inherit", "label": "Text: chronicler and Keeper",
  "tasks": ["observer_extract", "consolidate", "reminders", "stage_detect", "scenario_summary", "scenario_outline", "kp_update", "kp_review", "kp_reminders", "kp_board", "channel_atmosphere"]},
 {"id": "text_assist", "capability": "text", "modes": ["inherit", "provider", "mock"], "default": "inherit", "label": "Text: player assists",
  "tasks": ["consistency", "inspiration"]},
 {"id": "text_writing", "capability": "text", "modes": ["inherit", "provider", "mock"], "default": "inherit", "label": "Text: long writing",
  "tasks": ["vn_script", "log_performance", "module_structure", "script_knowledge"]},
 {"id": "embedding", "capability": "embedding", "modes": ["provider", "disabled"], "default": "disabled", "label": "Embedding"},
 {"id": "image_generation", "capability": "image_generation", "modes": ["provider", "mock", "disabled"], "default": "disabled", "label": "Image generation"},
 {"id": "image_edit", "capability": "image_edit", "modes": ["inherit", "provider", "mock", "disabled"], "default": "inherit", "label": "Image editing"},
 {"id": "tts", "capability": "tts", "modes": ["provider", "mock", "disabled"], "default": "mock", "label": "Speech"}
])JSON";

const Json::Value& kinds() { static const Json::Value v = json::parse(KINDS); return v; }
const Json::Value& uses() { static const Json::Value v = json::parse(USES); return v; }
static const Json::Value* find(const Json::Value& list, const std::string& id) {
    for (const auto& item : list) if (item["id"].asString() == id) return &item;
    return nullptr;
}
const Json::Value* kind(const std::string& id) { return find(kinds(), id); }
const Json::Value* use(const std::string& id) { return find(uses(), id); }
bool supports(const std::string& k, const std::string& capability) {
    auto* entry = kind(k);
    if (!entry) return false;
    for (const auto& c : (*entry)["capabilities"]) if (c.asString() == capability) return true;
    return false;
}
std::string capabilityOf(const std::string& u) { auto* entry = use(u); return entry ? (*entry)["capability"].asString() : ""; }
std::string defaultApiBase(const std::string& k) { auto* entry = kind(k); return entry ? (*entry)["default_api_base"].asString() : ""; }
std::string textUseFor(const std::string& task) {
    for (const auto& u : uses())
        for (const auto& t : u["tasks"]) if (t.asString() == task) return u["id"].asString();
    return "text";
}

} // namespace acerciae::ai::catalog
