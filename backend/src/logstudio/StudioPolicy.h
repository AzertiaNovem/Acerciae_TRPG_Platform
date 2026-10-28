#pragma once
#include "../core/Db.h"
#include "../core/Errors.h"
#include "../auth/AuthService.h"
#include "../knowledge/Visibility.h"
namespace acerciae::logstudio {
inline void requireCloudPermission(Db &db, const std::string &channel) {
  auto row = db.queryOne(
      "SELECT studio_cloud_allowed FROM channels WHERE id=$1", {channel});
  if (row.isNull() || !row["studio_cloud_allowed"].asBool())
    throw forbidden("Log Studio cloud processing is disabled for this "
                    "campaign; the GM can enable it in Library settings");
}

// Whether the Keeper has ended the story, and whether Keeper-only lines were revealed with it.
struct StoryState { bool ended = false; bool revealAll = false; };
inline StoryState storyState(Db &db, const std::string &channelId) {
  auto r = db.queryOne("SELECT story_status, story_reveal_all FROM channels WHERE id=$1", {channelId});
  StoryState s;
  if (!r.isNull()) { s.ended = r["story_status"].asString() == "ended"; s.revealAll = s.ended && r["story_reveal_all"].asBool(); }
  return s;
}

// SQL predicate over a log_events row `le`: may this viewer read the line?
// - The Keeper reads everything.
// - Lines from the channel's own chat follow the chat's rule (player_group_readable_messages), evaluated now, so a
//   side window, another group's window or a whisper never becomes readable through the Studio, whatever the
//   knowledge mode. Imported lines follow their stored scope and audience.
//   A whisper (a hidden roll, a private aside) stays with the characters it was addressed to, even inside a shared
//   player group.
// - Once the story has ended, every member reads the whole story except Keeper-only lines (all of it when the
//   Keeper revealed those too).
inline std::string whisperOutside(const std::string &le, const std::string &characters) {
  return "NOT EXISTS (SELECT 1 FROM messages wm WHERE wm.id=" + le + ".source_message_id AND wm.visibility='whisper' AND NOT (wm.whisper_to && " + characters + "))";
}
inline std::string visibleLogFilter(const ChannelAccess &a, const StoryState &story, const std::string &le) {
  if (a.isGm) return "TRUE";
  if (story.ended) return story.revealAll ? "TRUE" : "(" + le + ".visibility_scope<>'gm')";
  std::string chatLine = Visibility::isUuid(a.playerGroupId)
      ? "(" + le + ".visibility_scope<>'gm' AND " + Visibility::groupGuard(a) + " AND EXISTS(SELECT 1 FROM player_group_readable_messages r WHERE r.group_id='" +
            a.playerGroupId + "'::uuid AND r.message_id=" + le + ".source_message_id) AND " +
            whisperOutside(le, Visibility::uuidArray(a.characterIds)) + ")"
      : "FALSE";
  return "(CASE WHEN " + le + ".source_kind='channel_event' AND " + le + ".source_message_id IS NOT NULL THEN " + chatLine + " ELSE (" + le +
         ".visibility_scope='public' OR (" + le + ".visibility_scope='character' AND " + le + ".audience && " + Visibility::uuidArray(a.characterIds) + ")) END)";
}

// SQL predicate over a log_events row `le`: does a snapshot scope cover the line, whoever builds it?
//   gm_full   every line
//   pl_public lines every player group can read
//   character lines the character's player can read
inline std::string scopeLogFilter(const StoryState &story, const std::string &scope, const std::string &characterId, const std::string &le) {
  if (scope == "gm_full") return "TRUE";
  if (story.ended) return story.revealAll ? "TRUE" : "(" + le + ".visibility_scope<>'gm')";
  if (scope == "pl_public")
    return "(CASE WHEN " + le + ".source_kind='channel_event' AND " + le + ".source_message_id IS NOT NULL THEN (" + le +
           ".visibility_scope<>'gm' AND NOT EXISTS (SELECT 1 FROM player_groups g WHERE g.channel_id=" + le +
           ".channel_id AND EXISTS (SELECT 1 FROM player_group_members gm WHERE gm.group_id=g.id) AND NOT EXISTS "
           "(SELECT 1 FROM player_group_readable_messages r WHERE r.group_id=g.id AND r.message_id=" + le + ".source_message_id)) AND " +
           whisperOutside(le, "'{}'::uuid[]") + ") ELSE " + le +
           ".visibility_scope='public' END)";
  if (!Visibility::isUuid(characterId)) throw badRequest("invalid scope_character_id");
  return "(CASE WHEN " + le + ".source_kind='channel_event' AND " + le + ".source_message_id IS NOT NULL THEN (" + le +
         ".visibility_scope<>'gm' AND EXISTS (SELECT 1 FROM player_group_readable_messages r JOIN player_group_members pm ON pm.group_id=r.group_id "
         "JOIN characters c ON c.user_id=pm.user_id AND c.channel_id=pm.channel_id WHERE c.id='" + characterId + "'::uuid AND r.message_id=" + le +
         ".source_message_id) AND " + whisperOutside(le, "'{" + characterId + "}'::uuid[]") + ") ELSE (" + le + ".visibility_scope='public' OR (" + le + ".visibility_scope='character' AND " + le + ".audience && '{" +
         characterId + "}'::uuid[])) END)";
}

// Players see scenario titles and locations only once the story has ended; before that a scenario is "Scenario N",
// as everywhere else in the app.
inline bool masksScenes(const ChannelAccess &a, const StoryState &story) { return !a.isGm && !story.ended; }
} // namespace acerciae::logstudio
