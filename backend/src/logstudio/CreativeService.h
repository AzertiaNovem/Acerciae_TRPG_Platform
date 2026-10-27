#pragma once
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include "ImageProvider.h"
#include <atomic>
#include <condition_variable>
#include <thread>
namespace acerciae {
class LlmGateway;
class Notifier;
} // namespace acerciae
namespace acerciae::logstudio {
class MediaService;
class PresentationService;
class LogStudioService;
class CreativeService {
public:
  CreativeService(Db &db, MediaService &media, PresentationService &pres,
                  LogStudioService &logs, LlmGateway &llm, Notifier &n)
      : db_(db), media_(media), pres_(pres), logs_(logs), llm_(llm),
        notifier_(n), provider_(makeImageProvider()) {}
  ~CreativeService() { stop(); }
  void start();
  void stop();
  Json::Value status(const ChannelAccess &a);
  Json::Value jobs(const ChannelAccess &a);
  Json::Value create(const ChannelAccess &a, const Json::Value &body);
  Json::Value cancel(const ChannelAccess &a, const std::string &id);
  Json::Value suggest(const ChannelAccess &a, const std::string &presentation,
                      const Json::Value &body);
  // A character's own portrait, avatar or subtitle standee. Allowed to the Keeper and the character's actor;
  // the result is approved on completion and attached to the character (params.attach).
  Json::Value createForCharacter(const ChannelAccess &a, const Json::Value &character, const std::string &kind,
                                 const std::string &slot, const std::string &subtitle, const std::string &prompt, bool allowCloud);
  // Art a visual-novel script asked for: a scene background ({presentation_id, scene_key}) or a generated-mode
  // character's subtitle portrait ({presentation_id, character_id, slot:"subtitle", subtitle}). Attached on completion.
  Json::Value createForScript(const ChannelAccess &a, const std::string &kind, const std::string &prompt, const Json::Value &attach, bool allowCloud);
  bool available() const { return provider_ != nullptr; }

private:
  void loop();
  void run(const Json::Value &job);
  Db &db_;
  MediaService &media_;
  PresentationService &pres_;
  LogStudioService &logs_;
  LlmGateway &llm_;
  Notifier &notifier_;
  std::unique_ptr<ImageGenerationProvider> provider_;
  std::atomic<bool> running_{false};
  std::thread thread_;
  std::mutex mu_;
  std::condition_variable cv_;
};
} // namespace acerciae::logstudio
