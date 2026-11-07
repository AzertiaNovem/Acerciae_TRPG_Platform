#pragma once
#include "../core/Db.h"
#include "../auth/AuthService.h"
#include <json/json.h>
#include <string>
#include <vector>

namespace acerciae {
class ChatService;
namespace logstudio { class CreativeService; class MediaService; }

// Illustrations in chat: a member describes a moment (pose, action, place, light), picks up to six characters as
// visual references, and the image-generation provider draws it. The platform adds its own direction, which asks the
// model to dare an unexpected viewpoint rather than a plain front view, and each character's appearance; their main
// portraits go along as identity references. When the picture is ready it is posted in the chat window as an
// out-of-character line of the requester, and only those who may read that line may load the picture.
struct IllustrationCharacter { std::string name, appearance; bool hasReference = false; };
std::string illustrationPrompt(const std::string& scene, const std::vector<IllustrationCharacter>& characters,
                               const std::string& era, const std::string& narrativeTime);
// Which attached image is whom, by name ("Reference image 1 is Ada. Mo has no reference image: …"). The image files
// carry no names; the model sees them in attachment order. "" when no character has a reference.
std::string illustrationIdentity(const std::vector<IllustrationCharacter>& characters);
// The name a saved picture gets: "illustration-2026-11-07-Ada-and-Mo-whisper-on-the-pier.png" from the line's text
// (without its "🖼️ " mark, at most 40 characters, any script kept, characters no file system takes replaced) and
// date; the extension follows the picture's type.
std::string illustrationFileName(const std::string& content, const std::string& createdAt, const std::string& mime);

class IllustrationService {
public:
    static constexpr int kMaxCharacters = 6, kMaxPromptChars = 1500, kPerHour = 20;
    IllustrationService(Db& db, AuthService& auth, ChatService& chat, logstudio::CreativeService& creative, logstudio::MediaService& media)
        : db_(db), auth_(auth), chat_(chat), creative_(creative), media_(media) {}
    // body: {prompt, character_ids[], orientation: landscape|portrait|square, allow_cloud, request_id?}
    Json::Value request(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    Json::Value jobs(const ChannelAccess& a);                              // the requester's recent illustrations here
    Json::Value cancel(const ChannelAccess& a, const std::string& jobId);  // the requester or the GM
    // The worker's hook: the finished picture is posted as the requester's line in the window.
    void posted(const Json::Value& job, const Json::Value& asset);
    // The picture of a line, for someone who may read the line. Returns false when there is none.
    // `fileName`, when given, receives the name a saved copy should have (illustrationFileName).
    bool image(const ChannelAccess& a, const std::string& messageId, std::string& bytes, std::string& mime, std::string* redirectUrl, std::string* fileName = nullptr);
private:
    Db& db_; AuthService& auth_; ChatService& chat_; logstudio::CreativeService& creative_; logstudio::MediaService& media_;
};
} // namespace acerciae
