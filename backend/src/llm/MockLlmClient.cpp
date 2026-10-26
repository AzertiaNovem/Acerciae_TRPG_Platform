#include "MockLlmClient.h"
#include "../core/Json.h"
#include "../core/Text.h"
#include <algorithm>
#include <regex>
#include <set>
#include <map>

namespace acerciae {
using namespace text;

Json::Value MockLlmClient::lastUserJson(const LlmRequest& req) {
    // The structured context is the most recent user message that parses as a JSON object; later plain-text
    // user turns (schema repair requests) are skipped.
    for (auto it = req.messages.rbegin(); it != req.messages.rend(); ++it)
        if (it->role == "user") { try { auto v = json::parse(it->content); if (v.isObject()) return v; } catch (...) {} }
    Json::Value v; v["text"] = req.messages.empty() ? "" : req.messages.back().content; return v;
}

LlmResponse MockLlmClient::complete(const LlmRequest& req) {
    LlmResponse r; r.ok = true;
    auto ctx = lastUserJson(req);
    bool hadToolResults = false;
    for (auto& m : req.messages) if (m.role == "tool") hadToolResults = true;
    Json::Value out;
    if (req.task == "observer_extract") {
        // Demonstrate the retrieval loop: ask for one search over older history before answering,
        // unless the caller already supplied related_history or we already did.
        if (!hadToolResults && !req.tools.empty() && (!ctx.isMember("related_history") || ctx["related_history"].empty())) {
            std::set<std::string> terms;
            for (auto& e : ctx["new_events"]) for (auto& n : properNouns(json::str(e, "content"))) { terms.insert(n); if (terms.size() >= 2) break; }
            if (!terms.empty()) {
                int i = 0;
                for (auto& t : terms) { Json::Value tc; tc["id"] = "mock-call-" + std::to_string(i++); tc["name"] = "search_scene_history"; Json::Value a; a["query"] = t; a["exclude_scene_id"] = json::str(ctx["scene"], "id"); tc["arguments"] = json::dump(a); r.toolCalls.append(tc); }
                return r;
            }
        }
        // Fold tool results into related_history so the extractor sees them.
        if (hadToolResults) {
            Json::Value rel = ctx.isMember("related_history") ? ctx["related_history"] : Json::Value(Json::arrayValue);
            for (auto& m : req.messages) if (m.role == "tool") {
                try { auto res = json::parse(m.content); for (auto& f : res["facts"]) { Json::Value h = f; h["matched_terms"] = Json::Value(Json::arrayValue); h["matched_terms"].append(json::str(res, "query")); rel.append(h); } } catch (...) {}
            }
            ctx["related_history"] = rel;
        }
        out = observerExtract(ctx);
    }
    else if (req.task == "consolidate") out = consolidate(ctx);
    else if (req.task == "module_structure") out = moduleStructure(ctx);
    else { out["note"] = "mock: unknown task"; }
    r.content = json::dump(out);
    return r;
}

// ---- shared helpers --------------------------------------------------------------------------
static bool anyOf(const std::string& l, std::initializer_list<const char*> ws) { for (auto w : ws) if (l.find(w) != std::string::npos) return true; return false; }

static bool anyWord(const std::string& l, std::initializer_list<const char*> ws) {
    auto toks = words(l); std::set<std::string> t(toks.begin(), toks.end());
    for (auto w : ws) if (t.count(w)) return true;
    return false;
}
static std::string guessEntityKind(const std::string& name, const Json::Value& characters) {
    auto l = lower(name);
    for (auto& c : characters) if (lower(json::str(c, "name")) == l) return json::str(c, "kind", "pc");
    if (anyWord(l, {"house","street","office","dock","docks","room","library","church","station","cellar","basement","hotel","manor","hall","road","avenue","bridge","square","inn","tavern","warehouse","hospital","asylum","university","museum","theatre","theater","cemetery","graveyard","farm","lake","river","forest","woods","town","city","village","harbor","harbour","bar","shop","store","bank","club","mansion","chapel","attic","alley","lighthouse","cove","quarry","pier","cave","interior","archive"})) return "location";
    if (anyWord(l, {"sheriff","dr","doctor","mr","mrs","miss","professor","father","reverend","detective","officer","captain","sergeant","inspector","lady","lord","sir","nurse","judge","mayor"})) return "npc";
    if (anyOf(l, {"society","cult","order of","company","brotherhood","church of","family","gang","police","press","gazette","herald","times"})) return "organisation";
    if (anyWord(l, {"key","badge","letter","book","diary","journal","tome","knife","gun","pistol","revolver","map","photograph","photo","amulet","ring","statue","idol","box","note","ledger","manuscript","scroll","medallion","locket","coin","lantern","documents","clipping"})) return "item";
    return "npc";
}

// Names of known characters (pc/npc) mentioned in the text, matched on any distinctive word of the name.
static std::vector<std::string> mentionedCharacters(const std::string& content, const Json::Value& characters, const std::string& kind) {
    static const std::set<std::string> titles = {"sheriff","mr","mrs","ms","dr","miss","professor","father","the","of"};
    std::vector<std::string> out;
    auto cw = words(content); std::set<std::string> cl; for (auto& w : cw) { auto l = lower(w); if (l.size() > 2 && l.compare(l.size()-2, 2, "'s") == 0) l = l.substr(0, l.size()-2); cl.insert(l); }
    for (auto& c : characters) {
        if (!kind.empty() && json::str(c, "kind") != kind) continue;
        auto name = json::str(c, "name");
        for (auto& w : words(name)) { auto l = lower(w); if (l.size() >= 4 && !titles.count(l) && cl.count(l)) { out.push_back(name); break; } }
    }
    return out;
}

static Json::Value entityList(const std::string& content, const Json::Value& characters) {
    Json::Value arr(Json::arrayValue);
    for (auto& n : properNouns(content)) { Json::Value e; e["name"] = n; e["kind"] = guessEntityKind(n, characters); arr.append(e); }
    return arr;
}

static std::string detectTime(const std::string& content) {
    static const std::regex re("\\b(\\d{1,2}(:\\d{2})?\\s?(am|pm|AM|PM)|midnight|noon|dawn|dusk|morning|afternoon|evening|night|tonight|next day|the following day|[0-9]{1,2}(st|nd|rd|th) of [A-Z][a-z]+|(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}(,? \\d{4})?)\\b");
    std::smatch m; if (std::regex_search(content, m, re)) return m[0];
    return "";
}

static std::string detectLocation(const std::string& content) {
    static const std::regex re("\\b(?:arrive(?:s|d)? at|arrive(?:s|d)? in|enter(?:s|ed)? (?:the )?|into the |inside the |reach(?:es|ed)? the |at the |in the |outside the |stand(?:s|ing)? (?:before|in front of) the )([A-Z][\\w']+(?:\\s+(?:of|the|[A-Z][\\w']+))*)");
    std::smatch m;
    if (std::regex_search(content, m, re)) return trim(m[1]);
    // "The Corbitt House looms..." sentence-initial location nouns
    for (auto& n : properNouns(content)) if (guessEntityKind(n, Json::Value(Json::arrayValue)) == "location") return n;
    return "";
}

// Object phrase after a discovery verb: "you find a brass key under the mat" -> "a brass key"
static std::string objectAfter(const std::string& content, const std::regex& verbRe) {
    std::smatch m;
    if (!std::regex_search(content, m, verbRe)) return "";
    std::string rest = m.suffix().str();
    std::string obj;
    static const std::regex stop("^(.*?)(?:\\s+(?:under|in|on|inside|behind|beneath|near|at|from|with|which|that|and|but|bearing|dated)\\b.*|[,.;:!?].*)$");
    std::smatch s;
    if (std::regex_match(rest, s, stop)) obj = s[1]; else obj = rest;
    obj = trim(obj);
    if (obj.size() > 80) obj = obj.substr(0, 80);
    return obj;
}

// ---- observer ----------------------------------------------------------------------------------
Json::Value MockLlmClient::observerExtract(const Json::Value& ctx) {
    Json::Value out; out["proposals"] = Json::Value(Json::arrayValue); out["highlights"] = Json::Value(Json::arrayValue); out["module_hints"] = Json::Value(Json::arrayValue); out["knowledge_suggestions"] = Json::Value(Json::arrayValue);
    std::map<std::string, Json::Value> byDoc;   // doc_type -> ops array
    auto addOp = [&](const std::string& doc, const Json::Value& op) { if (!byDoc.count(doc)) byDoc[doc] = Json::Value(Json::arrayValue); byDoc[doc].append(op); };
    auto mkFact = [&](const std::string& summary, const std::string& status, const Json::Value& data, const std::string& eventId, const Json::Value& entities) {
        Json::Value op; op["op"] = "add_entry"; Json::Value f; f["summary"] = summary; f["status"] = status; f["data"] = data;
        f["source_event_ids"] = Json::Value(Json::arrayValue); f["source_event_ids"].append(eventId); f["entities"] = entities; op["fact"] = f; return op;
    };
    const auto& characters = ctx["characters"];
    const auto& scene = ctx["scene"];
    std::string sceneLoc = json::str(scene, "location");
    std::string sceneTime = json::str(scene, "narrative_time");
    std::vector<std::string> pcNames; for (auto& p : scene["participants"]) pcNames.push_back(json::str(p, "name"));
    std::string lastNpc;
    std::set<std::string> linkedTerms;

    static const std::regex findRe("\\b(?:you|they|he|she|[A-Z][a-z]+)\\s+(?:find|finds|found|discover|discovers|discovered|notice|notices|noticed|uncover|uncovers|retrieve|retrieves|recover|recovers)\\s+(?:(?:a|an|the|some|several|two|three)\\s+)?", std::regex::icase);
    static const std::regex handRe("\\b(?:hands|gives|passes|offers|slides|tosses|presents)\\s+(?:you|him|her|them|[A-Z][a-z]+)\\s+(?:(?:a|an|the|his|her|some)\\s+)?", std::regex::icase);
    static const std::regex dropRe("\\b(?:drops|dropped|leaves behind|left behind|lets fall|slips you|slides you)\\s+(?:(?:a|an|the|his|her|some)\\s+)?", std::regex::icase);
    static const std::regex revealRe("\\b(?:reads|read|says|is written|inscribed|the text reads|it reads|reveals|revealing|shows|showing)\\b", std::regex::icase);
    static const std::regex tryRe("\\b(?:I|we)\\s+(?:try|attempt|search|look|examine|inspect|pick|take|grab|open|force|climb|sneak|listen|check|read|follow|light|break|push|pull|dig|unlock|draw|pocket|investigate|study|approach|go|head|walk|run|hide|wait|watch|roll|cast)\\b", std::regex::icase);
    static const std::regex hypoRe("\\b(?:maybe|perhaps|I think|I bet|could be|must be|probably|I suspect|what if|I wonder|my guess|it seems)\\b", std::regex::icase);
    static const std::regex promiseRe("\\b(?:promise|promises|promised|swear|swears|swore|I'll (?:bring|get|find|look|return|come|tell|help)|will (?:bring|get|find|look|return|come|tell|help)|owe|owes|vow|vows|agree|agrees|agreed|deal)\\b", std::regex::icase);
    static const std::regex hostileRe("\\b(?:threaten|threatens|threatened|lie|lies|lying|lied|refuse|refuses|refused|attack|attacks|attacked|distrust|suspects? you|glares|snarls|accuses|accused|warns|warning)\\b", std::regex::icase);
    static const std::regex successRe("\\b(?:succeed|succeeds|succeeded|manage|manages|managed|successfully|you (?:find|discover|notice|see|hear|realise|realize|feel|smell|open|unlock|spot|recognise|recognize)|it works|the (?:door|lock|lid|chest|box|window) (?:opens|gives|clicks|swings)|roll(?:ed)? a success|hard success|extreme success|critical)\\b", std::regex::icase);
    static const std::regex failRe("\\b(?:fail|fails|failed|fumble|fumbles|fumbled|nothing happens|cannot|can't|unable|too heavy|refuses to budge|no luck|does not budge|doesn't budge)\\b", std::regex::icase);
    static const std::regex pcPromiseRe("\\b(?:I|we)\\s+(?:promise|swear|vow|owe)\\b|\\b(?:I|we)(?:'ll| will)\\s+(?:bring|get|find|return|come back|help|tell)\\b|\\bgive (?:you )?my word\\b", std::regex::icase);
    static const std::regex deadlineRe("\\b(?:tomorrow|tonight|by (?:dawn|dusk|midnight|noon|morning|nightfall|sunset|the end)|before (?:dawn|dusk|midnight|the|it)|within (?:the|a|an|two|three) (?:hour|day|week|night)s?|next (?:week|day|morning|night)|in (?:two|three|an|a) (?:hour|day|week|night)s?)\\b", std::regex::icase);

    for (auto& e : ctx["new_events"]) {
        auto content = json::str(e, "content");
        if (content.empty()) continue;
        auto eid = json::str(e, "event_id");
        auto role = json::str(e, "actor_role");
        auto charName = json::str(e, "character_name");
        auto kind = json::str(e, "kind");
        auto ents = entityList(content, characters);
        auto l = lower(content);
        std::string timeMark = detectTime(content);
        if (kind != "message.posted") {
            if (kind == "scene.entered" || kind == "scene.created" || kind == "scene.updated") {
                Json::Value d; d["facet"] = "location"; d["location"] = json::str(e["payload"], "location");
                addOp("current_scene", mkFact(content, "confirmed", d, eid, ents));
                Json::Value td; td["when"] = sceneTime.empty() ? "unspecified" : sceneTime;
                addOp("timeline", mkFact(content, "confirmed", td, eid, ents));
            }
            continue;
        }
        bool isGm = role == "gm";
        auto quotes = quotedSpeech(content);
        // Who is speaking/addressed
        std::string npc;
        for (auto& n : mentionedCharacters(content, characters, "npc")) { if (icontains(content, n)) { npc = n; break; } }
        for (auto& en : ents) {
            if (!npc.empty()) break;
            if (json::str(en, "kind") != "npc" || std::find(pcNames.begin(), pcNames.end(), json::str(en, "name")) != pcNames.end()) continue;
            auto cand = json::str(en, "name");
            // Use the canonical character name only when the text itself contains it; otherwise keep the form the
            // players actually heard ("Mrs. Hale"), so undisclosed full names never enter player-visible records.
            for (auto& c : characters) {
                if (json::str(c, "kind") != "npc") continue;
                if (icontains(content, json::str(c, "name"))) { cand = json::str(c, "name"); break; }
            }
            if (npc.empty()) npc = cand;
            if (cand != json::str(en, "name")) { npc = cand; break; }
        }
        if (!npc.empty()) lastNpc = npc;
        std::string addressedPc = pcNames.empty() ? "" : pcNames.front();
        { auto m = mentionedCharacters(content, characters, "pc"); for (auto& n : m) if (n != charName) { addressedPc = n; break; } }
        // Never treat a PC name as an NPC.
        for (auto& p : pcNames) if (!npc.empty() && icontains(npc, p)) npc.clear();

        if (isGm) {
            // Location change
            auto loc = detectLocation(content);
            if (!loc.empty() && lower(loc) != lower(sceneLoc)) {
                Json::Value d; d["facet"] = "location"; d["location"] = loc;
                addOp("current_scene", mkFact("The scene moves to " + loc + ".", "confirmed", d, eid, ents));
                out["scene_update"]["location"] = loc; sceneLoc = loc;
            }
            if (!timeMark.empty() && lower(timeMark) != lower(sceneTime)) { out["scene_update"]["narrative_time"] = timeMark; sceneTime = timeMark; }
            // Discoveries / hand-overs → clue journal (confirmed, GM declared)
            auto obj = objectAfter(content, findRe);
            bool handed = false;
            if (obj.empty()) { obj = objectAfter(content, handRe); handed = !obj.empty(); }
            if (obj.empty()) obj = objectAfter(content, dropRe);
            if (!obj.empty()) {
                Json::Value d; d["title"] = obj; d["source"] = handed ? ("handed over by " + (npc.empty() ? std::string("an NPC") : npc)) : ("found at " + (sceneLoc.empty() ? std::string("the current scene") : sceneLoc));
                d["discovered_by"] = join(pcNames, ", "); d["handed_over"] = handed;
                Json::Value ce = ents; Json::Value ie; ie["name"] = obj; ie["kind"] = "item"; ce.append(ie);
                addOp("clue_journal", mkFact(sentences(content).empty() ? content : [&]{ for (auto& s : sentences(content)) if (icontains(s, obj)) return s; return sentences(content).front(); }(), "confirmed", d, eid, ce));
                Json::Value sd; sd["facet"] = "event"; addOp("current_scene", mkFact((handed ? npc + " hands over " : "The investigators obtain ") + obj + ".", "confirmed", sd, eid, ce));
                Json::Value td; td["when"] = timeMark.empty() ? (sceneTime.empty() ? "unspecified" : sceneTime) : timeMark;
                addOp("timeline", mkFact((handed ? npc + " hands over " : "Discovered: ") + obj + (sceneLoc.empty() ? "" : " (" + sceneLoc + ")"), "confirmed", td, eid, ce));
            }
            // Success / failure adjudication of an attempted action → scene state (confirmed)
            if (std::regex_search(content, successRe) && obj.empty()) {
                Json::Value d; d["facet"] = "event"; d["outcome"] = "success";
                addOp("current_scene", mkFact(truncate(content, 160), "confirmed", d, eid, ents));
                Json::Value td; td["when"] = timeMark.empty() ? (sceneTime.empty() ? "unspecified" : sceneTime) : timeMark;
                addOp("timeline", mkFact(truncate(content, 120), "confirmed", td, eid, ents));
            } else if (std::regex_search(content, failRe)) {
                Json::Value d; d["facet"] = "event"; d["outcome"] = "failure";
                addOp("current_scene", mkFact(truncate(content, 160), "confirmed", d, eid, ents));
            }
            // NPC speech → claims, promises, questions
            for (auto& q : quotes) {
                std::string speaker = npc.empty() ? (lastNpc.empty() ? "An NPC" : lastNpc) : npc;
                if (std::regex_search(q, promiseRe)) {
                    Json::Value d; d["from"] = speaker; d["from_kind"] = "npc"; d["to"] = addressedPc.empty() ? "the investigators" : addressedPc; d["to_kind"] = "pc"; d["relation"] = "promised"; d["quote"] = q;
                    addOp("relationships", mkFact(speaker + " promises " + d["to"].asString() + ": \"" + truncate(q, 120) + "\"", "npc_claim", d, eid, ents));
                    Json::Value td; td["title"] = speaker + "'s promise"; td["thread_kind"] = "promise";
                    addOp("open_threads", mkFact(speaker + " promised: \"" + truncate(q, 120) + "\" — not yet fulfilled.", "npc_claim", td, eid, ents));
                } else if (std::regex_search(q, hostileRe)) {
                    Json::Value d; d["from"] = speaker; d["from_kind"] = "npc"; d["to"] = addressedPc.empty() ? "the investigators" : addressedPc; d["to_kind"] = "pc"; d["relation"] = "hostile"; d["quote"] = q;
                    addOp("relationships", mkFact(speaker + " turns hostile toward " + d["to"].asString() + ": \"" + truncate(q, 120) + "\"", "npc_claim", d, eid, ents));
                } else if (q.find('?') != std::string::npos) {
                    Json::Value td; td["title"] = speaker + " asks a question"; td["thread_kind"] = "question";
                    addOp("open_threads", mkFact(speaker + " asked: \"" + truncate(q, 140) + "\"", "npc_claim", td, eid, ents));
                } else if (q.size() > 25) {
                    Json::Value d; d["facet"] = "npc_statement"; d["speaker"] = speaker;
                    addOp("current_scene", mkFact(speaker + " claims: \"" + truncate(q, 140) + "\"", "npc_claim", d, eid, ents));
                }
            }
            if (std::regex_search(content, deadlineRe) && quotes.empty()) {
                Json::Value td; td["title"] = "Time-bound development"; td["thread_kind"] = "deadline";
                addOp("open_threads", mkFact(truncate(content, 140), "confirmed", td, eid, ents));
            }
            if (std::regex_search(content, hostileRe) && quotes.empty() && !npc.empty()) {
                Json::Value d; d["from"] = npc; d["from_kind"] = "npc"; d["to"] = addressedPc.empty() ? "the investigators" : addressedPc; d["to_kind"] = "pc"; d["relation"] = "hostile";
                addOp("relationships", mkFact(npc + " acts with hostility toward " + d["to"].asString() + ".", "confirmed", d, eid, ents));
            }
        } else {
            // Player messages: actions are attempts, statements are hypotheses, questions open threads.
            std::string actor = charName.empty() ? "A player" : charName;
            if (std::regex_search(content, hypoRe)) {
                Json::Value td; td["title"] = actor + "'s theory"; td["thread_kind"] = "question";
                addOp("open_threads", mkFact(actor + " suspects: " + truncate(content, 140), "hypothesis", td, eid, ents));
            }
            if (std::regex_search(content, tryRe)) {
                Json::Value d; d["facet"] = "action"; d["actor"] = actor;
                addOp("current_scene", mkFact(actor + " attempts: " + truncate(content, 140), "attempted", d, eid, ents));
            }
            static const std::regex selfPromise("\\bpromise (?:myself|ourselves)\\b", std::regex::icase);
            if (std::regex_search(content, pcPromiseRe) && !std::regex_search(content, selfPromise)) {
                std::string target = npc.empty() ? lastNpc : npc;
                if (!target.empty()) {
                    Json::Value d; d["from"] = actor; d["from_kind"] = "pc"; d["to"] = target; d["to_kind"] = "npc"; d["relation"] = "promised";
                    addOp("relationships", mkFact(actor + " promises " + target + ": " + truncate(content, 120), "attempted", d, eid, ents));
                    Json::Value td; td["title"] = actor + "'s promise to " + target; td["thread_kind"] = "promise";
                    addOp("open_threads", mkFact(actor + " promised " + target + ": " + truncate(content, 120), "attempted", td, eid, ents));
                }
            }
            for (auto& q : quotes) if (q.find('?') != std::string::npos) {
                Json::Value td; td["title"] = actor + " asks"; td["thread_kind"] = "question";
                addOp("open_threads", mkFact(actor + " asked: \"" + truncate(q, 140) + "\"", "attempted", td, eid, ents));
            }
        }

        // Return of historical foreshadowing: related_history entries matched to this event's terms.
        for (auto& h : ctx["related_history"]) {
            // One highlight per (fact, event); pick the most specific matching term (proper noun, then longest).
            bool hit = false; std::string term;
            for (auto& t : h["matched_terms"]) {
                auto ts = t.asString();
                if (!icontains(content, ts)) continue;
                hit = true;
                auto rank = [&](const std::string& x) { if (std::isupper((unsigned char)x[0])) return 3; auto k = guessEntityKind(x, characters); if (k == "item" || k == "location" || k == "organisation") return 2; return 1; };
                bool better = term.empty() || rank(ts) > rank(term) || (rank(ts) == rank(term) && ts.size() > term.size());
                if (better) term = ts;
            }
            if (!hit) continue;
            Json::Value hl; hl["fact_id"] = h["fact_id"]; hl["kind"] = "association";
            hl["reason"] = "\"" + term + "\" mentioned again by " + (charName.empty() ? std::string("the GM") : charName) + "; previously recorded in " + json::str(h, "scene_title", "an earlier scene") + ".";
            hl["source_event_ids"] = Json::Value(Json::arrayValue); hl["source_event_ids"].append(eid);
            out["highlights"].append(hl);
            // Keep the record alive: append a traceable note to the old entry.
            Json::Value up; up["op"] = "append_text"; up["fact_id"] = h["fact_id"]; up["source_event_ids"] = hl["source_event_ids"];
            up["text"] = "↩ Mentioned again by " + (charName.empty() ? std::string("the GM") : charName) + (sceneLoc.empty() ? "" : " at " + sceneLoc) + ".";
            addOp(json::str(h, "document_type", "clue_journal"), up);
            // And link the entities to the relationship journal when a character re-engages with a named thing
            // (proper noun, item or location) — not for adjectives or verbs that happen to match.
            bool properTerm = !term.empty() && std::isupper((unsigned char)term[0]);
            auto tk = guessEntityKind(term, characters);
            bool namedThing = properTerm || tk == "item" || tk == "location" || tk == "organisation";
            if (!charName.empty() && namedThing && json::str(h, "document_type") == "clue_journal" && linkedTerms.insert(lower(charName + "|" + term)).second) {
                Json::Value d; d["from"] = charName; d["from_kind"] = "pc"; d["to"] = term; d["to_kind"] = guessEntityKind(term, characters); d["relation"] = "connected_to";
                addOp("relationships", mkFact(charName + " brings up " + term + " again (first recorded in " + json::str(h, "scene_title", "an earlier scene") + ").", "ai_inferred", d, eid, ents));
            }
        }
        // Module awareness
        for (auto& n : ctx["module_nodes"]) {
            auto nname = json::str(n, "name");
            bool byName = icontains(content, nname);
            // Text matches come from the retrieval layer (FTS over node name+description); they carry matched_terms.
            std::string matched; for (auto& t : n["matched_terms"]) if (icontains(content, t.asString())) { matched = t.asString(); break; }
            if (!byName && matched.empty()) continue;
            if (byName) {
                Json::Value d; d["node_id"] = n["node_id"]; d["node_name"] = nname; d["node_type"] = n["node_type"]; d["progress"] = "active";
                addOp("module_progress", mkFact("Play touches module element \"" + nname + "\" (" + json::str(n, "node_type") + ").", "ai_inferred", d, eid, ents));
            }
            Json::Value mh; mh["node_id"] = n["node_id"]; mh["source_event_ids"] = Json::Value(Json::arrayValue); mh["source_event_ids"].append(eid);
            mh["reason"] = byName ? "Potential association: current events mention \"" + nname + "\", which appears in the module as a " + json::str(n, "node_type") + "."
                                  : "Potential association: \"" + matched + "\" in the current conversation also appears in module " + json::str(n, "node_type") + " \"" + nname + "\" (p." + json::str(n, "page", "?") + ").";
            out["module_hints"].append(mh);
        }
        if (json::toBool(ctx, "has_module") && json::toBool(ctx, "scene_is_off_module") && isGm && !sceneLoc.empty()) {
            Json::Value d; d["node_name"] = sceneLoc; d["node_type"] = "location"; d["progress"] = "off_module";
            addOp("module_progress", mkFact("Players are at \"" + sceneLoc + "\", a location not present in the module. Events are being recorded; no module truth is assumed.", "ai_inferred", d, eid, ents));
            Json::Value mh; mh["node_id"] = Json::Value(); mh["source_event_ids"] = Json::Value(Json::arrayValue); mh["source_event_ids"].append(eid);
            mh["reason"] = "Off-module: \"" + sceneLoc + "\" is not a module location. The chronicler keeps recording actual events; older module hooks are listed as potential associations only.";
            out["module_hints"].append(mh);
        }
    }
    for (auto& [doc, ops] : byDoc) { Json::Value p; p["document_type"] = doc; p["ops"] = ops; out["proposals"].append(p); }
    return out;
}

// ---- consolidator -------------------------------------------------------------------------------
Json::Value MockLlmClient::consolidate(const Json::Value& ctx) {
    Json::Value out; out["proposals"] = Json::Value(Json::arrayValue); out["notes"] = Json::Value(Json::arrayValue);
    Json::Value threadOps(Json::arrayValue), relOps(Json::arrayValue);
    const auto& threads = ctx["documents"]["open_threads"]["entries"];
    const auto& clues = ctx["documents"]["clue_journal"]["entries"];
    // Resolve promise threads when a confirmed clue records the promised item being handed over.
    for (auto& t : threads) {
        if (json::str(t, "status") == "resolved") continue;
        if (json::str(t["data"], "thread_kind") != "promise") continue;
        auto kws = keywords(json::str(t, "summary"), 5);
        for (auto& c : clues) {
            if (json::str(c, "status") != "confirmed" || !json::toBool(c["data"], "handed_over")) continue;
            int hits = 0; for (auto& k : kws) if (icontains(json::str(c, "summary"), k) || icontains(json::str(c["data"], "title"), k)) hits++;
            if (hits >= 1) {
                Json::Value op; op["op"] = "set_status"; op["fact_id"] = t["fact_id"]; op["status"] = "resolved";
                op["source_event_ids"] = c["source_event_ids"]; threadOps.append(op); break;
            }
        }
    }
    // Relationship consolidation: duplicate (from,to,relation) pairs → keep the oldest.
    std::map<std::string, std::string> seen;
    for (auto& r : ctx["documents"]["relationships"]["entries"]) {
        auto key = lower(json::str(r["data"], "from") + "|" + json::str(r["data"], "to") + "|" + json::str(r["data"], "relation"));
        if (key == "||") continue;
        if (seen.count(key) && json::str(r, "status") != "confirmed") {
            Json::Value op; op["op"] = "remove_entry"; op["fact_id"] = r["fact_id"]; op["source_event_ids"] = r["source_event_ids"]; relOps.append(op);
        } else seen[key] = json::str(r, "fact_id");
    }
    if (!threadOps.empty()) { Json::Value p; p["document_type"] = "open_threads"; p["ops"] = threadOps; out["proposals"].append(p); }
    if (!relOps.empty()) { Json::Value p; p["document_type"] = "relationships"; p["ops"] = relOps; out["proposals"].append(p); }
    if ((int)ctx["documents"]["timeline"]["entries"].size() > 40) out["notes"].append("timeline exceeds 40 entries; compression recommended (not automated in mock mode)");
    return out;
}

// ---- module structuring ------------------------------------------------------------------------
Json::Value MockLlmClient::moduleStructure(const Json::Value& ctx) {
    Json::Value out; out["nodes"] = Json::Value(Json::arrayValue); out["edges"] = Json::Value(Json::arrayValue);
    std::string currentScene; std::string currentLocation; int sceneIdx = 0; std::string prevSceneKey;
    std::map<std::string, int> nodeIndex;   // key -> index in nodes
    auto addNode = [&](const std::string& type, const std::string& name, const std::string& desc, int page, const std::string& excerpt) -> std::string {
        auto key = type + "|" + lower(name);
        if (nodeIndex.count(key)) { auto& n = out["nodes"][nodeIndex[key]]; Json::Value c; c["page"] = page; c["excerpt"] = truncate(excerpt, 240); n["citations"].append(c); if (json::str(n, "description").size() < desc.size()) n["description"] = truncate(desc, 400); return key; }
        Json::Value n; n["key"] = key; n["node_type"] = type; n["name"] = truncate(name, 120); n["description"] = truncate(desc, 400);
        n["citations"] = Json::Value(Json::arrayValue); Json::Value c; c["page"] = page; c["excerpt"] = truncate(excerpt, 240); n["citations"].append(c);
        nodeIndex[key] = (int)out["nodes"].size(); out["nodes"].append(n); return key;
    };
    auto addEdge = [&](const std::string& from, const std::string& to, const std::string& rel) { if (from.empty() || to.empty() || from == to) return; Json::Value e; e["from_key"] = from; e["to_key"] = to; e["relation"] = rel; out["edges"].append(e); };
    static const std::regex headingRe("^(?:[A-Z][A-Za-z'’\\-]*[\\s:]*){1,8}$");
    for (auto& pg : ctx["pages"]) {
        int page = json::toInt(pg, "page", 0);
        auto textv = json::str(pg, "text");
        std::vector<std::string> lines; { std::string cur; for (char ch : textv) { if (ch == '\n') { lines.push_back(trim(cur)); cur.clear(); } else cur += ch; } lines.push_back(trim(cur)); }
        for (size_t i = 0; i < lines.size(); ++i) {
            auto& line = lines[i];
            if (line.empty()) continue;
            std::string body; for (size_t j = i + 1; j < lines.size() && j < i + 6 && !lines[j].empty(); ++j) { body += lines[j] + " "; }
            { size_t q; while ((q = line.find("\xe2\x80\x99")) != std::string::npos) line.replace(q, 3, "'"); }
            auto l = lower(line);
            bool heading = line.size() < 70 && (std::regex_match(line, headingRe) || line == upper(line) || l.rfind("scene", 0) == 0 || l.rfind("chapter", 0) == 0 || l.rfind("npc:", 0) == 0 || l.rfind("location:", 0) == 0 || l.rfind("item:", 0) == 0 || l.rfind("handout", 0) == 0 || l.rfind("condition:", 0) == 0 || l.rfind("twist:", 0) == 0 || l.rfind("ending:", 0) == 0 || l.rfind("secret:", 0) == 0);
            if (heading) {
                std::string prefix; std::string name = line;
                if (auto p = name.find(':'); p != std::string::npos && p + 1 < name.size()) { prefix = lower(trim(name.substr(0, p))); name = trim(name.substr(p + 1)); }
                if (page == 1 && out["nodes"].empty() && line == upper(line)) { addNode("stage", name, body, page, line + " " + body); continue; }
                static const std::map<std::string, std::string> prefixTypes = {{"npc","npc"},{"location","location"},{"item","item"},{"handout","clue"},{"clue","clue"},{"secret","secret"},{"condition","condition"},{"twist","twist"},{"ending","ending"},{"scene","scene"},{"chapter","stage"},{"act","stage"},{"part","stage"}};
                std::string pt; for (auto& [k, v] : prefixTypes) if (prefix == k || prefix.rfind(k + " ", 0) == 0) pt = v;
                if (!pt.empty() && pt != "scene" && pt != "stage") {
                    auto key = addNode(pt, name, body, page, line + " " + body);
                    if (pt == "location") { currentLocation = key; if (!currentScene.empty()) addEdge(currentScene, key, "takes_place_at"); }
                    else if (pt == "condition") { if (!currentScene.empty()) addEdge(currentScene, key, "requires"); }
                    else if (pt == "twist") { if (!currentScene.empty()) addEdge(currentScene, key, "triggers"); }
                    else if (pt == "ending") { if (!currentScene.empty()) addEdge(currentScene, key, "leads_to"); }
                    else if (pt == "secret") { if (!currentScene.empty()) addEdge(key, currentScene, "hidden_in"); }
                    else if (!currentLocation.empty()) addEdge(key, currentLocation, pt == "npc" ? "found_at" : "located_in");
                    else if (!currentScene.empty()) addEdge(key, currentScene, pt == "npc" ? "appears_in" : "found_in");
                    continue;
                }
                if (anyOf(l, {"scene", "chapter", "act ", "part ", "prologue", "introduction", "the investigation", "day "})) {
                    auto key = addNode(anyOf(l, {"chapter","act ","part ","prologue","introduction"}) ? "stage" : "scene", name, body, page, line + " " + body);
                    if (!prevSceneKey.empty()) addEdge(prevSceneKey, key, "leads_to");
                    prevSceneKey = key; currentScene = key; sceneIdx++;
                } else if (anyOf(l, {"ending", "conclusion", "epilogue", "rewards", "aftermath"})) {
                    auto key = addNode("ending", name, body, page, line + " " + body); if (!currentScene.empty()) addEdge(currentScene, key, "leads_to");
                } else if (anyOf(l, {"twist", "reveal", "revelation"})) { auto key = addNode("twist", name, body, page, line + " " + body); if (!currentScene.empty()) addEdge(currentScene, key, "triggers"); }
                else if (anyOf(l, {"secret", "the truth", "what really happened", "keeper's information", "keeper information", "background"})) { auto key = addNode("secret", name, body, page, line + " " + body); if (!currentScene.empty()) addEdge(key, currentScene, "hidden_in"); }
                else if (anyOf(l, {"handout", "clue", "letter", "diary", "journal", "newspaper", "note", "ledger"})) { auto key = addNode("clue", name, body, page, line + " " + body); if (!currentLocation.empty()) addEdge(key, currentLocation, "located_in"); else if (!currentScene.empty()) addEdge(key, currentScene, "found_in"); }
                else if (guessEntityKind(name, Json::Value(Json::arrayValue)) == "location" || l.rfind("location", 0) == 0) { currentLocation = addNode("location", name, body, page, line + " " + body); if (!currentScene.empty()) addEdge(currentScene, currentLocation, "takes_place_at"); }
                else if (guessEntityKind(name, Json::Value(Json::arrayValue)) == "npc" || l.rfind("npc", 0) == 0 || anyOf(lower(body), {"str ", "con ", "dex ", "pow ", "san ", "hit points", "skills:"})) { auto key = addNode("npc", name, body, page, line + " " + body); if (!currentLocation.empty()) addEdge(key, currentLocation, "found_at"); else if (!currentScene.empty()) addEdge(key, currentScene, "appears_in"); }
                else if (guessEntityKind(name, Json::Value(Json::arrayValue)) == "item") { auto key = addNode("item", name, body, page, line + " " + body); if (!currentLocation.empty()) addEdge(key, currentLocation, "located_in"); }
                continue;
            }
            // Conditions inside prose
            static const std::regex condRe("^(?:If|Should|When|Once|Unless|Only if|Provided)\\b.*", std::regex::icase);
            if (std::regex_match(line, condRe) && line.size() > 30) {
                auto key = addNode("condition", truncate(line, 90), line, page, line);
                if (!currentScene.empty()) addEdge(currentScene, key, "requires");
            }
            // Handouts referenced in prose: "Handout 1: Elias's Letter."
            static const std::regex handoutRe("\\b(Handout\\s+\\d+\\s*:\\s*[^.;\\n]{3,60})", std::regex::icase);
            { std::smatch hm; if (std::regex_search(line, hm, handoutRe)) { auto key = addNode("clue", trim(hm[1]), line, page, line); if (!currentLocation.empty()) addEdge(key, currentLocation, "located_in"); else if (!currentScene.empty()) addEdge(key, currentScene, "found_in"); } }
            // Items/clues introduced in prose: "a brass key", "the diary of ..."
            static const std::regex itemRe("\\b(?:a|an|the)\\s+((?:(?!(?:a|an|the|investigators|he|she|they|you)\\s)\\w+\\s){0,2}(?:key|letter|diary|journal|book|tome|photograph|map|knife|amulet|ring|statue|idol|ledger|manuscript|medallion|locket|note|badge|revolver|pistol))\\b", std::regex::icase);
            std::smatch m; std::string rest = line; int guard = 0;
            while (std::regex_search(rest, m, itemRe) && guard++ < 3) {
                auto key = addNode("item", m[1], line, page, line);
                if (!currentLocation.empty()) addEdge(key, currentLocation, "located_in"); else if (!currentScene.empty()) addEdge(key, currentScene, "found_in");
                rest = m.suffix().str();
            }
        }
    }
    return out;
}

} // namespace acerciae
