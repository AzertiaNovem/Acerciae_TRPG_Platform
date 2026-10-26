#pragma once
#include <json/json.h>
#include <memory>
#include <string>
namespace acerciae::logstudio {
struct ImageResult {
  bool ok = false;
  bool retryable = false;
  std::string bytes, mime, error;
};
class ImageGenerationProvider {
public:
  virtual ~ImageGenerationProvider() = default;
  virtual std::string name() const = 0;
  virtual std::string model() const = 0;
  virtual ImageResult generate(const Json::Value &request) = 0;
};
std::unique_ptr<ImageGenerationProvider> makeImageProvider();
} // namespace acerciae::logstudio
