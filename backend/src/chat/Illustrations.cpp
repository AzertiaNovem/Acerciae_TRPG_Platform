#include "Illustrations.h"
#include "ChatService.h"
#include "../logstudio/CreativeService.h"
#include "../logstudio/MediaService.h"
#include "../logstudio/ImageReferences.h"
#include "../knowledge/Visibility.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include "../characters/Outfits.h"
#include <set>

namespace acerciae {
namespace {
size_t utf8Chars(const std::string& s) { size_t n = 0; for (unsigned char c : s) if ((c & 0xC0) != 0x80) ++n; return n; }
constexpr size_t kReferenceBytes = 20u * 1024 * 1024;   // the image provider's limit for all references together
}

// The platform's direction around the requester's description. The image model is asked to dare an unexpected
// viewpoint instead of the plain front-facing portrait it would draw by default, while keeping every named character
// recognisable; the description itself stays the requester's.
std::string illustrationPrompt(const std::string& scene, const std::vector<IllustrationCharacter>& characters,
                               const std::string& era, const std::string& narrativeTime) {
    std::string p = "An illustration of a moment in a tabletop roleplaying campaign, drawn for its players.\n";
    p += "The moment, as described at the table (follow it for who does what, where): " + text::trim(scene) + "\n";
    if (!characters.empty()) {
        p += "Characters in the picture (show these and no other named character):\n";
        int ref = 0;
        for (const auto& c : characters) {
            p += "- " + c.name;
            auto look = text::trim(c.appearance);
            if (!look.empty()) p += ": " + text::utf8Prefix(look, 600);
            p += !c.hasReference ? " (no reference image: follow the description)"
                 : " (identity reference image " + std::to_string(++ref) + " attached" + (c.redress ? "; it shows other clothes: dress them as described here" : "") + ")";
            p += "\n";
        }
    }
    if (!text::trim(era).empty() || !text::trim(narrativeTime).empty()) {
        p += "Setting:";
        if (!text::trim(era).empty()) p += " era " + text::trim(era) + ".";
        if (!text::trim(narrativeTime).empty()) p += " Moment in the story: " + text::trim(narrativeTime) + ".";
        p += "\n";
    }
    p += "Composition: be bold and cinematic. Dare to imagine the characters from an unexpected perspective rather than a "
         "plain, front-facing portrait: a low or high angle, a view over a shoulder or from behind, a wide shot that lets the "
         "place tell the story, a close-up on hands or eyes, a tilted frame, strong depth and foreshortening. The characters "
         "need not look at the viewer; let pose, gesture, light and the surroundings carry the moment. Keep every named "
         "character recognisable from their reference image or description (face, hair, clothing, build).\n";
    p += "No text, captions, speech bubbles, watermarks or interface elements in the image.";
    return p;
}

std::string illustrationIdentity(const std::vector<IllustrationCharacter>& characters) {
    std::string mapping;
    int ref = 0;
    for (const auto& c : characters)
        mapping += !c.hasReference ? c.name + " has no reference image: follow the description. "
                 : "Reference image " + std::to_string(++ref) + " is " + c.name + (c.redress ? " (for the face and hair only: dress them as the description says, not as in the image)" : "") + ". ";
    if (!ref) return "";
    return "The attached images are identity references, in attachment order. " + mapping +
           "Keep each character's face, hairstyle, clothing and build as in their own reference, and never swap or blend two "
           "characters; pose, expression, framing and viewpoint are free.";
}

std::string illustrationFileName(const std::string& content, const std::string& createdAt, const std::string& mime) {
    std::string text = content;
    for (const std::string mark : {std::string("\xF0\x9F\x96\xBC\xEF\xB8\x8F"), std::string("\xF0\x9F\x96\xBC")})   // 🖼️ / 🖼
        if (text.rfind(mark, 0) == 0) { text = text.substr(mark.size()); break; }
    text = text::trim(text);   // as the apps' caption: the 40 characters are the description's own
    std::string slug;
    size_t chars = 0;
    for (size_t i = 0; i < text.size() && chars < 40; ) {
        unsigned char c = text[i];
        size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 1;
        std::string ch = text.substr(i, len);
        i += len; ++chars;
        bool bad = len == 1 && (c < 0x20 || c == 0x7F || std::string(" \t/\\:*?\"<>|.,;!'`#%&{}[]()=+~$@^").find((char)c) != std::string::npos);
        if (bad) { if (!slug.empty() && slug.back() != '-') slug += '-'; }
        else slug += ch;
    }
    while (!slug.empty() && slug.back() == '-') slug.pop_back();
    while (!slug.empty() && slug.front() == '-') slug.erase(slug.begin());
    std::string date = createdAt.size() >= 10 ? createdAt.substr(0, 10) : "";
    std::string ext = mime == "image/jpeg" ? ".jpg" : mime == "image/webp" ? ".webp" : ".png";
    return "illustration" + (date.empty() ? "" : "-" + date) + (slug.empty() ? "" : "-" + slug) + ext;
}

Json::Value IllustrationService::request(const ChannelAccess& a, const std::string& windowId, const Json::Value& body) {
    if (!Visibility::isUuid(windowId)) throw notFound("window not found");
    auth_.requireWindowMember(a, windowId);
    auto win = db_.queryOne("SELECT archived_at FROM chat_windows WHERE id=$1 AND channel_id=$2", {windowId, a.channelId});
    if (win.isNull()) throw notFound("window not found");
    if (!win["archived_at"].isNull()) throw conflict("This window is archived. Restore it or fork it to continue.");
    if (!a.isGm && !db_.queryOne("SELECT 1 AS paused FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2 AND visibility_paused", {windowId, a.userId}).isNull())
        throw forbidden("Your participation in this window is paused");

    auto scene = text::trim(json::str(body, "prompt"));
    if (scene.empty()) throw badRequest("describe the picture: who does what, and where");
    if (utf8Chars(scene) > (size_t)kMaxPromptChars) throw badRequest("the description is too long (at most " + std::to_string(kMaxPromptChars) + " characters)");
    auto orientation = json::str(body, "orientation", "landscape");
    std::string size = orientation == "landscape" ? "1536x1024" : orientation == "portrait" ? "1024x1536" : orientation == "square" ? "1024x1024" : "";
    if (size.empty()) throw badRequest("orientation must be landscape, portrait or square");
    if (body.isMember("character_ids") && !body["character_ids"].isArray()) throw badRequest("character_ids must be a list");
    std::vector<std::string> ids; std::set<std::string> seen;
    for (const auto& v : body["character_ids"]) {
        if (!v.isString() || !Visibility::isUuid(v.asString())) throw badRequest("invalid character id");
        if (seen.insert(v.asString()).second) ids.push_back(v.asString());
    }
    if (ids.size() > (size_t)kMaxCharacters) throw badRequest("pick at most " + std::to_string(kMaxCharacters) + " characters");
    // Each character in the outfit they wear now, unless the request picks one ({character_id: outfit_id, or "" for the
    // base look}).
    if (body.isMember("outfits") && !body["outfits"].isNull() && !body["outfits"].isObject()) throw badRequest("outfits must map character ids to outfit ids");

    // One picture in flight per person, and an hourly cap: the server's image budget is shared by the whole server.
    if (!db_.queryOne("SELECT 1 AS busy FROM asset_generation_jobs WHERE channel_id=$1 AND created_by=$2 AND kind='illustration' AND status IN ('pending','running') LIMIT 1", {a.channelId, a.userId}).isNull())
        throw conflict("your previous illustration is still being drawn");
    if (db_.queryOne("SELECT count(*) AS n FROM asset_generation_jobs WHERE channel_id=$1 AND created_by=$2 AND kind='illustration' AND created_at > now() - interval '1 hour'", {a.channelId, a.userId})["n"].asInt() >= kPerHour)
        throw ApiError(429, "rate_limited", "at most " + std::to_string(kPerHour) + " illustrations an hour; try again later");

    // The characters, each with its main portrait (or avatar) as the identity reference when it has one.
    std::vector<IllustrationCharacter> cast;
    Json::Value request, refs(Json::arrayValue), characterIds(Json::arrayValue), outfitIds(Json::arrayValue);
    size_t refBytes = 0;
    for (const auto& id : ids) {
        auto c = db_.queryOne("SELECT id, name, kind, appearance_prompt, portrait_asset_id, avatar_asset_id, outfit_id FROM characters WHERE id=$1 AND channel_id=$2", {id, a.channelId});
        if (c.isNull()) throw badRequest("character not in this channel");
        if (!a.isGm && c["kind"].asString() != "pc") throw forbidden("players may picture player characters only");
        IllustrationCharacter ic{c["name"].asString(), json::str(c, "appearance_prompt"), false};
        const bool picked = body["outfits"].isObject() && body["outfits"].isMember(id);
        if (picked && !body["outfits"][id].isNull() && !body["outfits"][id].isString()) throw badRequest("invalid outfit id");
        auto outfitId = picked ? json::str(body["outfits"], id.c_str()) : json::str(c, "outfit_id");
        Json::Value outfit;
        if (!outfitId.empty()) {
            if (Visibility::isUuid(outfitId)) outfit = db_.queryOne("SELECT id, name, attire, portrait_asset_id, avatar_asset_id FROM character_outfits WHERE id=$1 AND character_id=$2", {outfitId, id});
            if (outfit.isNull() && picked) throw badRequest("outfit not found for " + c["name"].asString());
        }
        if (!outfit.isNull()) ic.appearance = outfits::appearance(ic.appearance, outfit["name"].asString(), outfit["attire"].asString());
        // The reference: the outfit's own portrait (else avatar); without one, the base look's for the face only.
        std::vector<std::pair<std::string, bool>> candidates;   // asset id, redress
        if (!outfit.isNull()) for (const auto& slot : {"portrait_asset_id", "avatar_asset_id"}) candidates.push_back({json::str(outfit, slot), false});
        for (const auto& slot : {"portrait_asset_id", "avatar_asset_id"}) candidates.push_back({json::str(c, slot), !outfit.isNull()});
        for (const auto& [assetId, redress] : candidates) {
            if (assetId.empty()) continue;
            try {
                auto m = media_.get(a, assetId);
                if (m["approval_status"] != "approved") continue;
                std::string bytes, mime, name;
                if (!media_.fetch(a, assetId, m["version"].asInt(), bytes, mime, name)) continue;
                if ((mime != "image/png" && mime != "image/jpeg" && mime != "image/webp") || refBytes + bytes.size() > kReferenceBytes) continue;
                Json::Value ref; ref["id"] = assetId; ref["version"] = m["version"];
                refs.append(logstudio::freezeImageReference(media_.store(), a.channelId, ref, bytes, mime));
                refBytes += bytes.size(); ic.hasReference = true; ic.redress = redress;
                break;
            } catch (const ApiError&) { continue; }   // a portrait this requester may not open is simply not sent
        }
        Json::Value who; who["name"] = c["name"]; who["description"] = ic.appearance;
        if (!outfit.isNull()) who["outfit"] = outfit["name"];
        outfitIds.append(outfit.isNull() ? Json::Value("") : outfit["id"]);
        // The same numbering as the prompt's character lines and the identity instruction.
        if (ic.hasReference) who["reference_image"] = (int)refs.size(); else who["reference_image"] = "none";
        request["characters"].append(who);
        characterIds.append(id);
        cast.push_back(ic);
    }
    auto ch = db_.queryOne("SELECT c.era, s.narrative_time FROM channels c LEFT JOIN scenes s ON s.id=c.current_scene_id WHERE c.id=$1", {a.channelId});
    auto prompt = illustrationPrompt(scene, cast, json::str(ch, "era"), json::str(ch, "narrative_time"));
    request["size"] = size;
    if (refs.size()) {
        request["reference_images"] = refs;
        request["identity_instruction"] = illustrationIdentity(cast);
    }
    Json::Value attach;
    attach["window_id"] = windowId;
    attach["user_prompt"] = scene;
    attach["character_ids"] = characterIds;
    attach["outfit_ids"] = outfitIds;   // per character: the outfit drawn ("" = the base look)
    attach["orientation"] = orientation;
    auto job = creative_.createIllustration(a, prompt, request, attach, json::toBool(body, "allow_cloud", false), json::str(body, "request_id"));
    job["reference_count"] = (int)refs.size();
    return job;
}

Json::Value IllustrationService::jobs(const ChannelAccess& a) {
    return db_.queryJson(
        "SELECT id, status, error, created_at, finished_at, params->'attach'->>'window_id' AS window_id, params->'attach'->>'user_prompt' AS prompt, "
        "params->'attach'->'character_ids' AS character_ids, params->'attach'->>'orientation' AS orientation, params->'attach'->>'message_id' AS message_id, "
        "jsonb_array_length(CASE WHEN jsonb_typeof(params->'request'->'reference_images')='array' THEN params->'request'->'reference_images' ELSE '[]'::jsonb END) AS reference_count "
        "FROM asset_generation_jobs WHERE channel_id=$1 AND created_by=$2 AND kind='illustration' ORDER BY created_at DESC LIMIT 10",
        {a.channelId, a.userId});
}

Json::Value IllustrationService::cancel(const ChannelAccess& a, const std::string& jobId) {
    if (!Visibility::isUuid(jobId)) throw notFound("illustration not found");
    auto j = db_.queryOne("SELECT created_by, status FROM asset_generation_jobs WHERE id=$1 AND channel_id=$2 AND kind='illustration'", {jobId, a.channelId});
    if (j.isNull()) throw notFound("illustration not found");
    if (!a.isGm && j["created_by"].asString() != a.userId) throw forbidden("not your illustration");
    auto done = db_.queryOne("UPDATE asset_generation_jobs SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING id, status", {jobId});
    if (done.isNull()) throw conflict("this illustration is already " + j["status"].asString());
    return done;
}

void IllustrationService::posted(const Json::Value& job, const Json::Value& asset) {
    const auto& at = job["params"]["attach"];
    // The requester's own line, with their rights at this moment: a window they left gets no picture.
    auto a = auth_.channelAccess(job["created_by"].asString(), job["channel_id"].asString());
    Json::Value body;
    body["kind"] = "ooc";
    body["content"] = "\xF0\x9F\x96\xBC\xEF\xB8\x8F " + json::str(at, "user_prompt");   // "🖼️ " and the description
    auto msg = chat_.postMessage(a, json::str(at, "window_id"), body, Json::Value(), asset["id"].asString());
    db_.exec("UPDATE asset_generation_jobs SET params=jsonb_set(params, '{attach,message_id}', to_jsonb($2::text)) WHERE id=$1", {job["id"].asString(), msg["id"].asString()});
}

bool IllustrationService::image(const ChannelAccess& a, const std::string& messageId, std::string& bytes, std::string& mime, std::string* redirectUrl, std::string* fileName) {
    if (!Visibility::isUuid(messageId)) return false;
    auto m = chat_.getMessage(a, messageId);   // 404 for a line this reader may not read (or a recalled one)
    auto id = json::str(m, "media_asset_id");
    if (id.empty()) return false;
    ChannelAccess reader = a; reader.isGm = true;   // the picture follows its line, not the media library's scope
    std::string name;
    if (!media_.fetch(reader, id, 0, bytes, mime, name, redirectUrl)) return false;
    if (fileName) *fileName = illustrationFileName(m["content"].asString(), m["created_at"].asString(), mime);
    return true;
}
} // namespace acerciae
