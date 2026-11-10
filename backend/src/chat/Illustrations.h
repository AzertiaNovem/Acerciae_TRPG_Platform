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
// A member may also upload a picture of their own (a handout, a map, a photo of a prop): it is posted as their line
// like a text line would be, with an optional caption, and is served the same way. That needs no image AI.
// `redress`: the reference image shows the character in other clothes than they wear in the picture (an outfit with no
// image of its own yet), so it is for the face and hair only and the description says what they wear.
struct IllustrationCharacter { std::string name, appearance; bool hasReference = false; bool redress = false; };
std::string illustrationPrompt(const std::string& scene, const std::vector<IllustrationCharacter>& characters,
                               const std::string& era, const std::string& narrativeTime);
// Which attached image is whom, by name ("Reference image 1 is Ada. Mo has no reference image: …"). The image files
// carry no names; the model sees them in attachment order. "" when no character has a reference.
std::string illustrationIdentity(const std::vector<IllustrationCharacter>& characters);
// The name a saved picture gets: "illustration-2026-11-07-Ada-and-Mo-whisper-on-the-pier.png" from the line's text
// (without its "🖼️ " mark, at most 40 characters, any script kept, characters no file system takes replaced) and
// date; the extension follows the picture's type. An uploaded picture is named "picture-…" (`prefix`).
std::string illustrationFileName(const std::string& content, const std::string& createdAt, const std::string& mime, const std::string& prefix = "illustration");
// The text of a picture's line: the "🖼️" mark, then the caption when there is one.
std::string pictureLine(const std::string& caption);

class IllustrationService {
public:
    static constexpr int kMaxCharacters = 6, kMaxPromptChars = 1500, kPerHour = 20;
    static constexpr int kMaxUploadBytes = 10 * 1024 * 1024, kMaxCaptionChars = 2000, kUploadsPerHour = 60;
    IllustrationService(Db& db, AuthService& auth, ChatService& chat, logstudio::CreativeService& creative, logstudio::MediaService& media)
        : db_(db), auth_(auth), chat_(chat), creative_(creative), media_(media) {}
    // body: {prompt, character_ids[], orientation: landscape|portrait|square, allow_cloud, request_id?}
    Json::Value request(const ChannelAccess& a, const std::string& windowId, const Json::Value& body);
    Json::Value jobs(const ChannelAccess& a);                              // the requester's recent illustrations here
    Json::Value cancel(const ChannelAccess& a, const std::string& jobId);  // the requester or the GM
    // The worker's hook: the finished picture is posted as the requester's line in the window.
    void posted(const Json::Value& job, const Json::Value& asset);
    // A picture the member uploads (PNG, JPEG, WebP or GIF, told by its content): stored as the channel's private
    // chat art and posted in the window as their line. fields, as for a text line: content (the caption, optional),
    // kind (ic | ooc | narration), character_id, and for the GM visibility and whisper_to (comma-separated).
    Json::Value upload(const ChannelAccess& a, const std::string& windowId, const std::string& fileName, const std::string& bytes, const Json::Value& fields);
    // After a recall: a picture its author uploaded is deleted with its line (a drawn one stays in the GM's library).
    void recalled(const ChannelAccess& a, const Json::Value& tombstone);
    // The picture of a line, for someone who may read the line. Returns false when there is none.
    // `fileName`, when given, receives the name a saved copy should have (illustrationFileName).
    bool image(const ChannelAccess& a, const std::string& messageId, std::string& bytes, std::string& mime, std::string* redirectUrl, std::string* fileName = nullptr);
private:
    void requireOpenWindow(const ChannelAccess& a, const std::string& windowId);   // a member's, not archived, not paused for them
    Db& db_; AuthService& auth_; ChatService& chat_; logstudio::CreativeService& creative_; logstudio::MediaService& media_;
};
} // namespace acerciae
