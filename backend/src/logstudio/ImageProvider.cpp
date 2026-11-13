#include "ImageProvider.h"
#include "../core/Crypto.h"
#include "../core/Json.h"
#include "../core/NetGuard.h"
#include "../core/Log.h"
#include "MediaService.h"
#include <cstdlib>
#include <vector>
#include <curl/curl.h>
#include <drogon/utils/Utilities.h>
#include <zlib.h>
namespace acerciae::logstudio {
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
    if(json::str(req,"size")=="1024x1536") { w=180; h=320; }
    const bool transparent = json::str(req, "kind") == "standee";
    std::string raw;
    for (int y = 0; y < h; ++y) {
      raw += '\0';
      for (int x = 0; x < w; ++x) {
        bool light = ((x / 20 + y / 20) % 2) == 0;
        raw += char(light ? 160 : 45);
        raw += char(light ? static_cast<unsigned char>(hash[0]) : 35);
        raw += char(light ? 180 : 55);
        if (transparent) raw += char(x < w/8 || x >= 7*w/8 || y < h/8 || y >= 7*h/8 ? 0 : 255);
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
    ihdr += transparent ? std::string("\x08\x06\0\0\0", 5) : std::string("\x08\x02\0\0\0", 5);
    chunk(png, "IHDR", ihdr);
    chunk(png, "tEXt",
          std::string("Description\0MOCK test pattern - not AI artwork", 44));
    chunk(png, "IDAT", packed);
    chunk(png, "IEND", "");
    return {true, false, png, "image/png", ""};
  }
};
std::string ImageGenerationProvider::configurationId() const {
  return crypto::sha256Hex(name() + "\n" + model());
}
std::unique_ptr<ImageGenerationProvider> makeMockImageProvider() { return std::make_unique<MockImage>(); }
} // namespace acerciae::logstudio
