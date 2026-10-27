#include "ImageProvider.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "MediaService.h"
#include <cstdlib>
#include <vector>
#include <curl/curl.h>
#include <drogon/utils/Utilities.h>
#include <zlib.h>
namespace acerciae::logstudio {
static std::string env(const char *key, const char *def = "") {
  auto v = std::getenv(key);
  return v && *v ? v : def;
}
static void u32(std::string &s, uint32_t n) {
  for (int i = 3; i >= 0; --i)
    s += char(n >> (i * 8));
}
static void chunk(std::string &out, const std::string &name,
                  const std::string &data) {
  u32(out, data.size());
  out += name + data;
  u32(out, crc32(0, reinterpret_cast<const Bytef *>((name + data).data()),
                 name.size() + data.size()));
}
class MockImage final : public ImageGenerationProvider {
public:
  std::string name() const override { return "mock"; }
  std::string model() const override { return "procedural-test-pattern-v1"; }
  ImageResult generate(const Json::Value &req) override {
    // A reproducible diagnostic checkerboard, never presented as generated
    // artwork.
    auto hash = crypto::sha256Hex(json::dump(req));
    int w = 320, h = 180;
    std::string raw;
    for (int y = 0; y < h; ++y) {
      raw += '\0';
      for (int x = 0; x < w; ++x) {
        bool light = ((x / 20 + y / 20) % 2) == 0;
        raw += char(light ? 160 : 45);
        raw += char(light ? static_cast<unsigned char>(hash[0]) : 35);
        raw += char(light ? 180 : 55);
      }
    }
    uLongf size = compressBound(raw.size());
    std::string packed(size, '\0');
    compress2(reinterpret_cast<Bytef *>(packed.data()), &size,
              reinterpret_cast<const Bytef *>(raw.data()), raw.size(), 6);
    packed.resize(size);
    std::string png("\x89PNG\r\n\x1a\n", 8), ihdr;
    u32(ihdr, w);
    u32(ihdr, h);
    ihdr += std::string("\x08\x02\0\0\0", 5);
    chunk(png, "IHDR", ihdr);
    chunk(png, "tEXt",
          std::string("Description\0MOCK test pattern - not AI artwork", 44));
    chunk(png, "IDAT", packed);
    chunk(png, "IEND", "");
    return {true, false, png, "image/png", ""};
  }
};
class HttpImage final : public ImageGenerationProvider {
public:
  explicit HttpImage(ImageConfig c) : config_(std::move(c)) {}
  std::string name() const override { return "http"; }
  std::string model() const override { return config_.model; }
  std::string configurationId() const override { return crypto::sha256Hex(config_.apiBase + "\n" + config_.apiKey + "\n" + model()); }
  ImageResult generate(const Json::Value &req) override {
    ImageResult r;
    auto endpoint = config_.apiBase, key = config_.apiKey;
    if (endpoint.rfind("https://", 0) != 0 || key.empty()) {
      r.error = "IMAGE_API_URL (HTTPS) and IMAGE_API_KEY required";
      return r;
    }
    Json::Value body = req;
    body["model"] = model();
    body["response_format"] = "b64_json";
    auto encoded = json::dump(body);
    std::string out;
    CURL *c = curl_easy_init();
    curl_slist *headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers =
        curl_slist_append(headers, ("Authorization: Bearer " + key).c_str());
    curl_easy_setopt(c, CURLOPT_URL, endpoint.c_str());
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, encoded.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)encoded.size());
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, 120000L);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(
        c, CURLOPT_WRITEFUNCTION,
        +[](char *p, size_t s, size_t n, void *ctx) -> size_t {
          auto &v = *static_cast<std::string *>(ctx);
          if (v.size() + s * n > 30 * 1024 * 1024)
            return 0;
          v.append(p, s * n);
          return s * n;
        });
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &out);
    auto rc = curl_easy_perform(c);
    long status = 0;
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(c);
    if (rc != CURLE_OK || status < 200 || status >= 300) {
      r.error =
          "image provider request failed (HTTP " + std::to_string(status) + ")";
      r.retryable = rc != CURLE_OK || status == 429 || status >= 500;
      return r;
    }
    try {
      auto data = json::parse(out);
      auto b64 = json::str(data["data"][0], "b64_json");
      if (b64.empty())
        throw std::runtime_error("provider must return data[0].b64_json; "
                                 "remote URLs are not fetched");
      r.bytes = drogon::utils::base64Decode(b64);
      r.mime = MediaService::sniffMime(r.bytes, "image.png");
      if (!MediaService::allowedMime(r.mime, "background"))
        throw std::runtime_error("provider returned invalid raster image");
      r.ok = true;
    } catch (const std::exception &e) {
      r.error = e.what();
    }
    return r;
  }
private:
  ImageConfig config_;
};
std::string ImageGenerationProvider::configurationId() const {
  return crypto::sha256Hex(name() + "\n" + model());
}
class GptImage final : public ImageGenerationProvider {
public:
  explicit GptImage(ImageConfig c) : config_(std::move(c)) {}
  std::string name() const override { return "gpt_image"; }
  std::string model() const override { return config_.model; }
  std::string configurationId() const override {
    return crypto::sha256Hex(name() + "\n" + config_.apiBase + "\n" + config_.apiKey + "\n" + model() + "\n" + config_.size + "\n" + config_.quality);
  }
  ImageResult generate(const Json::Value& request) override {
    ImageResult r;
    Json::Value body;
    body["model"] = model(); body["n"] = 1; body["output_format"] = "png";
    if (config_.size != "auto") body["size"] = config_.size;
    if (config_.quality != "auto") body["quality"] = config_.quality;
    auto context = request; context.removeMember("reference_images");
    body["prompt"] = "Create one TRPG visual asset from the following selected art direction and source data. "
      "Preserve the specified character identity and style. Do not invent narrative facts or add text/watermarks. "
      "Use attached images as visual references when present.\n" + json::dump(context);
    std::vector<std::pair<std::string, std::string>> refs;
    try {
      const auto& images = request["reference_images"];
      if (images.size() > 16) throw std::runtime_error("at most 16 reference images");
      size_t total = 0;
      for (const auto& image : images) {
        const auto uri = json::str(image, "data_uri");
        const auto sep = uri.find(";base64,");
        if (uri.rfind("data:image/", 0) != 0 || sep == std::string::npos) throw std::runtime_error("reference image must be stored image bytes");
        const auto mime = uri.substr(5, sep-5);
        if (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp") throw std::runtime_error("GPT Image reference must be PNG, JPEG or WebP");
        auto bytes = drogon::utils::base64Decode(uri.substr(sep+8));
        total += bytes.size();
        if (bytes.empty() || total > 20*1024*1024 || MediaService::sniffMime(bytes, "reference") != mime) throw std::runtime_error("invalid or oversized reference image");
        refs.emplace_back(mime, std::move(bytes));
      }
    } catch (const std::exception& e) { r.error = e.what(); return r; }
    auto url = config_.apiBase; while (!url.empty() && url.back() == '/') url.pop_back();
    url += refs.empty() ? "/images/generations" : "/images/edits";
    auto encoded = json::dump(body);
    auto* c = curl_easy_init();
    if (!c) { r.error = "HTTP client unavailable"; return r; }
    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + config_.apiKey).c_str());
    curl_mime* form = nullptr;
    if (refs.empty()) {
      headers = curl_slist_append(headers, "Content-Type: application/json");
      curl_easy_setopt(c, CURLOPT_POSTFIELDS, encoded.c_str());
      curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)encoded.size());
    } else {
      form = curl_mime_init(c);
      for (const auto& key : body.getMemberNames()) {
        auto* part = curl_mime_addpart(form); curl_mime_name(part, key.c_str());
        const auto value = body[key].asString(); curl_mime_data(part, value.data(), value.size());
      }
      for (const auto& [mime, bytes] : refs) {
        auto* part = curl_mime_addpart(form); curl_mime_name(part, "image[]");
        curl_mime_filename(part, mime == "image/png" ? "reference.png" : mime == "image/webp" ? "reference.webp" : "reference.jpg");
        curl_mime_type(part, mime.c_str()); curl_mime_data(part, bytes.data(), bytes.size());
      }
      curl_easy_setopt(c, CURLOPT_MIMEPOST, form);
    }
    std::string output;
    curl_easy_setopt(c, CURLOPT_URL, url.c_str()); curl_easy_setopt(c, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, 180000L); curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L); curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, +[](char* p, size_t s, size_t n, void* ctx) -> size_t {
      auto& out = *static_cast<std::string*>(ctx);
      if (s*n > 30*1024*1024 - out.size()) return 0;
      out.append(p, s*n); return s*n;
    });
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &output);
    const auto rc = curl_easy_perform(c); long status = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_mime_free(form); curl_slist_free_all(headers); curl_easy_cleanup(c);
    if (rc != CURLE_OK || status < 200 || status >= 300) {
      r.error = "GPT Image request failed (HTTP " + std::to_string(status) + ")";
      r.retryable = rc != CURLE_OK || status == 429 || status >= 500; return r;
    }
    try {
      const auto data = json::parse(output);
      const auto b64 = json::str(data["data"][0], "b64_json");
      if (b64.empty()) throw std::runtime_error("GPT Image must return data[0].b64_json; remote image URLs are not fetched");
      r.bytes = drogon::utils::base64Decode(b64);
      if (r.bytes.size() > 20*1024*1024) throw std::runtime_error("generated image exceeds 20 MB");
      r.mime = MediaService::sniffMime(r.bytes, "image.png");
      if (!MediaService::allowedMime(r.mime, "background")) throw std::runtime_error("provider returned invalid raster image");
      r.ok = true;
    } catch (const std::exception& e) { r.error = e.what(); }
    return r;
  }
private:
  ImageConfig config_;
};
ImageConfig imageConfigFromEnv() {
  ImageConfig c; c.provider = env("IMAGE_PROVIDER", "disabled");
  c.apiBase = c.provider == "http" ? env("IMAGE_API_URL") : env("IMAGE_API_BASE", "https://api.openai.com/v1");
  c.apiKey = env("IMAGE_API_KEY"); c.model = env("IMAGE_MODEL");
  c.size = env("IMAGE_SIZE", "auto"); c.quality = env("IMAGE_QUALITY", "auto");
  return c;
}
std::unique_ptr<ImageGenerationProvider> makeImageProvider(const ImageConfig& c) {
  if (c.provider == "mock") return std::make_unique<MockImage>();
  if (c.provider == "http") return std::make_unique<HttpImage>(c);
  if (c.provider == "gpt_image" && !c.apiKey.empty() && !c.apiBase.empty() && !c.model.empty()) return std::make_unique<GptImage>(c);
  return nullptr;
}
std::unique_ptr<ImageGenerationProvider> makeImageProvider() { return makeImageProvider(imageConfigFromEnv()); }
} // namespace acerciae::logstudio
