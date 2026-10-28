#pragma once
#include "../core/Json.h"
#include "../core/Text.h"
#include <set>

namespace acerciae::narrative_memory {
// Shared by Keeper and player observers. Editorial judgment belongs to the model, not a keyword blacklist.
inline const char* guidance() {
    return R"(
NARRATIVE EDITING: these documents are useful story memory, NOT a transcript or one-entry-per-message log.
Before emitting any operation, decide whether the new evidence changes something worth remembering in the fiction, then compare it with existing entries in documents and related_history. Choose SKIP, UPDATE, or ADD in this same pass:
- SKIP table chatter, greetings, technical/debug/channel setup explanations, UI labels, placeholders (e.g. a message containing only 'Narration'), and repeated information without a meaningful new development. Judge actual content even if tagged ic/narration or authored by the GM. Do NOT create a meta-entry saying that a message is irrelevant, OOC, a test, or lacks information. A quoted statement '这是带有真实 LLM 的调试频道' is not an NPC claim or a story event.
- A bare 1d100 result such as 75 or 19 with no established action, target, check or consequence is not a plot development. Do not invent a reason or success/failure. If surrounding witnessed chat establishes its narrative significance, summarize that action/outcome with the appropriate evidence; retain meaningful injuries, discoveries, choices, deadlines, relationships and unresolved consequential attempts. Rules talk or an OOC correction may clarify actual story facts; preserve those facts rather than the table chatter.
- UPDATE an existing fact_id when new evidence develops, clarifies, corrects or resolves the SAME subject/action/clue/thread. Preserve earlier useful details and evidence, distinguish attempted from confirmed, and keep uncertain claims uncertain. Use top-level fields: {"op":"update_entry","fact_id":"existing id","summary":"updated concise summary","status":"...","data":{},"source_event_ids":["new evidence id"]}. Use set_status for a status-only development. Never wrap updates in fact. Do not recycle a fact_id belonging to a different subject, scene or memory group. Material contradictions and changes to GM-authored entries still require the existing review flow.
- ADD only a distinct, useful development not already covered by an existing entry: {"op":"add_entry","fact":{"summary":"concise story information","status":"...","data":{},"source_event_ids":["new evidence id"]}}. No quota: zero entries is a successful result. Do not duplicate the same summary across all documents; use each document for its specific purpose. Repeated mentions may justify a transient highlight, not a permanent 'mentioned again' paragraph or an invented relationship.
- Read the supplied existing fact IDs and versions first; retrieve older relevant entries if needed. Several messages about the same development should form one coherent entry/update. Do not rewrite unrelated records. A short but decisive clue matters; a long message may be entirely irrelevant. Do not filter based on length or a word such as 'test' alone.
- Existing obvious non-story clutter may be proposed for remove_entry with an explanation and source_event_ids; never erase real historical plot facts just because they are no longer topical. Confirmed/GM-authored material retains its review protections. Leave original chat intact.
Return {"proposals":[],"highlights":[],"module_hints":[]} when nothing useful changed. Do not emit scene_update or other side effects merely to acknowledge a batch. SKIP means no document operation; all omitted chat remains in the source log.
)";
}

// Only unambiguous placeholders and uncontextualized raw rolls are rejected deterministically.
// A real skill/SAN check or a roll with a stated purpose remains for the LLM to judge.
inline bool placeholderOnly(const Json::Value& e) {
    if (json::str(e, "kind") != "message.posted") return false;
    const auto& payload = e["payload"];
    auto content = text::lower(text::trim(e["content"].isString() ? e["content"].asString() : json::str(payload, "content")));
    static const std::set<std::string> placeholders = {"", "narration", "旁白", "ic", "ooc", "[placeholder]", "（占位）"};
    return placeholders.count(content) > 0;
}
inline bool obviousNonNarrative(const Json::Value& e) {
    if (placeholderOnly(e)) return true;
    if (json::str(e, "kind") != "message.posted") return false;
    const auto& dice = e["payload"]["dice"];
    return json::str(dice, "type") == "roll" && text::trim(json::str(dice, "reason")).empty();
}
}
