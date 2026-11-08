#pragma once
#include <functional>
#include "../auth/AuthService.h"
#include "../core/Db.h"
#include "ImageProvider.h"
#include <atomic>
#include <condition_variable>
#include <thread>
namespace acerciae {
class LlmGateway;
class Notifier;
class ServerSettingsService;
class AiPolicyService;
} // namespace acerciae
namespace acerciae::logstudio {
class MediaService;
class PresentationService;
class LogStudioService;
class CreativeService {
public:
  CreativeService(Db &db, MediaService &media, PresentationService &pres,
                  LogStudioService &logs, LlmGateway &llm, Notifier &n, ServerSettingsService &settings, AuthService &auth, AiPolicyService &policy)
      : db_(db), media_(media), pres_(pres), logs_(logs), llm_(llm),
        notifier_(n), settings_(settings), auth_(auth), policy_(policy) {}
  ~CreativeService() { stop(); }
  void start();
  void stop();
  Json::Value status(const ChannelAccess &a);
  Json::Value jobs(const ChannelAccess &a);
  Json::Value create(const ChannelAccess &a, const Json::Value &body);
  Json::Value cancel(const ChannelAccess &a, const std::string &id);
  Json::Value suggest(const ChannelAccess &a, const std::string &presentation,
                      const Json::Value &body);
  // A character's own portrait, avatar or subtitle standee. Allowed to the GM and the character's actor;
  // the result is approved on completion and attached to the character (params.attach). With `outfit` (a
  // character_outfits row) it is that outfit's image instead: its portrait is drawn from the base portrait (same person,
  // the outfit's attire), its avatar and poses from its own portrait (`portraitJobId` when that is being drawn too).
  Json::Value createForCharacter(const ChannelAccess &a, const Json::Value &character, const std::string &kind,
                                 const std::string &slot, const std::string &subtitle, const std::string &prompt, bool allowCloud, const std::string &portraitJobId = "", const Json::Value &outfit = Json::Value());
  // Art a visual-novel script asked for: a scene background ({presentation_id, scene_key}) or a generated-mode
  // character's subtitle portrait ({presentation_id, character_id, slot:"subtitle", subtitle}). Attached on completion.
  Json::Value createForScript(const ChannelAccess &a, const std::string &kind, const std::string &prompt, const Json::Value &attach, bool allowCloud, bool retryFailed = false);
  // An illustration for a chat window (chat/Illustrations.cpp composes the prompt and freezes the references):
  // `request` holds characters, reference_images, size and identity_instruction; `attach` names the window. Any
  // member may ask; the server's image provider and budget apply, not the Log Studio's cloud switch.
  Json::Value createIllustration(const ChannelAccess &a, const std::string &prompt, const Json::Value &request, const Json::Value &attach, bool allowCloud, const std::string &requestId);
  // Called by the worker once an illustration is stored (set by Services: posts it in the chat window).
  std::function<void(const Json::Value &job, const Json::Value &asset)> onIllustration;
  bool available(const std::string& channelId);

private:
  void loop();
  void run(const Json::Value &job);
  Db &db_;
  MediaService &media_;
  PresentationService &pres_;
  LogStudioService &logs_;
  LlmGateway &llm_;
  Notifier &notifier_;
  ServerSettingsService &settings_;
  AuthService &auth_;
  AiPolicyService &policy_;
  void usePortraitReference(const ChannelAccess &a, const std::string &characterId, Json::Value &params, const std::string &portraitJobId = "");
  // The approved image `assetId` as the job's identity reference, with the instruction the image model gets about it.
  void useImageReference(const ChannelAccess &a, const std::string &assetId, Json::Value &params, const std::string &instruction, const char *what);
  std::unique_ptr<ImageGenerationProvider> providerFor(const std::string& channelId);
  std::atomic<bool> running_{false};
  std::thread thread_;
  std::mutex mu_;
  std::condition_variable cv_;
};
} // namespace acerciae::logstudio
