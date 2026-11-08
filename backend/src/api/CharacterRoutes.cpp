#include "../app/Services.h"
#include "../chat/ChatService.h"
#include "../characters/CharacterSpaceService.h"
#include "../characters/Coc7Rules.h"
#include "../characters/Dnd2024Rules.h"
#include "../dice/DiceService.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include <drogon/drogon.h>
#include <drogon/MultiPart.h>

#include "RouteSupport.h"
#include "Routes.h"
using namespace drogon;
namespace acerciae::http {
void registerCharacterRoutes() {
    auto& S = services();
    route1("/api/channels/{1}/characters", {Get}, [&](auto&, auto& p, auto& a) { return S.chat->listCharacters(access(p, a[0])); });
    route1("/api/channels/{1}/characters", {Post}, [&](auto& req, auto& p, auto& a) { return S.chat->createCharacter(access(p, a[0]), body(req)); });
    route2("/api/channels/{1}/characters/{2}", {Put}, [&](auto& req, auto& p, auto& a) { return S.chat->updateCharacter(access(p, a[0]), a[1], body(req)); });
    // ---- character space ----
    route2("/api/channels/{1}/characters/{2}/space", {Get}, [&](auto&, auto& p, auto& a) { return S.characterSpace->space(access(p, a[0]), a[1]); });
    // COC7 point-buy reference: skills with bases, specialisation families, the 230 careers of the community sheet.
    route0("/api/coc7/rules", {Get}, [&](auto&, auto&, auto&) { return coc7::rules(); });
    route0("/api/dnd/rules", {Get}, [&](auto&, auto&, auto&) { return dnd2024::rules(); });
    route2("/api/channels/{1}/characters/{2}/card", {Put}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->updateCard(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/characters/{2}/appearance", {Put}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->updateAppearance(access(p, a[0]), a[1], body(req)); });
    route2("/api/channels/{1}/characters/{2}/assets", {Post}, [&](auto& req, auto& p, auto& a) {
        auto ac = access(p, a[0]); MultiPartParser mp;
        if (mp.parse(req) != 0 || mp.getFiles().empty()) throw badRequest("multipart upload with a 'file' field required");
        auto& f = mp.getFiles()[0]; auto& ps = mp.getParameters();
        return S.characterSpace->uploadAsset(ac, a[1], ps.count("slot") ? ps.at("slot") : "portrait", ps.count("subtitle") ? ps.at("subtitle") : "", f.getFileName(), std::string(f.fileContent()));
    });
    route2("/api/channels/{1}/characters/{2}/assets/generate", {Post}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->generate(access(p, a[0]), a[1], body(req)); });
    route3("/api/channels/{1}/characters/{2}/assets/{3}", {Delete}, [&](auto&, auto& p, auto& a) { return S.characterSpace->removeAsset(access(p, a[0]), a[1], a[2]); });
    // Outfits of a generated character, and the one worn now.
    route2("/api/channels/{1}/characters/{2}/outfits", {Post}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->createOutfit(access(p, a[0]), a[1], body(req)); });
    route3("/api/channels/{1}/characters/{2}/outfits/{3}", {Put}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->updateOutfit(access(p, a[0]), a[1], a[2], body(req)); });
    route3("/api/channels/{1}/characters/{2}/outfits/{3}", {Delete}, [&](auto&, auto& p, auto& a) { return S.characterSpace->deleteOutfit(access(p, a[0]), a[1], a[2]); });
    route3("/api/channels/{1}/characters/{2}/outfits/{3}/generate", {Post}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->generateOutfit(access(p, a[0]), a[1], a[2], body(req)); });
    route2("/api/channels/{1}/characters/{2}/outfit", {Put}, [&](auto& req, auto& p, auto& a) { return S.characterSpace->wear(access(p, a[0]), a[1], body(req)); });
    // Numbers of an earlier rule system, archived when the GM switched the rules, back on the card (same system only).
    route3("/api/channels/{1}/characters/{2}/card-archives/{3}/restore", {Post}, [&](auto&, auto& p, auto& a) { return S.characterSpace->restoreArchive(access(p, a[0]), a[1], a[2]); });
    route2("/api/channels/{1}/characters/{2}/attributes", {Get}, [&](auto&, auto& p, auto& a) { return S.dice->getAttributes(access(p, a[0]), a[1]); });
    route2("/api/channels/{1}/characters/{2}/attributes", {Put}, [&](auto& req, auto& p, auto& a) { return S.dice->updateAttributes(access(p, a[0]), a[1], body(req)); });
    route1("/api/channels/{1}/dice/preview", {Post}, [&](auto& req, auto& p, auto& a) { auto b = body(req); return S.dice->preview(access(p, a[0]), json::str(b, "chat_window_id"), json::str(b, "character_id"), json::str(b, "content")); });


}
}
