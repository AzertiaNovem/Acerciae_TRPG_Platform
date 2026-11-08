#include "Vitals.h"
#include "../core/Json.h"
#include "../dice/Dice.h"

namespace acerciae::vitals {

namespace {
// A dice value by its canonical name, however the sheet spells it (aliases and the server's languages included).
Json::Value attr(const Json::Value& attrs, const char* name) {
    if (!attrs.isObject()) return Json::Value();
    auto v = dice::lookup(attrs, name);
    return v.found && !v.isBase ? Json::Value(v.value) : Json::Value();
}
// A maximum from the card: null when the card leaves it blank (0).
Json::Value maximum(const Json::Value& v) { return v.isNumeric() && v.asInt() > 0 ? Json::Value(v.asInt()) : Json::Value(); }
}  // namespace

Json::Value of(const Json::Value& character, const std::string& ruleSystem, const Json::Value& pbtaPack) {
    Json::Value out; out["rule_system"] = ruleSystem;
    const auto& card = character["role_card"];
    if (ruleSystem == "pbta") {
        const auto& sheet = card["pbta"];
        out["resources"] = Json::Value(Json::arrayValue); out["conditions"] = Json::Value(Json::arrayValue);
        if (pbtaPack.isObject()) {
            for (const auto& r : pbtaPack["resources"]) {
                auto id = json::str(r, "id"); if (id.empty()) continue;
                Json::Value x; x["id"] = id; x["name"] = json::str(r, "name", id);
                x["value"] = sheet["resources"][id].isNumeric() ? Json::Value(sheet["resources"][id].asInt()) : Json::Value(0);
                out["resources"].append(x);
            }
            for (const auto& c : pbtaPack["conditions"]) {
                auto id = json::str(c, "id"); if (id.empty() || !json::toBool(sheet["conditions"], id.c_str(), false)) continue;
                Json::Value x; x["id"] = id; x["name"] = json::str(c, "name", id);
                out["conditions"].append(x);
            }
        }
        return out;
    }
    const auto& attrs = character["sheet"]["attrs"];
    out["hp"] = attr(attrs, "HP"); out["dex"] = attr(attrs, "DEX");
    if (ruleSystem == "dnd2024") {
        auto max = attr(attrs, "HP Max"); if (max.isNull()) max = maximum(card["dnd"]["hp_max"]);
        out["hp_max"] = max; out["ac"] = attr(attrs, "AC");
        return out;
    }
    out["hp_max"] = maximum(card["derived"]["hp_max"]);
    out["san"] = attr(attrs, "SAN"); out["san_max"] = maximum(card["derived"]["san_max"]);
    return out;
}

}  // namespace acerciae::vitals
