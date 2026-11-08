#pragma once
#include "../core/Db.h"
#include <json/json.h>
#include <string>

// Outfits (character_outfits): a generated character's other clothes, each with its own avatar, portrait and poses.
namespace acerciae::outfits {

constexpr int kMaxPerCharacter = 8;
constexpr size_t kMaxNameBytes = 120, kMaxAttireBytes = 2000;

// What characters look like in the chat now. For each character (rows of `characters`, one object or an array) whose
// worn outfit has an avatar, `avatar_asset_id` with its `avatar_asset_version` and `avatar_asset_hash` become the
// outfit's and the base avatar moves to `base_avatar_asset_id`; `outfit_name` names the worn outfit. Each also gets
// `outfits`: [{id, name}], the outfits it can wear.
void present(Db& db, const std::string& channelId, Json::Value& characters);

// The appearance an image model gets for an outfit: the character's appearance with the outfit's attire in place of
// any clothing it describes.
std::string appearance(const std::string& base, const std::string& name, const std::string& attire);

}  // namespace acerciae::outfits
