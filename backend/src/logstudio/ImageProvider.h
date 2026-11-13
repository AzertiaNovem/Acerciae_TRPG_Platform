#pragma once
#include <json/json.h>
#include <memory>
#include <string>
#include "../ai/AiConfig.h"
namespace acerciae::logstudio {
// The image uses of a server: generation, and editing when it is assigned separately.
struct ImageConfig {
  // disabled | mock | a provider kind: openai, google, aws, alibaba, openrouter, volcengine, stability
  std::string provider = "disabled", apiBase, apiKey, model;
  std::string size = "auto", quality = "auto";
  ai::ProviderAccess access;             // the provider (plain fields and further secrets) for kinds that need them
  std::shared_ptr<ImageConfig> edit;     // image editing when set apart; null: generation also handles references
};
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
  virtual std::string configurationId() const;
  virtual ImageResult generate(const Json::Value &request) = 0;
};
// Image providers come only from a server's settings: disabled (default), mock test patterns, or a provider kind.
// Requests with reference images go to the editing provider when one is configured apart from generation.
std::unique_ptr<ImageGenerationProvider> makeImageProvider(const ImageConfig& config);
} // namespace acerciae::logstudio
