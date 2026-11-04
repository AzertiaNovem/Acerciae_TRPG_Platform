#include "Pbta.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <regex>
#include <set>
#include <sstream>

namespace acerciae::pbta {
namespace {
using J = Json::Value;
void require(bool ok, const std::string &why) {
  if (!ok)
    throw badRequest(why);
}
const J *findId(const J &rows, const J &id) {
  for (const auto &item : rows)
    if (item["id"] == id)
      return &item;
  return nullptr;
}
void label(const J &v, size_t limit, const std::string &what) {
  require(v.isString() && !text::trim(v.asString()).empty() &&
              v.asString().size() <= limit,
          "Invalid " + what);
}
void validate(const J &p) {
  require(p.isObject() && p["schemaVersion"] == 1 &&
              json::dump(p).size() <= 128 * 1024,
          "Invalid PbtA pack version or size");
  const std::set<std::string> fields = {
      "schemaVersion", "name",      "books", "moves",     "gmMoves",
      "bands",         "resources", "stats", "conditions"};
  for (const auto &key : p.getMemberNames())
    require(fields.count(key), "Unknown pack field: " + key);
  label(p["name"], 160, "pack name");
  static const std::regex id("[a-z][a-z0-9_-]{0,39}");
  for (const auto key : {"stats", "books", "resources", "conditions", "moves",
                         "bands", "gmMoves"}) {
    const auto &rows = p[key];
    require(rows.isArray() && rows.size() <= 120,
            std::string("Invalid list: ") + key);
    std::set<std::string> ids;
    for (const auto &r : rows) {
      require(r.isObject() && r["id"].isString(), "Missing definition ID");
      const auto k = r["id"].asString();
      require(std::regex_match(k, id) && k != "constructor" &&
                  k != "prototype" && ids.insert(k).second,
              "Invalid or duplicate ID: " + k);
      label(r["name"], 160, k + " name");
    }
  }
  require(!p["books"].empty() && !p["stats"].empty() && !p["bands"].empty(),
          "A pack needs playbooks, stats and outcome bands");
  int next = 0;
  for (Json::ArrayIndex i = 0; i < p["bands"].size(); ++i) {
    const auto &b = p["bands"][i];
    const auto &lo = b["min"];
    const auto &hi = b["max"];
    require(b.isMember("min") && b.isMember("max") &&
                (i == 0 ? lo.isNull() : lo.isInt() && lo.asInt() == next),
            "Outcome bands must be contiguous from an open lower bound");
    require(i + 1 == p["bands"].size()
                ? hi.isNull()
                : hi.isInt() && std::abs(hi.asDouble()) <= 10000 &&
                      (lo.isNull() || hi.asInt() >= next),
            "Invalid outcome upper bound");
    if (hi.isInt())
      next = hi.asInt() + 1;
  }
  for (const auto &m : p["moves"]) {
    label(m["trigger"], 2400, "move trigger");
    require(m["book"].isString() &&
                (m["book"] == "" || findId(p["books"], m["book"])),
            "Unknown move playbook");
    require(m["stat"].isString() &&
                (m["stat"] == "" || findId(p["stats"], m["stat"])),
            "Unknown move stat");
    const auto &outcomes = m["outcomes"];
    require(outcomes.isObject() &&
                outcomes.size() == (m["stat"] == "" ? 0u : p["bands"].size()),
            "Move outcomes must match the bands");
    if (m["stat"] != "")
      for (const auto &b : p["bands"])
        label(outcomes[b["id"].asString()], 2400, "move outcome");
  }
  for (const auto &m : p["gmMoves"])
    label(m["text"], 2400, "GM move");
}
bool usesRemoved(const J &c, const J &before, const J &after) {
  if (!findId(after["books"], c["book"]))
    return true;
  for (const auto key : {"stats", "resources", "conditions"})
    for (const auto &id : c[key].getMemberNames())
      if (!findId(after[key], id))
        return true;
  for (const auto &m : before["moves"])
    if (m["book"] == c["book"]) {
      auto n = findId(after["moves"], m["id"]);
      if (!n || ((*n)["book"] != "" && (*n)["book"] != c["book"]))
        return true;
    }
  return false;
}
} // namespace
Json::Value lockedPack(pqxx::work &w, const std::string &channel) {
  auto r = Db::queryOne(
      w,
      "SELECT revision,pack FROM pbta_packs JOIN channels ON id=channel_id "
      "WHERE channel_id=$1 AND rule_system='pbta' FOR SHARE",
      {channel});
  if (r.isNull())
    throw conflict("Select PbtA in the channel rules first");
  return r;
}
Json::Value read(Db &db, const ChannelAccess &a) {
  auto row = db.tx([&](pqxx::work &w) { return lockedPack(w, a.channelId); });
  if (!a.isGm)
    row["pack"].removeMember("gmMoves");
  return row;
}
Json::Value preview(const ChannelAccess &a, const J &pack) {
  if (!a.isGm)
    throw forbidden("Only the GM can import rules");
  validate(pack);
  return pack;
}
Json::Value replace(Db &db, const ChannelAccess &a, const J &body) {
  if (!a.isGm)
    throw forbidden("Only the GM can edit the rules");
  require(body.isObject() && body["revision"].isInt(),
          "Expected a pack revision");
  const auto &pack = body["pack"];
  validate(pack);
  return db.tx([&](pqxx::work &w) {
    auto old =
        Db::queryOne(w,
                     "SELECT revision,pack FROM pbta_packs JOIN channels ON "
                     "id=channel_id WHERE channel_id=$1 AND rule_system='pbta' "
                     "FOR UPDATE OF pbta_packs FOR SHARE OF channels",
                     {a.channelId});
    if (old.isNull() || old["revision"] != body["revision"])
      throw conflict("Rules changed. Reload before saving.");
    std::vector<std::string> affected;
    for (const auto &c :
         Db::queryJson(w,
                       "SELECT name,role_card->'pbta' AS card FROM characters "
                       "WHERE channel_id=$1 AND role_card ? 'pbta'",
                       {a.channelId}))
      if (usesRemoved(c["card"], old["pack"], pack))
        affected.push_back(c["name"].asString());
    if (!affected.empty())
      throw conflict("Definitions in use by: " + text::join(affected, ", "));
    return Db::queryOne(
        w,
        "UPDATE pbta_packs SET pack=$2::jsonb,revision=revision+1 WHERE "
        "channel_id=$1 RETURNING revision,pack",
        {a.channelId, json::dump(pack)});
  });
}
Json::Value normalizeCard(const J &c, const J &p) {
  require(c.isObject() && findId(p["books"], c["book"]), "Choose a playbook");
  J out;
  out["book"] = c["book"];
  for (const auto key : {"stats", "resources", "conditions"}) {
    const auto &values = c[key];
    require(values.isNull() || values.isObject(), "Invalid card field");
    for (const auto &id : values.getMemberNames())
      require(findId(p[key], id), "Unknown card field: " + id);
    out[key] = J(Json::objectValue);
    for (const auto &field : p[key]) {
      const auto id = field["id"].asString();
      if (!values.isMember(id))
        continue;
      const bool flag = std::string(key) == "conditions";
      const auto v = values.get(id, flag ? J(false) : J(0));
      require(flag ? v.isBool() : v.isInt() && std::abs(v.asDouble()) <= 9999,
              "Invalid value for " + id);
      out[key][id] = v;
    }
  }
  return out;
}
Json::Value resolve(const J &row, const J &card, const std::string &args,
                    dice::Rng &rng) {
  std::istringstream in(args);
  std::string id, mod, extra;
  in >> id >> mod >> extra;
  const auto &pack = row["pack"];
  const auto *m = findId(pack["moves"], id);
  require(card.isObject() && findId(pack["books"], card["book"]),
          "Choose and save your playbook first");
  require(m && ((*m)["book"] == "" || (*m)["book"] == card["book"]),
          "Move unavailable for this character");
  static const std::regex modifier("[+-]?[0-9]{1,2}");
  require(extra.empty() && (mod.empty() || std::regex_match(mod, modifier)),
          "Usage: .move <id> [+/-modifier]");
  J d;
  d["type"] = "pbta_move";
  d["revision"] = row["revision"];
  d["move_id"] = id;
  d["name"] = (*m)["name"];
  d["trigger"] = (*m)["trigger"];
  std::string line = d["name"].asString() + " · " + d["trigger"].asString();
  if ((*m)["stat"] != "") {
    const auto stat = (*m)["stat"].asString();
    const int attr = card["stats"].get(stat, 0).asInt(),
              bonus = mod.empty() ? 0 : std::stoi(mod);
    const int first = rng.roll(6), second = rng.roll(6),
              total = first + second + attr + bonus;
    d["rolls"].append(first);
    d["rolls"].append(second);
    d["stat_id"] = stat;
    d["stat_name"] = (*findId(pack["stats"], stat))["name"];
    d["stat_value"] = attr;
    d["modifier"] = bonus;
    d["total"] = total;
    line += "\n2d6 (" + std::to_string(first) + ", " + std::to_string(second) +
            ") + " + d["stat_name"].asString() + " (" + std::to_string(attr) +
            ") + (" + std::to_string(bonus) + ") = " + std::to_string(total);
    for (const auto &b : pack["bands"])
      if ((b["min"].isNull() || total >= b["min"].asInt()) &&
          (b["max"].isNull() || total <= b["max"].asInt())) {
        d["band"] = b;
        d["outcome"] = (*m)["outcomes"][b["id"].asString()];
        line += "\n" + b["name"].asString() + " · " + d["outcome"].asString();
        break;
      }
  } else
    require(mod.empty(), "A diceless move takes no modifier");
  d["text"] = line;
  return d;
}
void addContext(Db &db, const ChannelAccess &a, const std::string &character,
                J &ctx) {
  auto row = db.queryOne(
      "SELECT p.pack,c.role_card->'pbta'->>'book' AS book FROM pbta_packs p "
      "JOIN channels ch ON ch.id=p.channel_id AND ch.rule_system='pbta' LEFT "
      "JOIN characters c ON c.channel_id=ch.id AND c.id=NULLIF($2,'')::uuid "
      "WHERE ch.id=$1",
      {a.channelId, character});
  if (row.isNull())
    return;
  auto &data = ctx["pbta_rules"];
  data["game"] = row["pack"]["name"];
  data["bands"] = row["pack"]["bands"];
  for (const auto &m : row["pack"]["moves"])
    if (a.isGm || m["book"] == "" || m["book"] == row["book"])
      data["moves"].append(m);
  if (a.isGm)
    data["gmMoves"] = row["pack"]["gmMoves"];
}
} // namespace acerciae::pbta
