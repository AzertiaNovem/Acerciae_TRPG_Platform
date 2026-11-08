#include "ChatService.h"
#include "../characters/CharacterSpaceService.h"
#include "../events/EventStore.h"
#include "../scenes/SceneManager.h"
#include "../ws/Notifier.h"
#include "../documents/DocumentService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"
#include "../dice/Dice.h"
#include "../dice/DiceService.h"
#include "../core/Text.h"
#include "../core/Crypto.h"
#include "../rules/RuleSystem.h"
#include "../rules/PbtaRuling.h"
#include "../core/Log.h"
#include "Recall.h"

#include "ChatQueries.h"
namespace acerciae {
using namespace chatQueries;
Json::Value ChatService::listCharacters(const ChannelAccess& a) {
    // Players see all PC names (table knowledge) but GM-only NPC sheets stay hidden.
    std::string sql = "SELECT c.*, u.display_name AS player_name, av.version AS avatar_asset_version, av.content_hash AS avatar_asset_hash FROM characters c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN media_assets av ON av.id=c.avatar_asset_id WHERE c.channel_id=$1";
    if (!a.isGm) sql += " AND c.kind='pc'";
    sql += " ORDER BY c.kind, c.created_at";
    return db_.queryJson(sql, {a.channelId});
}
Json::Value ChatService::createCharacter(const ChannelAccess& a, const Json::Value& body) {
    auto name = json::requireStr(body, "name");
    auto kind = json::str(body, "kind", "pc");
    if (kind != "pc" && kind != "npc") throw badRequest("kind must be pc or npc");
    std::string ownerId = a.userId;
    if (kind == "npc") { auth_.requireGm(a); ownerId.clear(); }
    else if (a.isGm && !json::str(body, "user_id").empty()) ownerId = json::str(body, "user_id");
    auto sheet = dice::normalizeSheet(body.isMember("sheet") && body["sheet"].isObject() ? body["sheet"] : Json::Value(Json::objectValue));
    sheet.removeMember("rule_attrs");
    return db_.tx([&](pqxx::work& w) {
        if (!sheet["attrs"].empty() && Db::queryOne(w, "SELECT rule_system FROM channels WHERE id=$1 FOR SHARE", {a.channelId})["rule_system"] == "pbta")
            throw badRequest("Create the character and select a PbtA playbook");
        auto c = Db::queryOne(w, "INSERT INTO characters(channel_id, user_id, name, kind, speaking_style, sheet) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",
            {a.channelId, ownerId.empty() ? dbNull() : DbParam(ownerId), name, kind, json::str(body, "speaking_style"), json::dump(sheet)});
        // A PC owned by a GM account (a "GM-cast" PC, such as an AI co-player) is voiced by the GM like an NPC: the
        // GM's own window memberships stay unbound, or every window the GM sits in would count it as present.
        bool gmCast = ownerId.empty() ? false : ownerId == a.userId ? a.isGm
            : !Db::queryOne(w, "SELECT 1 AS ok FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND role='gm'", {a.channelId, ownerId}).isNull();
        if (kind == "pc" && !ownerId.empty() && !gmCast) {
            // Bind the character to the windows its player is already in and has no character yet.
            Db::exec(w, "UPDATE chat_window_members wm SET character_id=$2 FROM chat_windows cw WHERE cw.id=wm.chat_window_id AND cw.channel_id=$1 AND wm.user_id=$3 AND wm.character_id IS NULL",
                {a.channelId, c["id"].asString(), ownerId});
        }
        Db::exec(w, "INSERT INTO entities(channel_id, kind, name, character_id, description) VALUES($1,$2,$3,$4,$5) ON CONFLICT (channel_id, kind, name) WHERE player_group_id IS NULL DO UPDATE SET character_id=EXCLUDED.character_id",
            {a.channelId, kind, name, c["id"].asString(), json::str(body, "description")});
        return c;
    });
}
Json::Value ChatService::updateCharacter(const ChannelAccess& a, const std::string& characterId, const Json::Value& body) {
    return db_.tx([&](pqxx::work& w) {
        const bool writeSheet = body["sheet"].isObject();
        if (writeSheet) {
            auto channel = Db::queryOne(w, "SELECT rule_system FROM channels WHERE id=$1 FOR SHARE", {a.channelId});
            if (channel["rule_system"] == "pbta") throw badRequest("Use the PbtA character card");
        }
        auto cur = Db::queryOne(w, "SELECT * FROM characters WHERE id=$1 AND channel_id=$2 FOR UPDATE", {characterId, a.channelId});
        if (cur.isNull()) throw notFound("character not found");
        if (!a.isGm && cur["user_id"] != a.userId) throw forbidden("not your character");
        auto sheet = cur["sheet"];
        if (writeSheet) {
            sheet = dice::normalizeSheet(body["sheet"]);
            sheet.removeMember("rule_attrs");
            if (cur["sheet"].isMember("rule_attrs")) sheet["rule_attrs"] = cur["sheet"]["rule_attrs"];
        }
        return Db::queryOne(w, "UPDATE characters SET name=$3, speaking_style=$4, sheet=$5::jsonb WHERE id=$1 AND channel_id=$2 RETURNING *",
            {characterId, a.channelId, json::str(body, "name", cur["name"].asString()), json::str(body, "speaking_style", cur["speaking_style"].asString()), json::dump(sheet)});
    });
}

// ---- windows ---------------------------------------------------------------------------------
// A scoped ancestry walk: each edge freezes its parent's history at fork_seq. Message IDs and
// original window IDs survive pagination, quoting and export. Visibility is checked separately.


} // namespace acerciae
