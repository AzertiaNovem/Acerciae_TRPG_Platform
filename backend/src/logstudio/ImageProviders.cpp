// Image generation and editing per provider kind (see ai/ProviderCatalog.h). Every provider returns raster bytes the
// media checks accept; remote URLs are only fetched from the provider's own result storage.
#include "ImageProvider.h"
#include "MediaService.h"
#include "../ai/AiHttp.h"
#include "../ai/AwsSigV4.h"
#include "../ai/ProviderCatalog.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/Log.h"
#include <drogon/utils/Utilities.h>

namespace acerciae::logstudio {
std::unique_ptr<ImageGenerationProvider> makeMockImageProvider();
namespace http = ai::http;

namespace {
constexpr long kTimeoutMs = 180000;
struct Ref { std::string mime, bytes, dataUri; };

// The reference images of a request (stored image bytes as data URIs), checked.
std::vector<Ref> references(const Json::Value& request) {
    std::vector<Ref> refs;
    const auto& images = request["reference_images"];
    if (images.size() > 16) throw std::runtime_error("at most 16 reference images");
    std::size_t total = 0;
    for (const auto& image : images) {
        const auto uri = json::str(image, "data_uri");
        const auto sep = uri.find(";base64,");
        if (uri.rfind("data:image/", 0) != 0 || sep == std::string::npos) throw std::runtime_error("reference image must be stored image bytes");
        const auto mime = uri.substr(5, sep - 5);
        if (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp") throw std::runtime_error("reference images must be PNG, JPEG or WebP");
        auto bytes = drogon::utils::base64Decode(uri.substr(sep + 8));
        total += bytes.size();
        if (bytes.empty() || total > 20 * 1024 * 1024 || MediaService::sniffMime(bytes, "reference") != mime) throw std::runtime_error("invalid or oversized reference image");
        refs.push_back({mime, std::move(bytes), uri});
    }
    return refs;
}
bool isStandee(const Json::Value& r) { return json::str(r, "kind") == "standee"; }
// The full art direction, for models that read instructions (GPT Image, Gemini, Qwen-Image, Seedream, OpenRouter).
std::string contextPrompt(const Json::Value& request, bool alpha) {
    auto context = request; context.removeMember("reference_images");
    std::string prompt = "Create one TRPG visual asset from the following selected art direction and source data. "
        "Preserve the specified character identity and style. Do not invent narrative facts or add text/watermarks. "
        "Use attached images as visual references when present.\n" + json::dump(context);
    if (isStandee(request)) prompt += alpha
        ? "\nMandatory image requirement, even if the gateway omits the background option: output a PNG with a true transparent alpha background. "
          "Every pixel outside the character silhouette must have alpha=0; never simulate transparency with white, a solid color or a checkerboard. "
          "Output one isolated full-body character cutout on a transparent background with a real alpha channel. "
          "Use the main profile portrait as the identity reference, retaining the face, hairstyle, clothing and art style "
          "while applying the requested gesture and expression. Keep hands, feet and the entire silhouette inside the frame. "
          "Do not copy the reference background or add scenery, a solid backdrop, a checkerboard pattern or a ground shadow."
        : "\nOutput one isolated full-body character on a plain, uniform light grey background with no scenery or ground shadow. "
          "Use the main profile portrait as the identity reference, retaining the face, hairstyle, clothing and art style "
          "while applying the requested gesture and expression. Keep the entire silhouette inside the frame.";
    return prompt;
}
// A natural-language prompt for diffusion models (Stability): the request's own prompt and identity notes.
std::string plainPrompt(const Json::Value& request) {
    std::string p = json::str(request, "prompt");
    auto identity = json::str(request, "identity_instruction");
    if (!identity.empty()) p += "\n" + identity;
    if (isStandee(request)) p += "\nFull-body character, isolated on a plain uniform background, no scenery, no text.";
    if (p.size() > 9000) p.resize(9000);
    return p;
}
std::string sizeOf(const Json::Value& request, const ImageConfig& c) {
    auto size = json::str(request, "size", c.size);
    if (size != "auto" && size != "1024x1024" && size != "1536x1024" && size != "1024x1536") throw std::runtime_error("unsupported image size");
    return size;
}
std::string aspectOf(const std::string& size) { return size == "1536x1024" ? "3:2" : size == "1024x1536" ? "2:3" : "1:1"; }
// Raster bytes from a provider, checked like any stored image.
ImageResult accept(std::string bytes, const char* who) {
    ImageResult r;
    if (bytes.empty()) { r.error = std::string(who) + " returned no image"; return r; }
    if (bytes.size() > 20 * 1024 * 1024) { r.error = "generated image exceeds 20 MB"; return r; }
    r.mime = MediaService::sniffMime(bytes, "image.png");
    if (!MediaService::allowedMime(r.mime, "background")) { r.error = std::string(who) + " returned an invalid raster image"; return r; }
    r.bytes = std::move(bytes); r.ok = true;
    return r;
}
ImageResult failed(const http::Result& res, const char* who) {
    ImageResult r;
    r.retryable = !res.error.empty() || res.status == 429 || res.status >= 500;
    r.error = !res.error.empty() ? res.error : std::string(who) + " request failed (HTTP " + std::to_string(res.status) + ")";
    if (!res.body.empty()) ALOG_WARN << who << " image HTTP " << res.status << ": " << llm::excerpt(res.body);
    return r;
}
bool ok(const http::Result& res) { return res.error.empty() && res.status >= 200 && res.status < 300; }
std::string ext(const std::string& mime) { return mime == "image/png" ? "png" : mime == "image/webp" ? "webp" : "jpg"; }

class Remote : public ImageGenerationProvider {
public:
    explicit Remote(ImageConfig c) : c_(std::move(c)) {}
    std::string name() const override { return c_.provider; }
    std::string model() const override { return c_.model; }
    std::string configurationId() const override {
        return crypto::sha256Hex(name() + "\n" + c_.apiBase + "\n" + c_.apiKey + "\n" + model() + "\n" + c_.size + "\n" + c_.quality);
    }
    ImageResult generate(const Json::Value& request) override {
        std::vector<Ref> refs;
        try { refs = references(request); } catch (const std::exception& e) { ImageResult r; r.error = e.what(); return r; }
        try { return run(request, refs); }
        catch (const std::exception& e) { ImageResult r; r.error = e.what(); return r; }
    }
protected:
    virtual ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) = 0;
    ImageConfig c_;
};

// OpenAI-compatible Images API: /images/generations, or /images/edits (multipart) with references.
class OpenAiImages final : public Remote {
public:
    using Remote::Remote;
    std::string name() const override { return "gpt_image"; }
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        Json::Value body;
        body["model"] = model(); body["n"] = 1; body["output_format"] = "png";
        if (isStandee(request)) body["background"] = "transparent";
        auto size = sizeOf(request, c_);
        if (size != "auto") body["size"] = size;
        if (c_.quality != "auto") body["quality"] = c_.quality;
        body["prompt"] = contextPrompt(request, true);
        http::Result res;
        std::vector<std::string> auth = {"Authorization: Bearer " + c_.apiKey};
        if (refs.empty()) {
            auto headers = auth; headers.push_back("Content-Type: application/json");
            res = http::postOnce(http::joinUrl(c_.apiBase, "/images/generations"), headers, json::dump(body), kTimeoutMs);
        } else {
            std::vector<std::pair<std::string, std::string>> fields;
            for (const auto& k : body.getMemberNames()) fields.emplace_back(k, body[k].asString());
            std::vector<http::FilePart> files;
            for (const auto& r : refs) files.push_back({"image[]", "reference." + ext(r.mime), r.mime, r.bytes});
            res = http::postMultipart(http::joinUrl(c_.apiBase, "/images/edits"), auth, fields, files, kTimeoutMs);
        }
        if (!ok(res)) { auto f = failed(res, "GPT Image"); if (res.error.empty()) f.error = "GPT Image request failed (HTTP " + std::to_string(res.status) + ")"; return f; }
        const auto data = json::parse(res.body);
        const auto b64 = json::str(data["data"][0], "b64_json");
        if (b64.empty()) throw std::runtime_error("GPT Image must return data[0].b64_json; remote image URLs are not fetched");
        return accept(drogon::utils::base64Decode(b64), "GPT Image");
    }
};

// Gemini Interactions API: one interaction asking for an image, references in the input.
class GoogleImages final : public Remote {
public:
    using Remote::Remote;
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        Json::Value body;
        body["model"] = model(); body["store"] = false;
        Json::Value text; text["type"] = "text"; text["text"] = contextPrompt(request, false);
        body["input"].append(text);
        for (const auto& r : refs) { Json::Value img; img["type"] = "image"; img["mime_type"] = r.mime; img["data"] = drogon::utils::base64Encode(r.bytes); body["input"].append(img); }
        body["response_format"]["type"] = "image";
        auto size = sizeOf(request, c_);
        if (size != "auto" || refs.empty()) body["response_format"]["aspect_ratio"] = aspectOf(size);
        auto res = http::postOnce(http::joinUrl(c_.apiBase, "/interactions"), {"Content-Type: application/json", "x-goog-api-key: " + c_.apiKey}, json::dump(body), kTimeoutMs);
        if (!ok(res)) return failed(res, "Gemini");
        auto j = json::parse(res.body);
        std::string data;
        for (const auto& step : j["steps"]) for (const auto& block : step["content"]) if (block["type"] == "image" && block["data"].isString()) data = block["data"].asString();
        for (const auto& block : j["outputs"]) if (block["type"] == "image" && block["data"].isString()) data = block["data"].asString();
        if (data.empty()) throw std::runtime_error(j["status"].asString() == "completed" ? "Gemini returned no image (the request may have been declined)" : "Gemini did not complete the image");
        return accept(drogon::utils::base64Decode(data), "Gemini");
    }
};

// Alibaba Model Studio: Qwen-Image (generation) and Qwen-Image editing through multimodal-generation; the result is a
// URL on Alibaba's own storage, fetched once.
class AlibabaImages final : public Remote {
public:
    using Remote::Remote;
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        Json::Value body;
        body["model"] = model();
        Json::Value message; message["role"] = "user";
        for (std::size_t i = 0; i < refs.size() && i < 3; ++i) { Json::Value img; img["image"] = refs[i].dataUri; message["content"].append(img); }
        Json::Value text; text["text"] = contextPrompt(request, false).substr(0, 5000); message["content"].append(text);
        body["input"]["messages"].append(message);
        body["parameters"]["n"] = 1; body["parameters"]["watermark"] = false; body["parameters"]["prompt_extend"] = false;
        auto size = sizeOf(request, c_);
        if (refs.empty()) body["parameters"]["size"] = size == "1536x1024" ? "1664*928" : size == "1024x1536" ? "928*1664" : "1328*1328";
        auto res = http::postOnce(http::joinUrl(c_.apiBase, "/api/v1/services/aigc/multimodal-generation/generation"),
                              {"Content-Type: application/json", "Authorization: Bearer " + c_.apiKey}, json::dump(body), kTimeoutMs);
        if (!ok(res)) return failed(res, "Qwen-Image");
        auto j = json::parse(res.body);
        auto url = json::str(j["output"]["choices"][0]["message"]["content"][0], "image");
        if (url.empty()) throw std::runtime_error("Qwen-Image returned no image");
        auto host = http::hostOf(url);
        auto suffix = std::string(".aliyuncs.com");
        if (url.rfind("https://", 0) != 0 || host.size() <= suffix.size() || host.compare(host.size() - suffix.size(), suffix.size(), suffix) != 0)
            throw std::runtime_error("Qwen-Image returned an image outside Alibaba's storage");
        auto file = http::get(url, {}, 60000, 25u * 1024 * 1024);
        if (!ok(file)) return failed(file, "Qwen-Image download");
        return accept(file.body, "Qwen-Image");
    }
};

// OpenRouter Images endpoint; references as input_references.
class OpenRouterImages final : public Remote {
public:
    using Remote::Remote;
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        Json::Value body;
        body["model"] = model(); body["n"] = 1; body["output_format"] = "png"; body["prompt"] = contextPrompt(request, false);
        auto size = sizeOf(request, c_);
        if (size != "auto" || refs.empty()) body["aspect_ratio"] = aspectOf(size);
        for (const auto& r : refs) { Json::Value ref; ref["type"] = "image_url"; ref["image_url"]["url"] = r.dataUri; body["input_references"].append(ref); }
        auto res = http::postOnce(http::joinUrl(c_.apiBase, "/images"), {"Content-Type: application/json", "Authorization: Bearer " + c_.apiKey, "X-OpenRouter-Title: Acerciae"}, json::dump(body), kTimeoutMs);
        if (!ok(res)) return failed(res, "OpenRouter");
        auto b64 = json::str(json::parse(res.body)["data"][0], "b64_json");
        if (b64.empty()) throw std::runtime_error("OpenRouter returned no image");
        return accept(drogon::utils::base64Decode(b64), "OpenRouter");
    }
};

// Volcano Engine Ark: Seedream images/generations, references in "image".
class VolcengineImages final : public Remote {
public:
    using Remote::Remote;
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        Json::Value body;
        body["model"] = model(); body["prompt"] = contextPrompt(request, false) + "\nAspect ratio: " + aspectOf(sizeOf(request, c_)) + ".";
        body["size"] = "2K"; body["response_format"] = "b64_json"; body["watermark"] = false; body["sequential_image_generation"] = "disabled";
        if (refs.size() == 1) body["image"] = refs[0].dataUri;
        else for (const auto& r : refs) body["image"].append(r.dataUri);
        auto res = http::postOnce(http::joinUrl(c_.apiBase, "/images/generations"), {"Content-Type: application/json", "Authorization: Bearer " + c_.apiKey}, json::dump(body), kTimeoutMs);
        if (!ok(res)) return failed(res, "Seedream");
        auto item = json::parse(res.body)["data"][0];
        if (item["error"].isObject()) throw std::runtime_error("Seedream declined the image: " + json::str(item["error"], "code"));
        auto b64 = json::str(item, "b64_json");
        if (b64.empty()) throw std::runtime_error("Seedream returned no image");
        return accept(drogon::utils::base64Decode(b64), "Seedream");
    }
};

// Stability AI v2beta: generate/{ultra,core,sd3}; with a reference, image-to-image (sd3 models, ultra). Standees get
// their background removed afterwards (remove-background), since generation cannot make transparency.
class StabilityImages final : public Remote {
public:
    using Remote::Remote;
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        std::string endpoint = model() == "ultra" || model() == "core" ? model() : "sd3";
        if (!refs.empty() && endpoint == "core") endpoint = "sd3";   // core has no image-to-image
        std::vector<std::pair<std::string, std::string>> fields = {{"prompt", plainPrompt(request)}, {"output_format", "png"}};
        if (endpoint == "sd3") { fields.emplace_back("model", model() == "core" || model() == "ultra" ? "sd3.5-large" : model()); fields.emplace_back("mode", refs.empty() ? "text-to-image" : "image-to-image"); }
        std::vector<http::FilePart> files;
        if (refs.empty()) fields.emplace_back("aspect_ratio", aspectOf(sizeOf(request, c_)));
        else { files.push_back({"image", "reference." + ext(refs[0].mime), refs[0].mime, refs[0].bytes}); fields.emplace_back("strength", "0.6"); }
        std::vector<std::string> headers = {"Authorization: Bearer " + c_.apiKey, "Accept: application/json"};
        auto res = http::postMultipart(http::joinUrl(c_.apiBase, "/v2beta/stable-image/generate/" + endpoint), headers, fields, files, kTimeoutMs);
        if (!ok(res)) return failed(res, "Stability AI");
        auto j = json::parse(res.body);
        if (json::str(j, "finish_reason") == "CONTENT_FILTERED") throw std::runtime_error("Stability AI filtered the image");
        auto bytes = drogon::utils::base64Decode(json::str(j, "image"));
        if (isStandee(request) && !bytes.empty()) {
            auto cut = http::postMultipart(http::joinUrl(c_.apiBase, "/v2beta/stable-image/edit/remove-background"), headers, {{"output_format", "png"}},
                                           {{"image", "standee.png", "image/png", bytes}}, kTimeoutMs);
            if (ok(cut)) { auto cj = json::parse(cut.body); auto b = drogon::utils::base64Decode(json::str(cj, "image")); if (!b.empty()) bytes = std::move(b); }
            else ALOG_WARN << "Stability remove-background failed (HTTP " << cut.status << "): the standee keeps its background";
        }
        return accept(bytes, "Stability AI");
    }
};

// Stability models on Amazon Bedrock (InvokeModel, SigV4). Amazon's own image models have reached end of life.
class BedrockImages final : public Remote {
public:
    using Remote::Remote;
    ImageResult run(const Json::Value& request, const std::vector<Ref>& refs) override {
        Json::Value body;
        body["prompt"] = plainPrompt(request); body["output_format"] = "png";
        if (refs.empty()) { body["mode"] = "text-to-image"; body["aspect_ratio"] = aspectOf(sizeOf(request, c_)); }
        else { body["mode"] = "image-to-image"; body["image"] = drogon::utils::base64Encode(refs[0].bytes); body["strength"] = 0.6; }
        if (model().find("ultra") != std::string::npos) body.removeMember("mode");
        auto payload = json::dump(body);
        auto url = http::joinUrl(c_.apiBase, "/model/" + ai::aws::uriEncode(model()) + "/invoke");
        ai::aws::Request req; req.host = http::hostOf(url); req.path = http::pathOf(url); req.body = payload;
        req.headers = {{"content-type", "application/json"}, {"accept", "application/json"}};
        ai::aws::Credentials creds{c_.access.option("access_key_id"), c_.apiKey, c_.access.secret("session_token"), c_.access.option("region", "us-east-1")};
        auto res = http::postOnce(url, ai::aws::sign(req, creds, "bedrock"), payload, kTimeoutMs);
        if (!ok(res)) return failed(res, "Bedrock");
        auto j = json::parse(res.body);
        if (j["finish_reasons"][0].isString()) throw std::runtime_error("Bedrock declined the image: " + j["finish_reasons"][0].asString());
        return accept(drogon::utils::base64Decode(j["images"][0].asString()), "Bedrock");
    }
};

std::unique_ptr<ImageGenerationProvider> makeOne(const ImageConfig& c) {
    if (c.provider == "mock") return makeMockImageProvider();
    if (c.provider == "disabled" || c.apiKey.empty() || c.model.empty() || c.apiBase.empty()) return nullptr;
    if (c.provider == "openai") return std::make_unique<OpenAiImages>(c);
    if (c.provider == "google") return std::make_unique<GoogleImages>(c);
    if (c.provider == "alibaba") return std::make_unique<AlibabaImages>(c);
    if (c.provider == "openrouter") return std::make_unique<OpenRouterImages>(c);
    if (c.provider == "volcengine") return std::make_unique<VolcengineImages>(c);
    if (c.provider == "stability") return std::make_unique<StabilityImages>(c);
    if (c.provider == "aws") return std::make_unique<BedrockImages>(c);
    return nullptr;
}

// Generation, with reference requests sent to the editing use when it is set apart. A provider that cannot edit (or
// editing turned off) gets the prompt without references.
class Routed final : public ImageGenerationProvider {
public:
    Routed(std::unique_ptr<ImageGenerationProvider> gen, std::string genKind, std::unique_ptr<ImageGenerationProvider> edit, std::string editKind, bool editSet)
        : gen_(std::move(gen)), edit_(std::move(edit)), genKind_(std::move(genKind)), editKind_(std::move(editKind)), editSet_(editSet) {}
    std::string name() const override { return gen_->name(); }
    std::string model() const override { return gen_->model(); }
    std::string configurationId() const override { return crypto::sha256Hex(gen_->configurationId() + "\n" + (edit_ ? edit_->configurationId() : editSet_ ? "off" : "")); }
    ImageResult generate(const Json::Value& request) override {
        bool hasRefs = request["reference_images"].isArray() && !request["reference_images"].empty();
        if (!hasRefs) return gen_->generate(request);
        if (editSet_ && edit_) return withRefs(*edit_, editKind_, request);
        if (editSet_) return gen_->generate(strip(request));
        return withRefs(*gen_, genKind_, request);
    }
private:
    static Json::Value strip(const Json::Value& r) { auto out = r; out.removeMember("reference_images"); return out; }
    static ImageResult withRefs(ImageGenerationProvider& p, const std::string& kind, const Json::Value& r) {
        return kind == "mock" || ai::catalog::supports(kind, "image_edit") ? p.generate(r) : p.generate(strip(r));
    }
    std::unique_ptr<ImageGenerationProvider> gen_, edit_;
    std::string genKind_, editKind_;
    bool editSet_;
};
} // namespace

std::unique_ptr<ImageGenerationProvider> makeImageProvider(const ImageConfig& c) {
    auto gen = makeOne(c);
    if (!gen) return nullptr;
    // Without a separate editing use, a provider that can edit takes references itself (and keeps its own
    // configuration id).
    if (!c.edit && (c.provider == "mock" || ai::catalog::supports(c.provider, "image_edit"))) return gen;
    std::unique_ptr<ImageGenerationProvider> edit = c.edit ? makeOne(*c.edit) : nullptr;
    return std::make_unique<Routed>(std::move(gen), c.provider, std::move(edit), c.edit ? c.edit->provider : "", bool(c.edit));
}

} // namespace acerciae::logstudio
