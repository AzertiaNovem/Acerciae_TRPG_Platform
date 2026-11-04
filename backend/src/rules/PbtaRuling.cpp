#include "PbtaRuling.h"
#include "../core/Errors.h"
#include "../core/Json.h"
#include "../knowledge/Visibility.h"

namespace acerciae::pbta {
using J = Json::Value;
namespace {
std::string id(const J &b, const char *key) {
  auto v = json::str(b, key);
  if (!Visibility::isUuid(v))
    throw badRequest(std::string("Invalid ") + key);
  return v;
}
J frozen(const J &card, const std::string &section, const std::string &key) {
  return card[section].get(key, section == "conditions" ? J(false) : J(0));
}
} // namespace
J rulingHistory(Db &db, const ChannelAccess &a, const std::string &window,
                int64_t before) {
  if (!a.isGm)
    throw forbidden("Only the GM can read ruling records");
  return db.queryJson(R"SQL(
    SELECT r.roll_id, r.intent_id, r.question_id, q.content AS question, r.card AS initial_card,
           m.seq, m.character_id, m.dice,
           coalesce((SELECT jsonb_agg(jsonb_build_object(
              'section', k.section, 'field', k.field, 'message_id', receipt.id, 'change', receipt.content,
              'answer_id', answer.id, 'answer', answer.content) ORDER BY receipt.seq)
             FROM pbta_marks k JOIN messages receipt ON receipt.id=k.message_id
             LEFT JOIN messages answer ON answer.id=receipt.reference_ids[2]
             WHERE k.roll_id=r.roll_id), '[]'::jsonb) AS marks
    FROM pbta_rulings r JOIN messages m ON m.id=r.roll_id
    LEFT JOIN messages q ON q.id=r.question_id
    WHERE m.channel_id=$1 AND m.chat_window_id=$2 AND ($3::bigint=0 OR m.seq<$3)
    ORDER BY m.seq DESC LIMIT 30
  )SQL",
                      {a.channelId, window, before});
}

Ruling prepareRuling(pqxx::work &w, const ChannelAccess &a,
                     const std::string &window, const std::string &actor,
                     const J &request, const std::string &move,
                     const std::string &visibility,
                     const std::vector<std::string> &recipients) {
  auto rules = lockedPack(w, a.channelId);
  auto c = Db::queryOne(w,
                        "SELECT name,user_id,role_card->'pbta' AS card FROM "
                        "characters WHERE id=$1 AND channel_id=$2 FOR UPDATE",
                        {actor, a.channelId});
  if (c.isNull() || (!a.isGm && c["user_id"] != a.userId))
    throw forbidden("Not your character");
  Ruling r;
  r.card = c["card"];
  r.op = json::str(request, "op", "manual");
  if (r.op == "declare") {
    if (c["user_id"] != a.userId)
      throw forbidden("Only the host's own co-player can declare an action");
    r.intent = id(request, "source_id");
    r.source = Db::queryOne(w,
                            "SELECT * FROM messages WHERE id=$1 AND "
                            "chat_window_id=$2 AND visibility='window'",
                            {r.intent, window});
    if (r.source.isNull())
      throw badRequest("Missing public cue in this window");
    auto existing =
        Db::queryOne(w,
                     "SELECT message_id,command FROM pbta_declarations "
                     "WHERE anchor_id=$1 AND character_id=$2",
                     {r.intent, actor});
    r.repeated = json::str(existing, "message_id");
    if (!r.repeated.empty()) {
      r.command = existing["command"];
      return r;
    }
    if (request["revision"] != rules["revision"])
      throw conflict("Rules changed. Read the current moves.");
    const auto modifier = request.get("modifier", 0);
    if (!modifier.isInt() || modifier.asInt() < -99 || modifier.asInt() > 99)
      throw badRequest("Invalid move modifier");
    const auto &moves = rules["pack"]["moves"];
    bool available = false;
    for (const auto &m : moves)
      if (m["id"] == request["move_id"] && r.card["book"].isString() &&
          (m["book"] == "" || m["book"] == r.card["book"]) &&
          (m["stat"] != "" || modifier == 0))
        available = true;
    if (!available)
      throw badRequest("This character cannot declare that move");
    r.command["move_id"] = request["move_id"];
    r.command["modifier"] = modifier;
    r.command["revision"] = rules["revision"];
    r.refs = {r.intent};
    r.text = json::requireStr(request, "text");
    if (r.text.size() > 4000)
      throw badRequest("Declaration too long");
    return r;
  }
  if (r.op == "manual" || r.op == "move") {
    if (r.op == "move") {
      r.intent = id(request, "source_id");
      r.source = Db::queryOne(
          w,
          "SELECT * FROM messages WHERE id=$1 AND chat_window_id=$2 AND "
          "character_id=$3 AND kind='ic' "
          "AND (author_id=$4 OR author_id=$5 AND $4::uuid IS NULL)",
          {r.intent, window, actor,
           c["user_id"].isNull() ? dbNull() : DbParam(c["user_id"].asString()),
           a.userId});
      if (r.source.isNull())
        throw badRequest(
            "The move needs that character's own declaration in this window");
      r.refs = {r.intent};
    } else {
      // A player's normal .move after a declaration and the host action share
      // its intent.
      auto source = Db::queryOne(
          w,
          "SELECT id FROM messages WHERE chat_window_id=$1 AND character_id=$2 "
          "AND kind='ic' "
          "AND visibility=$3 AND whisper_to=$4::uuid[] AND "
          "author_id=coalesce($5::uuid,$6::uuid) ORDER BY seq DESC LIMIT 1",
          {window, actor, visibility, pgArrayLiteral(recipients),
           c["user_id"].isNull() ? dbNull() : DbParam(c["user_id"].asString()),
           a.userId});
      r.intent = json::str(source, "id");
    }
    if (!r.intent.empty()) {
      auto old = Db::queryOne(w,
                              "SELECT m.id FROM pbta_rulings p JOIN messages m "
                              "ON m.id=p.roll_id WHERE intent_id=$1 "
                              "AND m.dice->>'move_id'=$2 AND ($3 OR delegated) "
                              "ORDER BY m.seq LIMIT 1",
                              {r.intent, move, r.op == "move"});
      r.repeated = json::str(old, "id");
    }
    if (r.op == "move" && r.repeated.empty() &&
        request["revision"] != rules["revision"])
      throw conflict("Rules changed. Read the current moves.");
    return r;
  }

  r.roll = id(request, "roll_id");
  auto result = Db::queryOne(
      w,
      "SELECT m.*,p.card AS initial,p.question_id FROM messages m JOIN "
      "pbta_rulings p ON p.roll_id=m.id "
      "WHERE m.id=$1 AND m.chat_window_id=$2 AND m.character_id=$3",
      {r.roll, window, actor});
  if (result.isNull())
    throw badRequest("Unknown ruling for this character and window");
  r.source = result;
  r.refs = {r.roll};
  if (r.op == "ask") {
    r.repeated = json::str(result, "question_id");
    r.text = json::requireStr(request, "text");
    if (r.text.size() > 4000)
      throw badRequest("Question too long");
    return r;
  }
  if (r.op != "mark")
    throw badRequest("Unknown ruling action");
  r.section = json::str(request, "section");
  r.field = json::str(request, "field");
  if (r.section != "conditions" && r.section != "resources")
    throw badRequest("Only conditions and resource counters can be marked");
  auto existing = Db::queryOne(w,
                               "SELECT message_id FROM pbta_marks WHERE "
                               "roll_id=$1 AND section=$2 AND field=$3",
                               {r.roll, r.section, r.field});
  if (!existing.isNull()) {
    r.repeated = json::str(existing, "message_id");
    return r;
  }
  if (request["revision"] != rules["revision"] ||
      result["dice"]["revision"] != rules["revision"] ||
      c["card"]["book"].isNull() ||
      c["card"]["book"] != result["initial"]["book"])
    throw conflict(
        "Rules or playbook changed. Review the historical ruling manually.");
  const auto basis = json::str(request, "basis");
  if (basis != "choice" && basis != "automatic")
    throw badRequest("Specify whether a player's choice is required");
  if (basis == "choice" || result["dice"]["player_choice"].asBool() ||
      !result["question_id"].isNull()) {
    auto answer = id(request, "answer_id");
    auto reply = Db::queryOne(
        w,
        "SELECT m.id FROM messages m WHERE m.id=$1 AND m.chat_window_id=$2 AND "
        "m.character_id=$3 "
        "AND m.author_id=coalesce($4::uuid,$5::uuid) AND m.kind IN "
        "('ic','ooc') AND m.visibility=$6 AND m.whisper_to=$7::uuid[] "
        "AND m.seq>(SELECT seq FROM messages WHERE id=$8)",
        {answer, window, actor,
         c["user_id"].isNull() ? dbNull() : DbParam(c["user_id"].asString()),
         a.userId, result["visibility"].asString(),
         pgArrayLiteral(json::strArray(result["whisper_to"])),
         json::str(result, "question_id", r.roll)});
    if (reply.isNull())
      throw conflict("Wait for this character's choice in the original window");
    r.refs.push_back(answer);
  }
  auto before = frozen(result["initial"], r.section, r.field),
       current = frozen(c["card"], r.section, r.field);
  const auto &after = request["value"];
  if (request["expected"] != before)
    throw conflict("Expected value does not match the original ruling");
  if (current != before && current != after)
    throw conflict("This field was edited. Reconcile it with the player.");
  if (current != before &&
      !Db::queryOne(w,
                    "SELECT 1 AS other FROM pbta_marks k JOIN messages m ON "
                    "m.id=k.message_id JOIN messages r ON r.id=k.roll_id "
                    "WHERE r.character_id=$1 AND k.section=$2 AND k.field=$3 "
                    "AND m.seq>$4 LIMIT 1",
                    {actor, r.section, r.field, result["seq"].asInt64()})
           .isNull())
    throw conflict("Another ruling changed this field. Reconcile the two costs "
                   "with the player.");
  auto next = c["card"];
  next[r.section][r.field] = after;
  normalizeCard(next, rules["pack"]);
  std::string label;
  for (const auto &field : rules["pack"][r.section])
    if (field["id"] == r.field)
      label = field["name"].asString();
  r.text = c["name"].asString() + " · " + label + " · " + before.asString() +
           " → " + after.asString();
  if (current != after)
    r.updated = Db::queryOne(w,
                             "UPDATE characters SET "
                             "role_card=jsonb_set(role_card,'{pbta}',$2::jsonb)"
                             ",updated_at=now() WHERE id=$1 RETURNING *",
                             {actor, json::dump(next)});
  return r;
}
void Ruling::finish(pqxx::work &w, const std::string &message,
                    const std::string &actor) const {
  if (op == "declare")
    Db::exec(w,
             "INSERT INTO "
             "pbta_declarations(anchor_id,character_id,message_id,command) "
             "VALUES($1,$2,$3,$4::jsonb)",
             {intent, actor, message, json::dump(command)});
  if (op == "manual" || op == "move")
    Db::exec(w,
             "INSERT INTO pbta_rulings(roll_id,intent_id,delegated,card) "
             "VALUES($1,$2,$3,$4::jsonb)",
             {message, intent.empty() ? dbNull() : DbParam(intent),
              op == "move", json::dump(card)});
  if (op == "ask")
    Db::exec(w, "UPDATE pbta_rulings SET question_id=$2 WHERE roll_id=$1",
             {roll, message});
  if (op == "mark")
    Db::exec(w,
             "INSERT INTO pbta_marks(roll_id,section,field,message_id) "
             "VALUES($1,$2,$3,$4)",
             {roll, section, field, message});
}
} // namespace acerciae::pbta
