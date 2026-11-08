#include "ChatQueries.h"
#include "ChatService.h"
namespace acerciae::chatQueries {


// A line is on a PbtA move's record (its intent, roll, question, answer, mark or declaration): recalling it would
// leave the record pointing at nothing.
const std::string ON_MOVE_RECORD =
    "(EXISTS(SELECT 1 FROM pbta_rulings pr WHERE m.id IN (pr.roll_id, pr.intent_id, pr.question_id)) "
    "OR EXISTS(SELECT 1 FROM pbta_marks pk WHERE pk.message_id=m.id) "
    "OR EXISTS(SELECT 1 FROM pbta_declarations pd WHERE m.id IN (pd.anchor_id, pd.message_id)))";
const std::string RECALL_WINDOW = "interval '" + std::to_string(ChatService::kRecallSeconds) + " seconds'";
// Seconds left to recall the line, null when it cannot be (CASE evaluates in order: the move-record lookups run only
// for recent lines of a recallable kind).
const std::string RECALL_SECONDS_LEFT =
    "CASE WHEN m.recalled_at IS NOT NULL OR m.kind NOT IN ('ic','ooc','narration') OR m.created_at <= now() - " + RECALL_WINDOW + " THEN NULL "
    "WHEN " + ON_MOVE_RECORD + " THEN NULL "
    "ELSE greatest(1, ceil(extract(epoch FROM m.created_at + " + RECALL_WINDOW + " - now())))::int END AS recall_seconds_left, ";
const std::string MSG_SELECT =
    "SELECT m.*, " + RECALL_SECONDS_LEFT + "c.name AS character_name, CASE WHEN m.kind='ooc' THEN NULL ELSE COALESCE(mo.avatar_asset_id, c.avatar_asset_id) END AS character_avatar_asset_id, CASE WHEN m.kind='ooc' THEN NULL ELSE mo.name END AS outfit_name, CASE WHEN m.kind='ooc' THEN NULL ELSE ca.version END AS character_avatar_version, CASE WHEN m.kind='ooc' THEN NULL ELSE ca.content_hash END AS character_avatar_hash, u.display_name AS author_name, CASE WHEN u.avatar_data<>'' OR u.avatar_key IS NOT NULL THEN u.avatar_version ELSE 0 END AS author_avatar_version, CASE WHEN u.avatar_data<>'' OR u.avatar_key IS NOT NULL THEN u.avatar_hash END AS author_avatar_hash FROM messages m "
    "LEFT JOIN characters c ON c.id=m.character_id LEFT JOIN character_outfits mo ON mo.id=m.outfit_id LEFT JOIN media_assets ca ON ca.id=COALESCE(mo.avatar_asset_id, c.avatar_asset_id) LEFT JOIN users u ON u.id=m.author_id ";

const std::string WINDOW_HISTORY =
    "WITH RECURSIVE lineage AS (SELECT id, fork_parent_id, fork_seq, NULL::bigint AS cutoff, 0 AS depth FROM chat_windows WHERE id=$1 "
    "UNION ALL SELECT p.id,p.fork_parent_id,p.fork_seq,LEAST(l.cutoff,l.fork_seq),l.depth+1 "
    "FROM lineage l JOIN chat_windows p ON p.id=l.fork_parent_id) ";

std::string serverRole(Db& db, const std::string& serverId, const std::string& userId) {
    auto r = db.queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {serverId, userId});
    return r.isNull() ? "" : r["role"].asString();
}
}
