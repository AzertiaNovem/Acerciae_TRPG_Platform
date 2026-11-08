#include "Outfits.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <map>

namespace acerciae::outfits {

void present(Db& db, const std::string& channelId, Json::Value& characters) {
    const bool many = characters.isArray();
    if (!many && !characters.isObject()) return;
    std::map<std::string, Json::Value> byId;                  // outfit id → {name, avatar, version, hash}
    std::map<std::string, Json::Value> owned;                 // character id → [{id, name}]
    for (auto& o : db.queryJson("SELECT o.id, o.character_id, o.name, o.avatar_asset_id, m.version, m.content_hash FROM character_outfits o "
                                "LEFT JOIN media_assets m ON m.id=o.avatar_asset_id AND m.approval_status='approved' "
                                "WHERE o.channel_id=$1 ORDER BY o.created_at, o.id", {channelId})) {
        if (o["version"].isNull()) o["avatar_asset_id"] = Json::Value();
        Json::Value brief; brief["id"] = o["id"]; brief["name"] = o["name"];
        owned[o["character_id"].asString()].append(brief);
        byId[o["id"].asString()] = o;
    }
    auto one = [&](Json::Value& c) {
        auto list = owned.find(json::str(c, "id"));
        c["outfits"] = list == owned.end() ? Json::Value(Json::arrayValue) : list->second;
        auto it = byId.find(json::str(c, "outfit_id"));
        if (it == byId.end()) return;
        const auto& o = it->second;
        c["outfit_name"] = o["name"];
        if (!o["avatar_asset_id"].isString()) return;
        c["base_avatar_asset_id"] = c["avatar_asset_id"];
        c["avatar_asset_id"] = o["avatar_asset_id"];
        c["avatar_asset_version"] = o["version"];
        c["avatar_asset_hash"] = o["content_hash"];
    };
    if (many) { for (auto& c : characters) one(c); }
    else one(characters);
}

std::string appearance(const std::string& base, const std::string& name, const std::string& attire) {
    std::string p = text::trim(base);
    auto dress = text::trim(attire).empty() ? text::trim(name) : text::trim(attire);
    if (!dress.empty()) p += (p.empty() ? "" : ". ") + std::string("Outfit (replaces any clothing described above): ") + dress;
    return p;
}

}  // namespace acerciae::outfits
