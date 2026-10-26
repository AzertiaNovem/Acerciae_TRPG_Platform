#include "ImageProvider.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "MediaService.h"
#include <cstdlib>
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
  std::string name() const override { return "http"; }
  std::string model() const override { return env("IMAGE_MODEL"); }
  ImageResult generate(const Json::Value &req) override {
    ImageResult r;
    auto endpoint = env("IMAGE_API_URL"), key = env("IMAGE_API_KEY");
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
};
std::unique_ptr<ImageGenerationProvider> makeImageProvider() {
  auto mode = env("IMAGE_PROVIDER", "disabled");
  if (mode == "mock")
    return std::make_unique<MockImage>();
  if (mode == "http")
    return std::make_unique<HttpImage>();
  return nullptr;
}
} // namespace acerciae::logstudio
