#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
namespace acerciae {
class LlmGateway;
class ServerSettingsService;
namespace logstudio {
class MediaService;
}
class AtmosphereService {
public:
  AtmosphereService(Db &db, LlmGateway &llm, ServerSettingsService &settings,
                    logstudio::MediaService &media)
      : db_(db), llm_(llm), settings_(settings), media_(media) {}
  void afterBatch(const std::string &channelId, const Json::Value &batch);
  Json::Value current(const ChannelAccess &a);
  Json::Value history(const ChannelAccess &a);
  bool fetch(const ChannelAccess &a, const std::string &assetId,
             std::string &bytes, std::string &mime);
  static Json::Value schema();

private:
  bool enabled(const std::string &channelId);
  Db &db_;
  LlmGateway &llm_;
  ServerSettingsService &settings_;
  logstudio::MediaService &media_;
};
} // namespace acerciae
