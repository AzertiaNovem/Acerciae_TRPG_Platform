#include "documents/NarrativeMemoryPolicy.h"
// Core unit tests: no database required.
#include "characters/Coc7Rules.h"
#include "core/NetGuard.h"
#include "core/Text.h"
#include "core/Json.h"
#include "core/Crypto.h"
#include "core/Db.h"
#include "llm/SchemaValidator.h"
#include "llm/MockLlmClient.h"
#include "llm/LlmGateway.h"
#include "llm/AnthropicClient.h"
#include "llm/OpenAiCompatClient.h"
#include "llm/StreamResponse.h"
#include "knowledge/KnowledgeService.h"
#include "documents/DocumentService.h"
#include "logstudio/LogAdapters.h"
#include "dice/Dice.h"
#include "logstudio/TtsProvider.h"
#include "logstudio/TtsService.h"
#include "logstudio/PublicationService.h"
#include "logstudio/PresentationService.h"
#include "logstudio/VnScriptService.h"
#include "scenes/ScenarioService.h"
#include "reminders/ReminderService.h"
#include "script/ScriptKnowledgeService.h"
#include "characters/CharacterSpaceService.h"
#include "logstudio/ImageProvider.h"
#include "logstudio/ObjectStore.h"
#include <filesystem>
#include <cstdlib>
#include <zlib.h>
#include <iostream>
#include <map>
#include <functional>
#include <vector>

using namespace acerciae;
static int failures = 0, passed = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "  FAIL " << __FILE__ << ":" << __LINE__ << " " #cond "\n"; failures++; } else passed++; } while (0)
static void test(const char* name, std::function<void()> fn) { std::cout << "- " << name << "\n"; try { fn(); } catch (const std::exception& e) { std::cerr << "  EXCEPTION " << e.what() << "\n"; failures++; } }

int main() {
    test("SSE completion requires terminal events and reconstructs tool calls and usage (Responses and Messages)", [] {
        auto event=[](const Json::Value& v){return "data: "+json::dump(v)+"\r\n\r\n";};
        std::string open=": heartbeat\r\n\r\nevent: response.created\r\n";
        open+=event(json::parse(R"({"type":"response.created","response":{"status":"in_progress","output":[]}})"));
        open+=event(json::parse(R"({"type":"response.output_text.delta","output_index":0,"delta":"你"})"));
        open+=event(json::parse(R"({"type":"response.output_text.delta","output_index":0,"delta":"好"})"));
        open+=event(json::parse(R"({"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好"}]}})"));
        open+=event(json::parse(R"({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"q\":"})"));
        open+=event(json::parse(R"({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"search","arguments":"{\"q\":\"雾港\"}"}})"));
        bool incomplete=false;try{llm::responsesResponse(open);}catch(...){incomplete=true;}CHECK(incomplete);
        // A gateway that trims the terminal response still yields the finished items.
        auto answer=OpenAiCompatClient::parseResponse(llm::responsesResponse(open+event(json::parse(R"({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":8,"output_tokens":12}}})"))));
        CHECK(answer.ok);CHECK(answer.content=="你好");CHECK(answer.promptTokens==8&&answer.completionTokens==12);
        CHECK(answer.toolCalls.size()==1&&answer.toolCalls[0]["id"]=="call_1");CHECK(json::parse(answer.toolCalls[0]["arguments"].asString())["q"]=="雾港");
        bool continued=false;try{llm::responsesResponse(open+event(json::parse(R"({"type":"response.completed","response":{"status":"completed"}})"))+event(json::parse(R"({"type":"response.output_text.delta","delta":"x"})")));}catch(...){continued=true;}CHECK(continued);
        std::string anthropic;
        for(const auto& e:json::parse(R"([
          {"type":"message_start","message":{"type":"message","usage":{"input_tokens":8,"output_tokens":1}}},
          {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"search","input":{}}},
          {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"q\":"}},
          {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"原文\"}"}},
          {"type":"content_block_stop","index":0},
          {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}
        ])"))anthropic+=event(e);
        incomplete=false;try{llm::anthropicResponse(anthropic);}catch(...){incomplete=true;}CHECK(incomplete);
        auto result=AnthropicClient::parseResponse(llm::anthropicResponse(anthropic+event(json::parse(R"({"type":"message_stop"})"))));
        CHECK(result.ok);CHECK(result.promptTokens==8&&result.completionTokens==9);CHECK(json::parse(result.toolCalls[0]["arguments"].asString())["q"]=="原文");
        bool failed=false;try{llm::responsesResponse("data: {\"type\":\"error\",\"message\":\"x\"}\n\n");}catch(...){failed=true;}CHECK(failed);
        failed=false;try{llm::responsesResponse("data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n");}catch(...){failed=true;}CHECK(failed);
    });
    test("OpenAI Responses requests replay tool calls as items and parse status, refusals and usage", [] {
        LlmEndpoint ep; ep.provider="openai_compatible"; ep.model="fixture-gpt"; ep.maxTokens=4000;
        LlmRequest req; req.system="Only use authorized records"; req.maxTokens=900; req.temperature=0.3; req.responseSchema=json::parse(R"({"type":"object"})");
        req.messages.push_back({"user", "Find my clue"});
        req.tools.push_back({"search_events", "Authorized chat", json::parse(R"({"type":"object","properties":{"q":{"type":"string"}}})")});
        LlmMessage assistant; assistant.role="assistant"; assistant.toolCalls=json::parse(R"([{"id":"call_7","name":"search_events","arguments":"{\"q\":\"badge\"}"}])"); req.messages.push_back(assistant);
        LlmMessage tool; tool.role="tool"; tool.toolCallId="call_7"; tool.name="search_events"; tool.content="{\"events\":[]}"; req.messages.push_back(tool);
        auto b=OpenAiCompatClient::requestBody(req, ep);
        CHECK(b["model"]=="fixture-gpt"); CHECK(b["instructions"]=="Only use authorized records"); CHECK(b["store"]==false); CHECK(b["stream"]==true);
        CHECK(b["max_output_tokens"]==900); CHECK(b["temperature"].asDouble()==0.3); CHECK(!b.isMember("reasoning")); CHECK(!b.isMember("messages"));
        CHECK(b["text"]["format"]["type"]=="json_object");
        CHECK(b["tools"][0]["type"]=="function"); CHECK(b["tools"][0]["name"]=="search_events"); CHECK(b["tools"][0]["strict"]==false); CHECK(!b["tools"][0].isMember("function"));
        CHECK(b["input"].size()==4); CHECK(b["input"][0]["role"]=="system");
        CHECK(b["input"][0]["content"].asString().find("JSON")!=std::string::npos);
        CHECK(b["input"][1]["role"]=="user"); CHECK(b["input"][1]["content"]=="Find my clue");
        CHECK(b["input"][2]["type"]=="function_call"); CHECK(b["input"][2]["call_id"]=="call_7"); CHECK(b["input"][2]["arguments"]=="{\"q\":\"badge\"}");
        CHECK(b["input"][3]["type"]=="function_call_output"); CHECK(b["input"][3]["call_id"]=="call_7"); CHECK(b["input"][3]["output"]=="{\"events\":[]}");
        ep.reasoningEffort="high"; b=OpenAiCompatClient::requestBody(req, ep);
        CHECK(b["reasoning"]["effort"]=="high"); CHECK(!b.isMember("temperature"));
        req.responseSchema=Json::Value(); b=OpenAiCompatClient::requestBody(req, ep);
        CHECK(!b.isMember("text")); CHECK(b["input"].size()==3); CHECK(b["input"][0]["role"]=="user");
        auto ok=OpenAiCompatClient::parseResponse(json::parse(R"({"status":"completed","output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"{\"draft\":"},{"type":"output_text","text":"\"x\"}"}]}],"usage":{"input_tokens":5,"output_tokens":7}})"));
        CHECK(ok.ok); CHECK(ok.content=="{\"draft\":\"x\"}"); CHECK(ok.toolCalls.empty()); CHECK(ok.completionTokens==7);
        auto cut=OpenAiCompatClient::parseResponse(json::parse(R"({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"{"}]}]})"));
        CHECK(!cut.ok); CHECK(cut.error.find("output token limit")!=std::string::npos);
        auto refused=OpenAiCompatClient::parseResponse(json::parse(R"({"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}]})"));
        CHECK(!refused.ok); CHECK(refused.error.find("declined")!=std::string::npos);
        CHECK(!OpenAiCompatClient::parseResponse(json::parse(R"({"status":"failed","error":{"message":"x"}})")).ok);
        CHECK(!OpenAiCompatClient::parseResponse(json::parse(R"({"status":"completed","output":[]})")).ok);
    });
    test("Anthropic Messages preserves tool blocks, schema and parallel result turns", [] {
        LlmEndpoint ep; ep.provider="anthropic"; ep.model="fixture-claude"; ep.reasoningEffort="high";
        LlmRequest req; req.system="Only use authorized records"; req.responseSchema=json::parse(R"({"type":"object","required":["draft"]})");
        req.messages.push_back({"user", "Find my clue"});
        req.tools.push_back({"search_events", "Authorized chat", json::parse(R"({"type":"object"})")});
        auto response=AnthropicClient::parseResponse(json::parse(R"({"type":"message","stop_reason":"tool_use","content":[{"type":"text","text":"Checking"},{"type":"tool_use","id":"t1","name":"search_events","input":{"query":"clue"}},{"type":"tool_use","id":"t2","name":"search_events","input":{}}],"usage":{"input_tokens":10,"output_tokens":20}})"));
        CHECK(response.ok); CHECK(response.toolCalls.size()==2); CHECK(response.promptTokens==10); CHECK(response.completionTokens==20);
        LlmMessage assistant; assistant.role="assistant"; assistant.content=response.content; assistant.toolCalls=response.toolCalls; assistant.providerContent=response.providerContent; req.messages.push_back(assistant);
        for (const auto& id : {"t1", "t2"}) { LlmMessage m; m.role="tool"; m.toolCallId=id; m.content="[]"; req.messages.push_back(m); }
        auto body=AnthropicClient::requestBody(req, ep);
        CHECK(body["messages"].size()==3); CHECK(body["messages"][2]["role"]=="user"); CHECK(body["messages"][2]["content"].size()==2);
        CHECK(body["messages"][2]["content"][1]["tool_use_id"]=="t2"); CHECK(body["messages"][1]["content"]==response.providerContent);
        CHECK(body["tools"][0].isMember("input_schema")); CHECK(body["system"].asString().find("required")!=std::string::npos);
        CHECK(!body.isMember("reasoning_effort")); CHECK(!body.isMember("response_format"));
        CHECK(!AnthropicClient::parseResponse(json::parse(R"({"type":"error"})")).ok);
        CHECK(!AnthropicClient::parseResponse(json::parse(R"({"content":[],"stop_reason":"max_tokens"})")).ok);
        CHECK(!AnthropicClient::parseResponse(json::parse(R"({"content":[{"type":"tool_use","input":{}}]})")).ok);
        auto final=AnthropicClient::parseResponse(json::parse(R"({"content":[{"type":"text","text":"{\"draft\":\"ok\"}"}],"usage":{}})"));
        CHECK(final.ok); CHECK(final.content=="{\"draft\":\"ok\"}");
    });
    test("text utilities", [] {
        auto kw = text::keywords("The Sheriff promised to bring the lighthouse key tomorrow.");
        CHECK(std::find(kw.begin(), kw.end(), "sheriff") != kw.end());
        CHECK(std::find(kw.begin(), kw.end(), "lighthouse") != kw.end());
        CHECK(std::find(kw.begin(), kw.end(), "the") == kw.end());
        auto pn = text::properNouns("I walk to the Blackwater Docks and meet Jonah Pike at midnight.");
        CHECK(std::find(pn.begin(), pn.end(), "Blackwater Docks") != pn.end());
        CHECK(std::find(pn.begin(), pn.end(), "Jonah Pike") != pn.end());
        auto q = text::quotedSpeech("He smiles. \"I promise I'll bring the key.\" Then: “Stay off the water.”");
        CHECK(q.size() == 2);
        CHECK(q[0] == "I promise I'll bring the key.");
        CHECK(text::icontains("Tarnished BADGE", "badge"));
    });
    test("password hashing", [] {
        auto h = crypto::hashPassword("secret-pw");
        CHECK(crypto::verifyPassword("secret-pw", h));
        CHECK(!crypto::verifyPassword("wrong", h));
        CHECK(crypto::uuid4().size() == 36);
    });
    test("pg array literal escaping", [] {
        CHECK(pgArrayLiteral({"a", "b\"c"}) == "{\"a\",\"b\\\"c\"}");
        CHECK(pgArrayLiteral({}) == "{}");
    });
    test("schema validator", [] {
        auto schema = json::parse(R"({"type":"object","required":["score","conflicts"],"properties":{"score":{"type":["integer","null"],"minimum":0,"maximum":100},"conflicts":{"type":"array","items":{"type":"object","required":["description"]}},"mode":{"type":"string","enum":["a","b"]}}})");
        std::vector<std::string> errs;
        CHECK(SchemaValidator::validate(schema, json::parse(R"({"score":50,"conflicts":[{"description":"x"}]})"), errs));
        CHECK(SchemaValidator::validate(schema, json::parse(R"({"score":null,"conflicts":[]})"), errs));
        errs.clear(); CHECK(!SchemaValidator::validate(schema, json::parse(R"({"score":150,"conflicts":[]})"), errs)); CHECK(!errs.empty());
        errs.clear(); CHECK(!SchemaValidator::validate(schema, json::parse(R"({"conflicts":[{"x":1}]})"), errs)); CHECK(errs.size() == 2);
        errs.clear(); CHECK(!SchemaValidator::validate(schema, json::parse(R"({"score":1,"conflicts":[],"mode":"c"})"), errs));
    });
    test("knowledge scope algebra", [] {
        KnowledgeScope pub{"public", {}}, gm{"gm", {}}, c1{"character", {"a", "b"}}, c2{"character", {"b", "c"}};
        CHECK(gm.narrowerThan(pub)); CHECK(!pub.narrowerThan(gm)); CHECK(c1.narrowerThan(pub)); CHECK(!c1.narrowerThan(c2));
        auto i = c1.intersect(c2); CHECK(i.scope == "character" && i.characterIds.size() == 1 && i.characterIds[0] == "b");
        auto e = KnowledgeScope{"character", {"a"}}.intersect(KnowledgeScope{"character", {"c"}}); CHECK(e.scope == "gm");
        CHECK(pub.intersect(c1).scope == "character");
    });
    test("mock observer extraction distinguishes attempt / confirmation / claim / hypothesis", [] {
        Json::Value ctx; ctx["scene"]["id"] = "s1"; ctx["scene"]["location"] = "Sheriff's Office"; ctx["scene"]["participants"] = Json::Value(Json::arrayValue);
        Json::Value p; p["name"] = "Nora Blake"; p["character_id"] = "c1"; ctx["scene"]["participants"].append(p);
        ctx["characters"] = Json::Value(Json::arrayValue); Json::Value ch; ch["name"] = "Nora Blake"; ch["kind"] = "pc"; ctx["characters"].append(ch);
        ctx["related_history"] = Json::Value(Json::arrayValue); ctx["module_nodes"] = Json::Value(Json::arrayValue);
        auto ev = [&](const std::string& id, const std::string& role, const std::string& who, const std::string& content) { Json::Value e; e["event_id"] = id; e["actor_role"] = role; e["character_name"] = who; e["kind"] = "message.posted"; e["content"] = content; ctx["new_events"].append(e); };
        ev("e1", "player", "Nora Blake", "I try the editor's safe. I pick the lock.");
        ev("e2", "gm", "", "The safe clicks open. Inside, Nora discovers secret documents: a ledger of payments from the Lantern Society to Sheriff Dunmore.");
        ev("e3", "gm", "", "Dunmore smiles. \"I promise I'll look for the key and bring it to you.\"");
        ev("e4", "player", "Nora Blake", "Maybe the Sheriff is hiding something.");
        auto out = MockLlmClient::observerExtract(ctx);
        std::map<std::string, Json::Value> docs; for (auto& pr : out["proposals"]) docs[pr["document_type"].asString()] = pr["ops"];
        bool attempted = false, confirmedClue = false, promise = false, hypothesis = false;
        for (auto& op : docs["current_scene"]) if (op["fact"]["status"] == "attempted" && op["fact"]["source_event_ids"][0] == "e1") attempted = true;
        for (auto& op : docs["clue_journal"]) if (op["fact"]["status"] == "confirmed" && op["fact"]["source_event_ids"][0] == "e2") confirmedClue = true;
        for (auto& op : docs["relationships"]) if (op["fact"]["data"]["relation"] == "promised" && op["fact"]["status"] == "npc_claim") promise = true;
        for (auto& op : docs["open_threads"]) if (op["fact"]["status"] == "hypothesis") hypothesis = true;
        CHECK(attempted); CHECK(confirmedClue); CHECK(promise); CHECK(hypothesis);
        // every op cites a source event from the batch
        for (auto& [d, ops] : docs) for (auto& op : ops) { auto src = op.isMember("fact") ? op["fact"]["source_event_ids"] : op["source_event_ids"]; CHECK(src.isArray() && !src.empty()); }
    });
    test("mock observer highlights historical foreshadowing", [] {
        Json::Value ctx; ctx["scene"]["id"] = "s3"; ctx["scene"]["location"] = "Hale Boarding House"; ctx["characters"] = Json::Value(Json::arrayValue); ctx["module_nodes"] = Json::Value(Json::arrayValue);
        Json::Value h; h["fact_id"] = "f-badge"; h["document_type"] = "clue_journal"; h["summary"] = "a tarnished badge with a lantern sigil"; h["scene_title"] = "Session 1"; h["matched_terms"].append("badge"); ctx["related_history"].append(h);
        Json::Value e; e["event_id"] = "e9"; e["actor_role"] = "player"; e["character_name"] = "Thomas Reed"; e["kind"] = "message.posted"; e["content"] = "I put the tarnished badge on the table."; ctx["new_events"].append(e);
        auto out = MockLlmClient::observerExtract(ctx);
        CHECK(out["highlights"].size() == 1); CHECK(out["highlights"][0]["fact_id"] == "f-badge"); CHECK(out["highlights"][0]["source_event_ids"][0] == "e9");
        bool appended = false; for (auto& pr : out["proposals"]) if (pr["document_type"] == "clue_journal") for (auto& op : pr["ops"]) if (op["op"] == "append_text" && op["fact_id"] == "f-badge") appended = true;
        CHECK(appended);
    });
    test("mock consistency flags promised-but-not-delivered item", [] {
        Json::Value ctx; ctx["draft"] = "I take out the key that the Sheriff gave me last week and unlock the basement.";
        ctx["character"]["name"] = "Harvey Walters"; ctx["scene"]["location"] = "Hale Boarding House"; ctx["rule_system"] = "coc7e";
        Json::Value f; f["fact_id"] = "f1"; f["kind"] = "relationship"; f["summary"] = "Sheriff Amos Dunmore promises Harvey Walters: \"I promise I'll look for it and bring you the key\""; f["status"] = "npc_claim"; f["data"]["relation"] = "promised"; ctx["known_facts"].append(f);
        auto out = MockLlmClient::consistency(ctx);
        CHECK(!out["insufficient_evidence"].asBool()); CHECK(out["score"].asInt() < 70); CHECK(out["conflicts"].size() >= 1);
        CHECK(out["conflicts"][0]["evidence_fact_ids"][0] == "f1");
        Json::Value ctx2 = ctx; ctx2["known_facts"] = Json::Value(Json::arrayValue); ctx2["draft"] = "I whistle a tune.";
        auto out2 = MockLlmClient::consistency(ctx2);
        CHECK(out2["insufficient_evidence"].asBool()); CHECK(out2["score"].isNull());
    });
    test("mock inspiration uses only known facts and never auto-sends", [] {
        Json::Value ctx; ctx["character"]["name"] = "Nora Blake"; ctx["character"]["speaking_style"] = "blunt"; ctx["scene"]["location"] = "Gazette Office";
        Json::Value m; m["actor_role"] = "gm"; m["content"] = "Dunmore says, \"Nobody goes out there now.\""; ctx["recent_messages"].append(m);
        Json::Value f; f["fact_id"] = "f-clue"; f["kind"] = "clue"; f["summary"] = "secret documents"; f["data"]["title"] = "secret documents"; ctx["known_facts"].append(f);
        auto out = MockLlmClient::inspiration(ctx);
        CHECK(!out["draft"].asString().empty()); CHECK(out["used_fact_ids"].size() >= 1);
        ctx["variant"] = 1; auto out2 = MockLlmClient::inspiration(ctx); CHECK(out2["draft"] != out["draft"]);
    });
    test("mock module structuring produces cited nodes and edges", [] {
        Json::Value ctx; Json::Value pg; pg["page"] = 2; pg["text"] = "Chapter One: Arrival\n\nScene: The Sheriff's Office\nSheriff Amos Dunmore receives the investigators. A tarnished badge lies on the desk.\n\nNPC: Sheriff Amos Dunmore\nSTR 70 CON 65. Skills: Persuade 60%.\n\nItem: The Lighthouse Key\nAn iron key held by the Sheriff.\nIf the investigators obtain the key they may enter the lighthouse.\n"; ctx["pages"].append(pg);
        auto out = MockLlmClient::moduleStructure(ctx);
        std::set<std::string> types; for (auto& n : out["nodes"]) { types.insert(n["node_type"].asString()); CHECK(n["citations"][0]["page"] == 2); }
        CHECK(types.count("scene")); CHECK(types.count("npc")); CHECK(types.count("item")); CHECK(types.count("condition")); CHECK(types.count("stage"));
        CHECK(out["edges"].size() >= 2);
    });
    test("gateway validates mock output against schema", [] {
        Config cfg; LlmGateway gw(cfg, std::make_unique<MockLlmClient>());
        LlmRequest req; req.task = "consistency"; req.responseSchema = json::parse(R"({"type":"object","required":["rationale","conflicts"]})");
        LlmMessage u; u.role = "user"; Json::Value ctx; ctx["draft"] = "hello"; ctx["known_facts"] = Json::Value(Json::arrayValue); u.content = json::dump(ctx); req.messages.push_back(u);
        auto o = gw.runStructured(req); CHECK(o.ok); CHECK(o.data.isMember("conflicts")); CHECK(gw.isMock("any-channel"));
    });
    test("document entry rendering", [] {
        Json::Value f; f["summary"] = "A brass key"; f["status"] = "confirmed"; f["data"]["title"] = "Brass key"; f["data"]["source"] = "found at the docks";
        auto md = DocumentService::renderEntry("clue", f); CHECK(md.find("**Brass key**") != std::string::npos); CHECK(md.find("status: confirmed") != std::string::npos);
        CHECK(DocumentService::titleFor("open_threads") == "Open Threads");
    });
    test("log studio: SealDice text log import keeps every line, order, dice, OOC and renames", [] {
        using namespace logstudio;
        std::string txt =
            "前言：这是一段未格式化的说明。\n"
            "守秘人(10001) 2023/05/06 20:11:12\n夜色下的黑水湾，灯塔没有亮。\n第二行 narration continues.\n\n"
            "哈维·沃尔特斯(20002) 2023/05/06 20:11:40\n“警长，我们想去灯塔看看。” I remove my hat.\n\n"
            "海豹骰娘(30003) 2023/05/06 20:12:01\n哈维·沃尔特斯的侦查检定结果为: D100=37/55 成功\n\n"
            "哈维·沃尔特斯(20002) 2023/05/06 20:12:30\n（ooc：今晚几点结束？）\n\n"
            "Harvey(20002) 2023/05/06 20:13:00\n我把帽子放在桌上。[CQ:image,file=abc.jpg]\n";
        AdapterRegistry reg; auto* ad = reg.detect(txt);
        CHECK(ad && ad->name() == "sealdice_text");
        auto log = ad->parse(txt);
        CHECK(log.events.size() == 6);                       // leading note + 5 messages
        CHECK(log.events[0].unrecognised && log.events[0].content.find("前言") != std::string::npos);
        CHECK(log.events[1].speakerRole == "gm" && log.events[1].eventType == "narration");
        CHECK(log.events[1].content == "夜色下的黑水湾，灯塔没有亮。\n第二行 narration continues.\n\n");
        CHECK(log.events[2].eventType == "dialogue" && log.events[2].content.rfind("\xe2\x80\x9c", 0) == 0);
        CHECK(log.events[3].eventType == "dice_roll" && log.events[3].dice && log.events[3].dice->total == 37 && log.events[3].dice->outcome == "成功" && log.events[3].dice->checkName == "侦查");
        CHECK(log.events[4].eventType == "ooc");
        CHECK(log.events[5].eventType == "media" && !log.events[5].media.isNull() && log.events[5].media[0]["file"] == "abc.jpg");
        CHECK(log.events[5].content.find("[CQ:image") != std::string::npos && log.events[5].metadata["display_text_without_cq"].asString().find("[CQ:") == std::string::npos);
        CHECK(log.events[2].occurredAtUnix.has_value());
        for (size_t i = 1; i < log.events.size(); ++i) CHECK(log.events[i].sequenceNumber == log.events[i-1].sequenceNumber + 1);
        // same IM id under two nicknames → two speaker keys (mapping is a user decision)
        int harvey = 0; for (auto& sp : log.speakers) if (sp.imUserId == "20002") harvey++;
        CHECK(harvey == 2); CHECK(log.issues.size() == 1);
        // round trip through native JSON preserves text verbatim
        auto j = toNativeJson(log.events, Json::Value(Json::objectValue));
        CHECK(j["schemaVersion"] == "1.0");
        auto* nat = reg.detect(json::dump(j)); CHECK(nat && nat->name() == "native_json");
        auto back = nat->parse(json::dump(j)); CHECK(back.events.size() == log.events.size()); CHECK(back.events[1].content == log.events[1].content);
    });
    test("log studio: SealDice JSON, rendered and QQ export detection", [] {
        using namespace logstudio; AdapterRegistry reg;
        std::string sj = R"({"version":105,"items":[{"nickname":"KP","IMUserId":"QQ:1","time":1683375072,"message":"门开了。\r\n里面一片漆黑。","isDice":false,"commandId":0},{"nickname":"海豹","IMUserId":"QQ:2","time":1683375080,"message":"KP的侦查检定结果为: D100=90/50 失败","isDice":true,"commandId":1,"commandInfo":{"rule":"coc7","items":[{"expr1":"D100","checkVal":90,"attr":"侦查","rank":-1}]}}]})";
        auto* a1 = reg.detect(sj); CHECK(a1 && a1->name() == "sealdice_json");
        auto l1 = a1->parse(sj); CHECK(l1.events.size() == 2); CHECK(l1.events[0].content == "门开了。\r\n里面一片漆黑。"); CHECK(l1.events[1].speakerRole == "dice" && l1.events[1].eventType == "dice_roll" && l1.events[1].dice->checkName == "侦查" && l1.events[1].dice->total == 90); CHECK(l1.formatVersion == "105");
        std::string rendered = "2022/08/18 19:43:21<Keeper(904002355)>:领航技能会判定自动失败\n2022/08/18 19:43:32<昆特·爱尔芙(562308967)>:唔……那我的信息有没有什么可以利用的）\n继续上一行\n";
        auto* a2 = reg.detect(rendered); CHECK(a2 && a2->name() == "rendered_log");
        auto l2 = a2->parse(rendered); CHECK(l2.events.size() == 2); CHECK(l2.events[1].content == "唔……那我的信息有没有什么可以利用的）\n继续上一行\n"); CHECK(l2.speakers[0].imUserId == "QQ:904002355");
        std::string qq = "2022-05-10 11:28:25 名字(12345)\n你好\n2022-05-10 11:28:30 别人<67890>\n再见\n";
        auto* a3 = reg.detect(qq); CHECK(a3 && a3->name() == "qq_export");
        auto l3 = a3->parse(qq); CHECK(l3.events.size() == 2 && l3.events[0].content == "你好\n" && l3.events[1].content == "再见\n");
        CHECK(reg.detect("just some prose without any header") == nullptr);
        std::string enc; auto s16 = normaliseEncoding(std::string("\xFF\xFE" "A\x00" "B\x00", 6), enc); CHECK(s16 == "AB" && enc == "utf-16le");
        CHECK(normaliseEncoding(std::string("\xD6\xD0\xCE\xC4",4),enc)=="中文" && enc=="gb18030-inferred");
        bool bad=false;try{normaliseEncoding(std::string("\xFF",1),enc);}catch(const std::invalid_argument&){bad=true;}CHECK(bad);
    });
    test("dice expressions", [] {
        dice::SeqRng rng({2, 5, 1, 6});
        auto r = dice::evaluate("3d6+2", rng); CHECK(r.total == 10); CHECK(r.detail == "[2+5+1]+2");
        dice::SeqRng r2({47}); auto d = dice::evaluate("d%", r2); CHECK(d.total == 47);
        dice::SeqRng r3({6, 1, 5, 3}); auto k = dice::evaluate("4d6k3", r3); CHECK(k.total == 14);
        dice::SeqRng r4({3, 4}); CHECK(dice::evaluate("(2d6+6)*5", r4).total == 65);
        CHECK(dice::isExpression("1d100")); CHECK(dice::isExpression("2d6 + 3")); CHECK(!dice::isExpression("dodge")); CHECK(!dice::isExpression("1d0"));
        dice::SeqRng r5({}); bool threw = false; try { dice::evaluate("5/0", r5); } catch (const dice::DiceError&) { threw = true; } CHECK(threw);
    });
    test("dice CoC7 success levels and bonus/penalty dice", [] {
        using L = dice::Level;
        CHECK(dice::successLevel(1, 40) == L::Critical); CHECK(dice::successLevel(100, 90) == L::Fumble); CHECK(dice::successLevel(97, 45) == L::Fumble);
        CHECK(dice::successLevel(97, 60) == L::Failure); CHECK(dice::successLevel(10, 53) == L::Extreme); CHECK(dice::successLevel(26, 53) == L::Hard);
        CHECK(dice::successLevel(53, 53) == L::Regular); CHECK(dice::successLevel(54, 53) == L::Failure);
        dice::SeqRng b({4, 3, 1}); auto bonus = dice::rollD100(b, 1, 0); CHECK(bonus.roll == 3); CHECK(bonus.tens.size() == 2);   // units 3, tens 20/00 -> min(23, 3)
        dice::SeqRng p({4, 3, 1}); CHECK(dice::rollD100(p, 0, 1).roll == 23);
        dice::SeqRng z({1, 1}); CHECK(dice::rollD100(z, 0, 1).roll == 100);   // 00 + 0 reads as 100
    });
    test("dice attribute aliases and CoC base values", [] {
        Json::Value attrs; attrs["DEX"] = 60; attrs["EDU"] = 70; attrs["research"] = 53; attrs["Spot Hidden"] = 55;
        CHECK(dice::canonicalName("侦查") == "Spot Hidden"); CHECK(dice::canonicalName("spothidden") == "Spot Hidden"); CHECK(dice::canonicalName("san") == "SAN");
        CHECK(dice::canonicalName("理智") == "SAN"); CHECK(dice::canonicalName("research") == "research");
        auto v = dice::lookup(attrs, "侦查"); CHECK(v.found && v.value == 55 && !v.isBase);
        auto dodge = dice::lookup(attrs, "dodge"); CHECK(dodge.found && dodge.value == 30 && dodge.isBase);
        CHECK(dice::lookup(attrs, "母语").value == 70); CHECK(dice::lookup(attrs, "library").value == 20); CHECK(!dice::lookup(attrs, "unknownskill").found);
        Json::Value legacy; legacy["occupation"] = "Journalist"; legacy["STR"] = 55; legacy["skills"]["Spot Hidden"] = 40;
        auto n = dice::normalizeSheet(legacy); CHECK(n["attrs"]["STR"].asInt() == 55); CHECK(n["attrs"]["Spot Hidden"].asInt() == 40); CHECK(!n.isMember("STR")); CHECK(n["occupation"].asString() == "Journalist"); CHECK(!n.isMember("skills"));
    });
    test("skill names in the server language: accepted next to English, shown in replies", [] {
        // Every skill and characteristic has a name in every server language, and no name means two things.
        for (auto& lang : dice::nameLanguages()) {
            std::map<std::string, std::string> seen;
            for (auto& c : dice::namedCanonicals()) {
                auto n = dice::localName(c, lang); CHECK(!n.empty());
                auto [it, fresh] = seen.emplace(dice::normKey(n), c);
                if (!fresh) std::cerr << "  duplicate " << lang << " name " << n << ": " << it->second << " / " << c << "\n";
                CHECK(fresh);
            }
        }
        for (auto& d : dice::skillDefs()) CHECK(dice::localNames(d.name).size() == dice::nameLanguages().size());
        CHECK(dice::canonicalName("目星", "ja") == "Spot Hidden"); CHECK(dice::canonicalName("目星") == "目星");
        CHECK(dice::canonicalName("Spot Hidden", "ja") == "Spot Hidden"); CHECK(dice::canonicalName("侦查", "ja") == "Spot Hidden");
        CHECK(dice::canonicalName("体力", "ja") == "CON"); CHECK(dice::canonicalName("体力") == "HP");   // the server language wins
        CHECK(dice::canonicalName("внимательность", "ru") == "Spot Hidden"); CHECK(dice::canonicalName("ÉCOUTER", "fr") == "Listen");
        CHECK(dice::canonicalName("偵查", "zh-TW") == "Spot Hidden"); CHECK(dice::canonicalName("근접전(맨손)", "ko") == "Fighting (Brawl)");
        CHECK(dice::canonicalName("科学(生物学)", "ja") == "Science (生物学)"); CHECK(dice::canonicalName("近接戦闘（刀剣）", "ja") == "Fighting (刀剣)");
        CHECK(dice::displayName("Spot Hidden", "ja") == "目星"); CHECK(dice::displayName("Spot Hidden", "en") == "Spot Hidden");
        CHECK(dice::displayName("Science (Biology)", "zh-CN") == "科学（Biology）"); CHECK(dice::displayName("Science (Biology)", "de") == "Naturwissenschaft (Biology)");
        CHECK(dice::displayName("research", "ja") == "research"); CHECK(dice::displayName("侦查", "fr") == "Trouver objet caché");

        dice::TextSet en; dice::TextSet zh("zh", Json::Value());
        dice::Context ja; ja.name = "Aki"; ja.hasCharacter = true; ja.language = "ja"; ja.attrs["Spot Hidden"] = 50; ja.attrs["DEX"] = 60;
        dice::SeqRng r1({20}); auto o = dice::execute(*dice::parseCommand(".ra 目星"), ja, en, r1);
        CHECK(o.text == "Aki's 目星 check: D100=20/50 — Hard Success"); CHECK(o.detail["attr"].asString() == "Spot Hidden");
        dice::SeqRng r2({20}); CHECK(dice::execute(*dice::parseCommand(".ra spot hidden"), ja, en, r2).text == o.text);
        CHECK(dice::preview(*dice::parseCommand(".ra 回避"), ja, en) == "Aki's 回避 is 30 (base value)");
        dice::SeqRng r3({1}); auto st = dice::execute(*dice::parseCommand(".st 図書館60 聞き耳 55"), ja, en, r3);
        CHECK(st.attrs["Library Use"].asInt() == 60); CHECK(st.attrs["Listen"].asInt() == 55); CHECK(st.text.find("図書館 60") != std::string::npos);
        dice::Context zhCtx = ja; zhCtx.language = "zh-CN";
        dice::SeqRng r4({20}); CHECK(dice::execute(*dice::parseCommand(".ra 侦查"), zhCtx, zh, r4).text.find("侦查") != std::string::npos);
        dice::Context enCtx = ja; enCtx.language = "en";
        CHECK(dice::preview(*dice::parseCommand(".ra 目星"), enCtx, en).find("目星") != std::string::npos);   // not a skill name here
        CHECK(!dice::lookup(enCtx.attrs, "目星", "en").found);
    });
    test("dice command parsing (Sealdice syntax)", [] {
        auto c = dice::parseCommand(".ra research"); CHECK(c && c->name == "ra" && c->args == "research" && !c->hidden);
        auto zh = dice::parseCommand("。ra侦查"); CHECK(zh && zh->name == "ra" && zh->args == "侦查");
        auto rh = dice::parseCommand(".rh 1d20"); CHECK(rh && rh->name == "r" && rh->hidden);
        auto rah = dice::parseCommand(".rah spot"); CHECK(rah && rah->name == "ra" && rah->hidden);
        CHECK(dice::parseCommand(".r3d6") && dice::parseCommand(".r3d6")->args == "3d6");
        CHECK(dice::parseCommand(".rd20")); CHECK(dice::parseCommand(".rc 侦查")->name == "ra");
        CHECK(!dice::parseCommand(".random thought")); CHECK(!dice::parseCommand("...")); CHECK(!dice::parseCommand("hello .ra x")); CHECK(!dice::parseCommand(".stats"));
    });
    test("dice command execution", [] {
        dice::TextSet en; dice::TextSet zh("zh", Json::Value());
        dice::Context ctx; ctx.name = "Alice"; ctx.hasCharacter = true; ctx.attrs["research"] = 53; ctx.attrs["SAN"] = 60; ctx.attrs["Spot Hidden"] = 50;
        CHECK(dice::preview(*dice::parseCommand(".ra research"), ctx, en) == "Alice's research is 53");
        CHECK(dice::preview(*dice::parseCommand(".ra hard research"), ctx, en) == "Alice's research is 53 (Hard target ≤ 26)");
        CHECK(dice::preview(*dice::parseCommand(".ra 侦查"), ctx, zh) == "Alice的Spot Hidden为50");
        dice::SeqRng r1({20});
        auto o = dice::execute(*dice::parseCommand(".ra research"), ctx, en, r1);
        CHECK(o.text == "Alice's research check: D100=20/53 — Hard Success"); CHECK(!o.attrsChanged);
        dice::SeqRng r2({30}); auto hard = dice::execute(*dice::parseCommand(".ra 困难research"), ctx, en, r2);
        CHECK(hard.text.find("Failure") != std::string::npos); CHECK(hard.detail["difficulty"].asString() == "hard");
        dice::SeqRng r3({40}); auto withValue = dice::execute(*dice::parseCommand(".ra climb 70 the wall"), ctx, en, r3);
        CHECK(withValue.text == "Alice's Climb check (the wall): D100=40/70 — Success");
        dice::SeqRng r4({50, 4}); auto sc = dice::execute(*dice::parseCommand(".sc 1/1d6"), ctx, en, r4);
        CHECK(sc.attrsChanged && sc.attrs["SAN"].asInt() == 59);
        dice::SeqRng r5({80, 5}); auto scFail = dice::execute(*dice::parseCommand(".sc 1/1d6"), ctx, en, r5);
        CHECK(scFail.attrs["SAN"].asInt() == 55); CHECK(scFail.text.find("temporary insanity") != std::string::npos);
        dice::SeqRng r6({}); auto st = dice::execute(*dice::parseCommand(".st str60 dex 50 Library Use: 70 力量65"), ctx, en, r6);
        CHECK(st.attrs["STR"].asInt() == 65); CHECK(st.attrs["DEX"].asInt() == 50); CHECK(st.attrs["Library Use"].asInt() == 70); CHECK(st.attrs["research"].asInt() == 53);
        dice::SeqRng r7({3}); auto mod = dice::execute(*dice::parseCommand(".st san-1d6"), ctx, en, r7);
        CHECK(mod.attrs["SAN"].asInt() == 57); CHECK(mod.text == "Alice: SAN 60 → 57 (-1d6=-3)");
        dice::SeqRng r8({}); auto del = dice::execute(*dice::parseCommand(".st del research"), ctx, en, r8); CHECK(!del.attrs.isMember("research"));
        dice::SeqRng r9({96, 7}); auto grow = dice::execute(*dice::parseCommand(".en spot hidden"), ctx, en, r9);
        CHECK(grow.attrs["Spot Hidden"].asInt() == 57);
        dice::SeqRng r10({4, 2}); auto roll = dice::execute(*dice::parseCommand(".r 2d6 damage"), ctx, en, r10);
        CHECK(roll.text == "Alice rolls (damage): 2d6=[4+2]=6");
        dice::Context nobody; nobody.name = "Bob";
        bool threw = false; try { dice::SeqRng r({}); dice::execute(*dice::parseCommand(".ra research"), nobody, en, r); } catch (const dice::DiceError& e) { threw = std::string(e.what()).find(".ra") != std::string::npos; }
        CHECK(threw);
        Json::Value custom; custom["check.result"] = "{name} → {attr}: {roll} vs {target} = {level}"; custom["level.hard"] = "HARD!";
        dice::TextSet group("en", custom); dice::SeqRng r11({20});
        CHECK(dice::execute(*dice::parseCommand(".ra research"), ctx, group, r11).text == "Alice → research: 20 vs 53 = HARD!");
    });
    test("studio render configuration rejects injection and preserves bounded settings", [] {
        Json::Value c;c["base"]="novel";auto safe=logstudio::PublicationService::validateConfig(c);CHECK(safe["page_size"]=="A5");
        bool rejected=false;c["page_size"]="A4; @import url(http://localhost)";try{logstudio::PublicationService::validateConfig(c);}catch(...){rejected=true;}CHECK(rejected);
        c.removeMember("page_size");c["character_colors"]["gm"]="red; background:url(http://localhost)";rejected=false;try{logstudio::PublicationService::validateConfig(c);}catch(...){rejected=true;}CHECK(rejected);
    });
    test("visual-novel template keeps bounded overrides and rejects CSS injection", [] {
        using logstudio::PresentationService;
        auto rejects = [](const Json::Value& t) { try { PresentationService::validateVnTemplate(t); return false; } catch (...) { return true; } };
        Json::Value t; t["base"] = "dossier"; t["text_scale"] = 1.234; t["letterbox"] = true; t["accent_color"] = "#8B1E1E"; t["unknown"] = "x";
        t["character_colors"]["c1"] = "#112233";
        auto safe = PresentationService::validateVnTemplate(t);
        CHECK(safe["base"] == "dossier"); CHECK(safe["text_scale"].asDouble() == 1.23); CHECK(safe["letterbox"].asBool());
        CHECK(!safe.isMember("unknown")); CHECK(!safe.isMember("font")); CHECK(safe["character_colors"]["c1"] == "#112233");
        CHECK(PresentationService::validateVnTemplate(Json::Value(Json::objectValue))["base"] == "adv");
        Json::Value bad = t; bad["base"] = "custom"; CHECK(rejects(bad));
        bad = t; bad["accent_color"] = "red; background:url(http://localhost)"; CHECK(rejects(bad));
        bad = t; bad["character_colors"]["c2"] = "#12345"; CHECK(rejects(bad));
        bad = t; bad["text_scale"] = 3; CHECK(rejects(bad));
        bad = t; bad["box_opacity"] = "0.5"; CHECK(rejects(bad));
        bad = t; bad["font"] = "Arial; } body { display:none"; CHECK(rejects(bad));
        bad = t; bad["letterbox"] = "yes"; CHECK(rejects(bad));
        Json::Value settings; settings["typewriter_cps"] = 30; settings["template"] = Json::Value(Json::nullValue);
        auto cleaned = PresentationService::sanitizeSettings(settings); CHECK(!cleaned.isMember("template")); CHECK(cleaned["typewriter_cps"] == 30);
    });
    test("visual-novel script keeps every canonical line and only hides lines excluded with a reason", [] {
        using logstudio::VnScriptService; using logstudio::LogEvent;
        logstudio::ScriptInputs in;
        auto ev = [&](std::string id, std::string win, std::string scene, std::string type, std::string who, std::string text) {
            LogEvent e; e.eventId = id; e.chatWindowId = win; e.sceneKey = scene; e.sceneTitle = scene == "s1" ? "Library" : "Docks"; e.eventType = type; e.speakerCharacterId = who; e.content = text; return e; };
        in.events = {ev("e1","wA","s1","dialogue","c1","The ledger is missing."), ev("e2","wB","s2","dialogue","c2","Fog on the water."),
                     ev("e3","wA","s1","ooc","","brb"), ev("e4","wB","s2","action","c2","She lowers the lamp."), ev("e5","wA","s1","dialogue","c1","Check the shelves.")};
        in.windowNames = {{"wA","Library window"},{"wB","Harbour window"}};
        in.cast = json::parse(R"([{"ref":"C1","character_id":"c1","name":"Ada","kind":"pc","default_asset_id":"std-ada"},{"ref":"C2","character_id":"c2","name":"Mo","kind":"pc","default_asset_id":null}])");
        in.assets = json::parse(R"([{"ref":"B1","id":"bg-lib","type":"background","name":"Library at night","tags":[],"character_id":null,"expression":""},{"ref":"S1","id":"std-mo-fear","type":"standee","name":"Mo afraid","tags":[],"character_id":"c2","expression":"afraid"}])");
        // Two model parts: the second continues scene "library" and references things that do not exist.
        auto part1 = json::parse(R"({"scenes":[{"key":"Library","title":"The Library","background":{"ref":"B1"},"lines":[{"ref":"L1","stage":[{"who":"C1","pos":"left","expr":"calm"}]}]},
                                              {"key":"docks","title":"Docks","background":{"ref":"B9","brief":"foggy pier"},"environment":"fog","lines":[{"ref":"L2","delivery":"hushed","stage":[{"who":"C2","pos":"right","expr":"afraid"},{"who":"C9","pos":"left"}]}]}],
                                    "excluded":[{"ref":"L3","reason":"out-of-character"},{"ref":"L4"}]})");
        auto part2 = json::parse(R"({"scenes":[{"key":"library","lines":[{"ref":"L5","kind":"bogus"},{"ref":"L1"},{"ref":"L77"}]}]})");
        auto script = VnScriptService::normalize(in, {part1, part2}, "llm");
        CHECK(script["scenes"].size() == 2);
        auto& lib = script["scenes"][0]; auto& dock = script["scenes"][1];
        CHECK(lib["key"] == "library"); CHECK(lib["background_asset_id"] == "bg-lib");
        // Library holds L1, the excluded OOC line L3 (hidden) and L5, in canonical order.
        CHECK(lib["lines"].size() == 3); CHECK(lib["lines"][0]["event_id"] == "e1"); CHECK(lib["lines"][1]["event_id"] == "e3"); CHECK(lib["lines"][2]["event_id"] == "e5");
        CHECK(lib["lines"][1]["hidden"].asBool()); CHECK(lib["lines"][1]["exclusion_reason"] == "out-of-character");
        CHECK(!lib["lines"][2]["hidden"].asBool()); CHECK(!lib["lines"][2].isMember("display_kind"));
        CHECK(lib["lines"][2]["stage"][0]["character_id"] == "c1");           // stage carries forward
        CHECK(lib["lines"][0]["stage"][0]["asset_id"] == "std-ada");           // default standee
        // L4 was excluded without a reason, so it stays visible next to its neighbour.
        CHECK(dock["lines"].size() == 2); CHECK(dock["lines"][1]["event_id"] == "e4"); CHECK(!dock["lines"][1]["hidden"].asBool());
        CHECK(dock["background_asset_id"].isNull()); CHECK(dock["background_brief"] == "foggy pier"); CHECK(dock["environment"] == "fog");
        CHECK(dock["lines"][0]["stage"].size() == 1); CHECK(dock["lines"][0]["stage"][0]["asset_id"] == "std-mo-fear"); CHECK(dock["lines"][0]["delivery"] == "hushed");
        CHECK(script["stats"]["hidden"] == 1); CHECK(script["stats"]["shown"] == 4);
        // Mock: parallel windows become separate scenes; OOC is excluded with a reason.
        auto mock = VnScriptService::normalize(in, {VnScriptService::mockPlan(in)}, "mock");
        CHECK(mock["scenes"].size() == 2); CHECK(mock["scenes"][0]["title"] == "Library · Library window");
        CHECK(mock["scenes"][0]["lines"].size() == 3); CHECK(mock["scenes"][0]["lines"][1]["hidden"].asBool());
        CHECK(mock["scenes"][0]["background_asset_id"] == "bg-lib"); CHECK(mock["notes"].size() == 1);
        auto chunks = VnScriptService::chunk(in.events, 2, 100000); CHECK(chunks.size() == 3); CHECK(chunks[2].first == 4 && chunks[2].second == 5);
        // A scene marker has no chat window: it opens the scene that follows it rather than closing the previous one.
        auto marker = ev("m2","","s2","scene_change","","Docks"); in.events.insert(in.events.begin() + 1, marker);
        auto withMarker = VnScriptService::normalize(in, {VnScriptService::mockPlan(in)}, "mock");
        CHECK(withMarker["scenes"].size() == 2); CHECK(withMarker["scenes"][1]["lines"][0]["event_id"] == "m2");
        // Non-ASCII keys continue across parts instead of collapsing to numbered fallbacks.
        auto zh1 = json::parse(R"({"scenes":[{"key":"码头","title":"码头","lines":[{"ref":"L3"}]},{"key":"图书馆","lines":[{"ref":"L1"}]}]})");
        auto zh2 = json::parse(R"({"scenes":[{"key":"码头","lines":[{"ref":"L5"}]}]})");
        auto zh = VnScriptService::normalize(in, {zh1, zh2}, "llm");
        bool merged = false; for (auto& sc : zh["scenes"]) if (sc["key"] == "码头") merged = sc["lines"].size() >= 2;
        CHECK(merged);
    });
    test("visual-novel transcript: time blocks, speaker labels, flat answers become scenes and art requests", [] {
        using logstudio::VnScriptService; using logstudio::LogEvent;
        logstudio::ScriptInputs in; in.era = "1920s Arkham";
        auto ev = [&](std::string id, std::string win, std::string type, std::string who, std::string name, std::string role, std::string text, long long t) {
            LogEvent e; e.eventId = id; e.chatWindowId = win; e.sceneKey = "s1"; e.sceneTitle = "Harbour"; e.eventType = type; e.speakerCharacterId = who; e.speakerDisplayName = name; e.speakerRole = role; e.content = text; e.occurredAtUnix = t; return e; };
        const long long T = 1700000000;   // 2023-11-14 22:13 UTC
        in.events = {ev("e1","wA","narration","","Keeper","gm","Fog rolls over the harbour.",T), ev("e2","wA","dialogue","c2","Mo","pc","I keep watch.",T+60),
                     ev("e3","wA","ooc","c2","Mo","pc","brb",T+90), ev("e4","wA","dialogue","npc1","Old Tom","npc","Storm's coming.",T+120),
                     ev("e5","wA","action","c1","Ada","pc","She lights the lamp.",T+4000), ev("e6","wA","dialogue","c1","Ada","pc","Who's there?",T+4100)};
        in.windowNames = {{"wA","Main table"}};
        in.cast = json::parse(R"([{"ref":"C1","character_id":"c1","name":"Ada","kind":"pc","default_asset_id":null,"asset_mode":"generated","subtitles":["IDLE"],"appearance_prompt":"red-haired librarian in a grey coat"},
                                  {"ref":"C2","character_id":"c2","name":"Mo","kind":"pc","default_asset_id":"std-mo","asset_mode":"uploaded","subtitles":["IDLE"],"appearance_prompt":""},
                                  {"ref":"C3","character_id":"npc1","name":"Old Tom","kind":"npc","default_asset_id":null,"asset_mode":"uploaded","subtitles":[],"appearance_prompt":""}])");
        in.assets = json::parse(R"([{"ref":"S1","id":"std-ada-idle","type":"standee","name":"Ada · IDLE","tags":[],"character_id":"c1","expression":"IDLE"}])");
        // A gap longer than an hour between e4 and e5 opens the second block.
        auto blocks = VnScriptService::blocks(in.events); CHECK(blocks.size() == 2); CHECK(blocks[1].first == 4);
        CHECK(VnScriptService::blocks(in.events, 10000).size() == 1);
        CHECK(VnScriptService::speakerLabel(in.events[0]) == "KP(Narrative)"); CHECK(VnScriptService::speakerLabel(in.events[2]) == "Mo(OOC)");
        CHECK(VnScriptService::speakerLabel(in.events[3]) == "KP(as Old Tom)"); CHECK(VnScriptService::speakerLabel(in.events[1]) == "Mo");
        auto t = VnScriptService::transcript(in, 0, 4, Json::Value(Json::arrayValue));
        CHECK(t.find("Era: 1920s Arkham") != std::string::npos); CHECK(t.find("C1 \"Ada\" mode=generated subtitles=[IDLE] prompt=\"red-haired") != std::string::npos);
        CHECK(t.find("## Window: Main table") != std::string::npos); CHECK(t.find("[L1] KP(Narrative)(22:13): Fog rolls over the harbour.") != std::string::npos);
        CHECK(t.find("[L3] Mo(OOC)(22:14): brb") != std::string::npos); CHECK(t.find("[L5]") == std::string::npos);
        // Mock answer: SAY/IDLE portraits, a background to generate, OOC left out.
        auto flat = VnScriptService::mockFlat(in, 0, in.events.size());
        CHECK(flat["script"].size() == 5); CHECK(flat["generate_backgrounds"].size() == 1); CHECK(flat["generate_backgrounds"][0]["name"] == "Harbour");
        CHECK(flat["generate_portraits"].size() == 1); CHECK(flat["generate_portraits"][0]["char"] == "C1"); CHECK(flat["generate_portraits"][0]["subtitle"] == "SAY");
        CHECK(flat["generate_portraits"][0]["prompt"].asString().find("1920s Arkham") == 0);
        CHECK(flat["script"][1]["portrait"] == "IDLE");   // Mo is uploaded-mode: SAY is not in the list, so the first listed subtitle is used
        auto script = VnScriptService::normalize(in, {VnScriptService::fromFlat(in, {flat})}, "mock");
        CHECK(script["scenes"].size() == 1); CHECK(script["scenes"][0]["title"] == "Harbour"); CHECK(script["scenes"][0]["background_asset_id"].isNull());
        CHECK(script["scenes"][0]["lines"].size() == 6); CHECK(script["scenes"][0]["lines"][2]["hidden"].asBool());
        CHECK(script["scenes"][0]["lines"][4]["stage"].size() == 2);   // Mo stays beside Ada
        CHECK(script["scenes"][0]["lines"][4]["stage"][1]["asset_id"] == "std-ada-idle");   // Ada's IDLE art is already there
        CHECK(script["scenes"][0]["lines"][5]["stage"][1]["expression"] == "SAY"); CHECK(script["scenes"][0]["lines"][5]["stage"][1]["asset_id"] == "std-ada-idle");   // stand-in until SAY art lands
        CHECK(script["asset_needs"].size() == 2); CHECK(script["asset_needs"][0]["kind"] == "standee"); CHECK(script["asset_needs"][0]["subtitle"] == "SAY");
        CHECK(script["asset_needs"][1]["kind"] == "background"); CHECK(script["asset_needs"][1]["name"] == "Harbour"); CHECK(script["asset_needs"][1]["scene_key"] == "harbour");
        // A model answer: a background change opens a new scene; an uploaded-mode portrait request is refused; copied text resolves to its line.
        auto llm = json::parse(R"({"generate_backgrounds":[{"name":"Lighthouse","prompt":"1920s lighthouse at night"}],
                                   "generate_portraits":[{"char":"C2","subtitle":"FIGHT","prompt":"x"},{"char":"C1","subtitle":"FIGHT","prompt":"Ada ready to fight"}],
                                   "script":[{"ref":"L1","background":"Harbour"},{"ref":"L2","speaker":"C2","background":"Harbour","portrait":"FIGHT"},
                                             {"text":"She lights the lamp.","speaker":"C1","background":"Lighthouse","portrait":"FIGHT"},{"ref":"L6","speaker":"C1","portrait":"SAY"}]})");
        auto plan = VnScriptService::fromFlat(in, {llm});
        CHECK(plan["scenes"].size() == 2); CHECK(plan["scenes"][1]["title"] == "Lighthouse"); CHECK(plan["scenes"][1]["background"]["brief"] == "1920s lighthouse at night");
        CHECK(plan["scenes"][1]["lines"].size() == 2); CHECK(plan["scenes"][1]["lines"][0]["ref"] == "L5");
        CHECK(plan["scenes"][0]["lines"][1]["stage"][0]["expr"] == "default");   // FIGHT is not in Mo's uploaded list
        CHECK(plan["asset_needs"].size() == 3);   // Ada's FIGHT portrait, the harbour and the lighthouse, not Mo's
        CHECK(plan["excluded"].size() == 1); CHECK(plan["excluded"][0]["ref"] == "L3");
        CHECK(!plan["scenes"][1]["lines"][0].isMember("text"));   // a line matched by its copied text keeps its words
    });
    test("visual-novel wording: narration is reworded, short questions and answers fold into narration, the log stays", [] {
        using logstudio::VnScriptService; using logstudio::LogEvent;
        logstudio::ScriptInputs in;
        auto ev = [&](std::string id, std::string win, std::string type, std::string who, std::string role, std::string text, std::string scope = "public") {
            LogEvent e; e.eventId = id; e.chatWindowId = win; e.sceneKey = "s1"; e.sceneTitle = "Cellar"; e.eventType = type; e.speakerCharacterId = who; e.speakerDisplayName = who.empty() ? "Keeper" : who; e.speakerRole = role; e.content = text; e.visibilityScope = scope; e.occurredAtUnix = 1700000000; return e; };
        in.events = {ev("e1","wA","narration","","gm","the cellar is dark. smells of damp. a door at the end"), ev("e2","wA","dialogue","c1","pc","is door locked?"),
                     ev("e3","wA","narration","","gm","yes"), ev("e4","wA","dice_roll","c1","pc","Ada's Spot Hidden check: D100=12/60 — Hard Success"),
                     ev("e5","wB","narration","","gm","no"), ev("e6","wA","narration","","gm","only you notice the key","character"), ev("e7","wA","dialogue","c1","pc","Who's there?")};
        in.windowNames = {{"wA","Main"},{"wB","Side"}};
        in.cast = json::parse(R"([{"ref":"C1","character_id":"c1","name":"Ada","kind":"pc","default_asset_id":null,"asset_mode":"uploaded","subtitles":["IDLE"],"appearance_prompt":""}])");
        in.assets = Json::Value(Json::arrayValue);
        auto llm = json::parse(R"({"script":[
            {"ref":"L1","background":"Cellar","text":"The cellar is dark and smells of damp; a door waits at the far end."},
            {"ref":"L2","background":"Cellar","kind":"narration","fold":["L3","L5","L6"],"text":"The door is locked."},
            {"ref":"L4","speaker":"C1","background":"Cellar","text":"Ada finds nothing."},
            {"ref":"L7","speaker":"C1","background":"Cellar","portrait":"IDLE"}]})");
        auto plan = VnScriptService::fromFlat(in, {llm});
        const auto& lines = plan["scenes"][0]["lines"];
        CHECK(lines.size() == 4);
        CHECK(lines[0]["text"] == "The cellar is dark and smells of damp; a door waits at the far end.");
        CHECK(lines[1]["ref"] == "L2"); CHECK(lines[1]["text"] == "The door is locked."); CHECK(lines[1]["kind"] == "narration"); CHECK(!lines[1].isMember("speaker"));
        CHECK(!lines[2].isMember("text"));   // dice lines are never reworded
        CHECK(!lines[3].isMember("text"));
        // L3 folds in; L5 (another window) and L6 (other readers) do not, and stay in the script.
        CHECK(plan["excluded"].size() == 1); CHECK(plan["excluded"][0]["ref"] == "L3"); CHECK(plan["excluded"][0]["reason"] == "folded into narration (L2)");
        auto script = VnScriptService::normalize(in, {plan}, "llm");
        int hidden = 0; std::string l2Text, l2Kind; std::set<std::string> ids;
        for (const auto& s : script["scenes"]) for (const auto& l : s["lines"]) {
            ids.insert(l["event_id"].asString()); if (l["hidden"].asBool()) ++hidden;
            if (l["event_id"] == "e2") { l2Text = l["text"].asString(); l2Kind = l["display_kind"].asString(); }
        }
        CHECK(ids.size() == 7);   // every log line is still in the script
        CHECK(hidden == 1); CHECK(l2Text == "The door is locked."); CHECK(l2Kind == "narration");
    });
    test("scenario detection fires only on Keeper time or place shifts with enough history; summaries use only the log", [] {
        Json::Value ctx; ctx["current"]["event_count"] = 10; ctx["current"]["manual_move"] = false;
        auto ev = [](const char* id, const char* role, const char* content) { Json::Value e; e["event_id"] = id; e["kind"] = "message.posted"; e["actor_role"] = role; e["content"] = content; return e; };
        ctx["new_events"].append(ev("e1", "player", "Later we should check the docks.")); ctx["new_events"].append(ev("e2", "gm", "Dunmore keeps talking about the ledger."));
        CHECK(!ScenarioService::mockDetect(ctx)["advanced"].asBool());
        ctx["new_events"].append(ev("e3", "gm", "The next morning, you arrive at the Hale boarding house. Mrs. Hale opens the door."));
        auto d = ScenarioService::mockDetect(ctx); CHECK(d["advanced"].asBool()); CHECK(d["boundary_event_id"] == "e3"); CHECK(d["location"] == "Hale boarding house"); CHECK(d["narrative_time"] == "The next morning");
        ctx["current"]["event_count"] = 3; CHECK(!ScenarioService::mockDetect(ctx)["advanced"].asBool());
        ctx["current"]["event_count"] = 9; ctx["current"]["manual_move"] = true; CHECK(!ScenarioService::mockDetect(ctx)["advanced"].asBool());
        Json::Value zh; zh["current"]["event_count"] = 8; zh["new_events"].append(ev("z1", "gm", "【场景 灯塔】你们在雨中抵达灯塔。"));
        auto dz = ScenarioService::mockDetect(zh); CHECK(dz["advanced"].asBool()); CHECK(dz["title"] == "灯塔"); CHECK(dz["confidence"].asDouble() > 0.9);
        Json::Value sctx; sctx["scene"]["title"] = "Scenario 2"; sctx["scene"]["location"] = "Boarding house";
        auto line = [](int seq, const char* role, const char* who, const char* content, const char* kind = "ic") { Json::Value e; e["seq"] = seq; e["actor_role"] = role; e["character_name"] = who; e["content"] = content; e["kind"] = kind; return e; };
        sctx["log"].append(line(1, "gm", "", "Hale opens the door and you notice a letter on the hall table.", "narration")); sctx["log"].append(line(2, "player", "Harvey Walters", "I pick up the letter.")); sctx["log"].append(line(3, "player", "Nora Blake", ".ra spot hidden", "roll")); sctx["log"].append(line(4, "gm", "", "The letter is from Elias.", "narration"));
        auto s = ScenarioService::mockSummary(sctx);
        CHECK(s["summary"].asString().find("Boarding house") != std::string::npos); CHECK(s["summary"].asString().find("Harvey Walters") != std::string::npos); CHECK(s["summary"].asString().find("Dice rolled: 1") != std::string::npos);
        CHECK(s["key_points"].size() >= 1); CHECK(s["title"] == "Hale opens the door and you");
    });
    test("narrative memory skips mechanical noise and reuses existing entries", [] {
        auto e = json::parse(R"({"kind":"message.posted","event_id":"e1","actor_role":"gm","content":"Narration","payload":{"message_kind":"narration"}})");
        CHECK(narrative_memory::obviousNonNarrative(e));
        Json::Value ctx; ctx["new_events"].append(e); CHECK(MockLlmClient::observerExtract(ctx)["proposals"].empty());
        e["content"] = "Anastasia rolled 1d100 = 75"; e["payload"]["dice"]["type"] = "roll";
        CHECK(narrative_memory::obviousNonNarrative(e));
        e["payload"]["dice"]["reason"] = "damage to the locked door"; CHECK(!narrative_memory::obviousNonNarrative(e));
        e["payload"]["dice"]["type"] = "check"; e["payload"]["dice"]["reason"] = ""; CHECK(!narrative_memory::obviousNonNarrative(e));
        e.removeMember("payload"); e["content"] = "You find a brass key under the mat.";
        ctx["new_events"][0] = e;
        auto first = MockLlmClient::observerExtract(ctx); CHECK(!first["proposals"].empty());
        for (const auto& p : first["proposals"]) for (const auto& op : p["ops"]) { auto f = op["fact"]; f["fact_id"] = "existing-id"; ctx["documents"][p["document_type"].asString()]["entries"].append(f); }
        CHECK(MockLlmClient::observerExtract(ctx)["proposals"].empty());
        ctx["documents"]["clue_journal"]["entries"][0]["status"] = "attempted";
        auto next = MockLlmClient::observerExtract(ctx); CHECK(next["proposals"].size() == 1);
        CHECK(next["proposals"][0]["ops"][0]["op"] == "update_entry"); CHECK(next["proposals"][0]["ops"][0]["fact_id"] == "existing-id");
        // A fictional scientific test is not excluded by a broad word blacklist.
        e["content"] = "The laboratory test reveals poison in the well."; CHECK(!narrative_memory::obviousNonNarrative(e));
    });
    test("reminders keep only verbatim quotes from readable lines and the mock planner links new lines to earlier ones", [] {
        std::map<std::string, Json::Value> readable;
        Json::Value e1; e1["event_id"] = "e1"; e1["message_id"] = "m1"; e1["chat_window_id"] = "w"; e1["scene_id"] = "s1"; e1["seq"] = 5; e1["content"] = "You find a tarnished badge. It bears a Lantern sigil."; readable["e1"] = e1;
        auto quotes = json::parse(R"([{"event_id":"e1","text":"It bears a lantern sigil."},{"event_id":"e1","text":"bears a Lantern sigil"},{"event_id":"e1","text":"a golden badge"},{"event_id":"e9","text":"You find"},{"event_id":"e1","text":""}])");
        auto c = ReminderService::resolveCitations(quotes, readable);
        CHECK(c.size() == 1); CHECK(c[0]["quotes"].size() == 2); CHECK(c[0]["quotes"][0] == "It bears a Lantern sigil."); CHECK(c[0]["message_id"] == "m1");
        CHECK(ReminderService::dedupeKey("Said earlier: badge", c) == ReminderService::dedupeKey("said earlier badge!", c));
        Json::Value ctx;
        auto line = [](const char* id, int seq, const char* role, const char* who, const char* content) { Json::Value e; e["event_id"] = id; e["seq"] = seq; e["actor_role"] = role; e["character_name"] = who; e["content"] = content; return e; };
        ctx["previous_tail"].append(line("p1", 1, "gm", "", "Dunmore says: I promise I will bring the lighthouse key tomorrow."));
        for (int i = 0; i < 10; ++i) ctx["current_log"].append(line(("c" + std::to_string(i)).c_str(), 10 + i, "gm", "", i == 0 ? "On the mantel you notice a tarnished badge; it bears a lantern sigil." : "The rain keeps falling on the roof."));
        ctx["new_events"].append(line("n1", 30, "player", "Harvey", "That lantern sigil again. And did Dunmore ever bring the lighthouse key?"));
        ctx["current_log"].append(ctx["new_events"][0]);
        auto plan = ReminderService::mockPlan(ctx);
        CHECK(plan["reminders"].size() == 2);
        bool needed = false, forgotten = false;
        for (auto& r : plan["reminders"]) { if (r["kind"] == "needed") { needed = true; CHECK(r["quotes"][0]["event_id"] == "p1"); } if (r["kind"] == "forgotten") { forgotten = true; CHECK(r["quotes"][0]["event_id"] == "c0"); } CHECK(r["title"].asString().size() <= 100); }
        CHECK(needed && forgotten);
        ctx["existing_titles"].append(plan["reminders"][0]["title"]);
        CHECK(ReminderService::mockPlan(ctx)["reminders"].size() == 1);
    });
    test("mock reminder maintenance is explicit, preserves IDs and never treats silence as resolution", [] {
        auto ctx = json::parse(R"({"managed_reminders":[{"id":"r1","title":"Return compass","status":"active","version":2}],"new_events":[{"event_id":"e1","content":"Maybe the compass has already been returned?"}]})");
        CHECK(ReminderService::mockPlan(ctx)["changes"].empty());
        ctx["new_events"][0]["content"] = "Set aside: Return compass";
        auto c = ReminderService::mockPlan(ctx)["changes"]; CHECK(c.size() == 1); CHECK(c[0]["action"] == "defer"); CHECK(c[0]["expected_version"] == 2); CHECK(c[0]["quotes"][0]["event_id"] == "e1");
        ctx["managed_reminders"][0]["status"] = "deferred"; ctx["new_events"][0]["content"] = "Return to: Return compass";
        CHECK(ReminderService::mockPlanKp(ctx)["changes"][0]["action"] == "reactivate");
        ctx["new_events"][0]["content"] = "已解决：Return compass";
        CHECK(ReminderService::mockChanges(ctx)[0]["action"] == "resolve");
        ctx["managed_reminders"][0]["status"] = "resolved";
        CHECK(ReminderService::mockChanges(ctx).empty());
    });
    test("script knowledge: the mock builds flow, relationships, clues, foreshadowing and background from the module graph; proposals are reviewed", [] {
        Json::Value ctx; Json::Value pg1, pg2, pg3;
        pg1["page"] = 1; pg1["text"] = "THE LANTERN SOCIETY\nA scenario for Call of Cthulhu set in Arkham, 1925.\n\nChapter 1: The Sheriff's Office\nThe investigators meet Sheriff Dunmore, who holds the only key to the lighthouse. He stalls them politely.\nNPC: Sheriff Dunmore\nA tired lawman who secretly belongs to the Lantern Society.\nItem: The Lighthouse Key\nAn iron key stamped with a lantern sigil.\nIf the investigators obtain the key they may enter the lighthouse at night.";
        pg2["page"] = 2; pg2["text"] = "Chapter 2: The Lighthouse\nLocation: The Lighthouse\nA ruined tower on the cliffs north of town.\nHandout 1: The Keeper's Diary\nThe diary names the Society's members.\nTwist: The Sheriff's Betrayal\nSheriff Dunmore locks the investigators inside once they find the diary.\nSecret: What Really Happened\nThe Society drowned the lighthouse keeper in 1919.";
        pg3["page"] = 3; pg3["text"] = "Ending: Dawn\nIf the investigators escape, the Society scatters.";
        ctx["pages"].append(pg1); ctx["pages"].append(pg2); ctx["pages"].append(pg3);
        auto graph = MockLlmClient::moduleStructure(ctx);
        // Give nodes ids as the database would, and resolve edges to them.
        std::map<std::string, std::string> keyToId; int i = 0;
        for (auto& n : graph["nodes"]) { n["id"] = "n" + std::to_string(i++); keyToId[n["key"].asString()] = n["id"].asString(); }
        Json::Value edges(Json::arrayValue); for (auto& e : graph["edges"]) { Json::Value x; x["from_node_id"] = keyToId[e["from_key"].asString()]; x["to_node_id"] = keyToId[e["to_key"].asString()]; x["relation"] = e["relation"]; edges.append(x); }
        graph["edges"] = edges;
        auto built = ScriptKnowledgeService::mockBuild(graph);
        std::map<std::string, int> byKind; std::vector<std::string> flow;
        for (auto& e : built["entries"]) { byKind[e["kind"].asString()]++; if (e["kind"] == "flow") flow.push_back(e["title"].asString()); CHECK(!e["citations"].empty() || !e["node_keys"].empty()); }
        CHECK(byKind["flow"] >= 3); CHECK(byKind["clue"] >= 2); CHECK(byKind["foreshadowing"] >= 2); CHECK(byKind["background"] >= 2); CHECK(byKind["relationship"] >= 1);
        CHECK(flow.size() >= 3 && flow.back() == "Dawn");                                   // endings close the flow
        int sheriff = -1, lighthouse = -1; for (int k = 0; k < (int)flow.size(); ++k) { if (flow[k].find("Sheriff") != std::string::npos) sheriff = k; if (flow[k] == "The Lighthouse") lighthouse = k; }
        CHECK(sheriff >= 0 && lighthouse > sheriff);                                        // script order is kept
        auto terms = ScriptKnowledgeService::titleTerms("Chapter 2: The Lighthouse"); CHECK(terms.size() == 1 && terms[0] == "lighthouse");
        // Play: the Keeper's narration reaches the lighthouse; a player's guess moves nothing.
        Json::Value k(Json::arrayValue); int id = 0;
        for (auto& e : built["entries"]) { Json::Value x; x["id"] = "k" + std::to_string(id++); x["kind"] = e["kind"]; x["title"] = e["title"]; x["status"] = "pending"; x["position"] = e.isMember("position") ? e["position"] : Json::Value(0); k.append(x); }
        Json::Value pctx; pctx["knowledge"] = k;
        Json::Value guess; guess["event_id"] = "e1"; guess["actor_role"] = "player"; guess["content"] = "I bet the Lighthouse is where the Society meets."; pctx["new_events"].append(guess);
        CHECK(ScriptKnowledgeService::mockPropose(pctx)["changes"].empty());
        Json::Value narr; narr["event_id"] = "e2"; narr["actor_role"] = "gm"; narr["content"] = "You climb the cliff path. The Lighthouse rises ahead, a ruined tower groaning in the wind."; pctx["new_events"].append(narr);
        auto changes = ScriptKnowledgeService::mockPropose(pctx)["changes"];
        CHECK(!changes.empty());
        Json::Value flowChange; for (auto& c : changes) { CHECK(c["op"] == "status"); CHECK(c["evidence"][0]["event_id"] == "e2"); for (auto& e : k) if (e["id"] == c["knowledge_id"] && e["kind"] == "flow") flowChange = c; }
        CHECK(!flowChange.isNull() && flowChange["status"] == "active");
        CHECK(narr["content"].asString().find(flowChange["evidence"][0]["text"].asString()) != std::string::npos);   // evidence is verbatim
        // The reviewer: approves the verified change, rejects a misquote, an illegal transition and a Keeper-edited update.
        Json::Value entry; for (auto& e : k) if (e["id"] == flowChange["knowledge_id"]) entry = e;
        Json::Value rctx; rctx["change"] = flowChange; rctx["entry"] = entry; Json::Value line; line["event_id"] = "e2"; line["content"] = narr["content"]; rctx["evidence_lines"].append(line);
        CHECK(ScriptKnowledgeService::mockReview(rctx)["verdict"] == "approved");
        Json::Value bad = rctx; bad["change"]["evidence"][0]["text"] = "The Lighthouse rises ahead, a GOLDEN tower"; CHECK(ScriptKnowledgeService::mockReview(bad)["verdict"] == "rejected");
        Json::Value done = rctx; done["entry"]["status"] = "done"; CHECK(ScriptKnowledgeService::mockReview(done)["verdict"] == "rejected");
        Json::Value upd = rctx; upd["change"]["op"] = "update"; upd["change"]["body"] = "x"; upd["entry"]["gm_edited"] = true; CHECK(ScriptKnowledgeService::mockReview(upd)["reason"].asString().find("Keeper-edited") != std::string::npos);
        Json::Value unrelated = rctx; unrelated["entry"]["title"] = "The Quarry"; CHECK(ScriptKnowledgeService::mockReview(unrelated)["verdict"] == "rejected");
        // Keeper reminders: a pending clue the newest narration touches is "needed", with a script reference.
        Json::Value rem; rem["knowledge"] = k; rem["existing_titles"] = Json::Value(Json::arrayValue); rem["current_log"] = Json::Value(Json::arrayValue); rem["previous_tail"] = Json::Value(Json::arrayValue);
        Json::Value n2; n2["event_id"] = "e3"; n2["actor_role"] = "gm"; n2["character_name"] = ""; n2["content"] = "Dust covers a desk. Something like a diary lies under a loose board."; rem["new_events"].append(n2);
        auto plan = ReminderService::mockPlanKp(rem);
        CHECK(!plan["reminders"].empty()); CHECK(plan["reminders"][0]["kind"] == "needed"); CHECK(plan["reminders"][0]["title"].asString().find("Diary") != std::string::npos); CHECK(plan["reminders"][0]["script_refs"].size() == 1); CHECK(plan["reminders"][0]["quotes"][0]["event_id"] == "e3");
    });
    test("AI endpoint guard: public https only, private and special-purpose addresses refused", [] {
        using namespace net;
        for (auto ip : {"127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "not-an-ip"})
            CHECK(isRestrictedAddress(ip));
        for (auto ip : {"8.8.8.8", "1.1.1.1", "104.18.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"}) CHECK(!isRestrictedAddress(ip));
        setAllowPrivate(false);
        auto refused = [](const char* u) { try { checkEndpointSyntax(u); return false; } catch (const std::invalid_argument&) { return true; } };
        CHECK(!refused("https://api.openai.com/v1")); CHECK(!refused("")); CHECK(!refused("https://8.8.8.8/v1"));
        CHECK(refused("http://api.openai.com/v1")); CHECK(refused("https://127.0.0.1/v1")); CHECK(refused("https://[::1]:8443/v1")); CHECK(refused("https://localhost/v1"));
        CHECK(refused("https://user:pw@api.example.com/v1")); CHECK(refused("https://api.example.com/v1?x=1")); CHECK(refused("ftp://api.example.com")); CHECK(refused("https://a.example.com/v1 x"));
        bool pinnedRefused = false; try { PinnedRequest r("https://127.0.0.1:9/v1"); } catch (const std::runtime_error&) { pinnedRefused = true; } CHECK(pinnedRefused);
        bool localhostRefused = false; try { PinnedRequest r("https://localhost:9/v1"); } catch (const std::runtime_error&) { localhostRefused = true; } CHECK(localhostRefused);
        setAllowPrivate(true);
        CHECK(!refused("http://127.0.0.1:11434/v1")); CHECK(!refused("http://localhost:8000/v1"));
        bool allowed = true; try { PinnedRequest r("http://127.0.0.1:9/v1"); } catch (...) { allowed = false; } CHECK(allowed);
        setAllowPrivate(false);
    });
    test("coc7 point-buy: budgets, allowed skills and limits follow the career list", [] {
        using namespace coc7;
        CHECK(careers().size() == 230);
        auto* acc = findCareer("会计师"); CHECK(acc && acc->creditMin == 30 && acc->creditMax == 70 && acc->free == 2 && acc->fixed.size() == 6);
        CHECK(findCareer("自定义职业")->free == 8); CHECK(findCareer("nobody") == nullptr);
        Json::Value chars; chars["STR"] = 50; chars["CON"] = 60; chars["SIZ"] = 50; chars["DEX"] = 70; chars["APP"] = 60; chars["INT"] = 80; chars["POW"] = 60; chars["EDU"] = 75; chars["LUK"] = 45;
        CHECK(careerBudget(*acc, chars) == 300); CHECK(hobbyBudget(chars) == 160);
        auto* hunter = findCareer("猎人"); CHECK(hunter); CHECK(careerBudget(*hunter, chars) == 75 * 2 + 70 * 2);   // 教育×2＋力量或敏捷×2: the better of the two
        CHECK(skillBase("Dodge", chars) == 35); CHECK(skillBase("Language (Own)", chars) == 75); CHECK(skillBase("侦查", chars) == 25);
        CHECK(skillBase("Science (Biology)", chars) == 1); CHECK(skillBase("Fighting (Sword)", chars) == 20); CHECK(skillBase("Fighting (Brawl)", chars) == 25);
        CHECK(skillBase("Art/Craft (Photography)", chars) == 5); CHECK(skillBase("Survival (Sea)", chars) == 10); CHECK(skillBase("Basket weaving", chars, 7) == 7);
        CHECK(family("Science (Biology)") == "Science"); CHECK(family("格斗") == "Fighting"); CHECK(family("Firearms (Rifle/Shotgun)") == "Firearms"); CHECK(family("Listen") == "Listen");
        CHECK(family("科学（生物学）") == "Science"); CHECK(family("格斗（鞭）") == "Fighting");
        CHECK(skillBase("格斗（鞭）", chars) == 5); CHECK(skillBase("射击（弓）", chars) == 15);
        CHECK(family("科学（生物）") == "Science"); CHECK(skillBase("科学（生物）", chars) == 1); CHECK(skillBase("格斗（剑）", chars) == 20); CHECK(skillBase("射击（弓术）", chars) == 15);
        CHECK(rules()["careers"].size() == 230); CHECK(rules()["skills"].size() > 50);
        // An accountant spends career points on career skills and one free specialty; hobby points go anywhere.
        Json::Value card; card["characteristics"] = chars; card["career"]["name"] = "会计师"; card["career"]["specialties"].append("Fighting (Brawl)");
        card["skill_points"]["Spot Hidden"]["career"] = 40; card["skill_points"]["Fighting (Brawl)"]["career"] = 20; card["skill_points"]["Dodge"]["hobby"] = 30; card["skill_points"]["Credit Rating"]["career"] = 40;
        auto rep = apply(card);
        CHECK(rep["violations"].empty()); CHECK(rep["warnings"].empty());
        CHECK(card["skills"]["Spot Hidden"] == 65); CHECK(card["skills"]["Fighting (Brawl)"] == 45); CHECK(card["skills"]["Dodge"] == 65); CHECK(card["skills"]["Credit Rating"] == 40);
        CHECK(rep["career_spent"] == 100); CHECK(rep["hobby_spent"] == 30); CHECK(rep["career_budget"] == 300); CHECK(rep["characteristics_total"] == 505); CHECK(rep["luck"] == 45);
        auto codes = [](const Json::Value& r) { std::vector<std::string> c; for (auto& v : r["violations"]) c.push_back(v["code"].asString()); return c; };
        card["skill_points"]["Stealth"]["career"] = 10; CHECK((codes(apply(card)) == std::vector<std::string>{"career_points_not_allowed"}));
        card["skill_points"]["Stealth"]["career"] = 0; card["skill_points"]["Stealth"]["hobby"] = 10; CHECK(apply(card)["violations"].empty());
        card["skill_points"]["Spot Hidden"]["career"] = 300; { auto c = codes(apply(card)); CHECK(std::count(c.begin(), c.end(), "over_99") == 1 && std::count(c.begin(), c.end(), "career_over") == 1); }
        card["skill_points"]["Spot Hidden"]["career"] = 40; card["career"]["specialties"].append("Swim"); card["career"]["specialties"].append("Climb");
        CHECK((codes(apply(card)) == std::vector<std::string>{"too_many_specialties"}));
        card["career"]["specialties"].resize(1); card["skill_points"]["Cthulhu Mythos"]["hobby"] = 5; CHECK((codes(apply(card)) == std::vector<std::string>{"mythos"}));
        card["skill_points"].removeMember("Cthulhu Mythos"); card["skill_points"]["Credit Rating"]["career"] = 10; { auto r = apply(card); CHECK(r["violations"].empty()); CHECK(r["warnings"].size() == 1 && r["warnings"][0]["code"] == "credit_rating"); }
        card["career"]["name"] = "星际海盗"; CHECK((codes(apply(card)) == std::vector<std::string>{"unknown_career", "career_points_not_allowed", "career_points_not_allowed", "career_points_not_allowed", "career_over"}));   // no career: budget 0
        // A hunter picks from option groups ("外语或生存", "聆听或侦查"); 射击 is fixed for any firearm.
        Json::Value h; h["characteristics"] = chars; h["career"]["name"] = "猎人";
        Json::Value g0(Json::arrayValue); g0.append("Survival (Sea)"); Json::Value g1(Json::arrayValue); g1.append("Listen");
        h["career"]["choices"].append(g0); h["career"]["choices"].append(g1);
        h["skill_points"]["Survival (Sea)"]["career"] = 20; h["skill_points"]["Listen"]["career"] = 10; h["skill_points"]["Firearms (Rifle/Shotgun)"]["career"] = 30;
        auto hr = apply(h); CHECK(hr["violations"].empty()); CHECK(h["skills"]["Survival (Sea)"] == 30); CHECK(h["skills"]["Firearms (Rifle/Shotgun)"] == 55);
        h["career"]["choices"][0].append("Language (Other)"); CHECK((codes(apply(h)) == std::vector<std::string>{"invalid_choice"}));
        h["career"]["choices"][0].resize(1); h["career"]["choices"][1][0] = "Swim"; { auto c = codes(apply(h)); CHECK(c.size() == 2 && c[0] == "invalid_choice" && c[1] == "career_points_not_allowed"); }
    });
    test("character space: the COC7 role card is bounded, mirrored into dice attributes, and image prompts carry era, moment and framing", [] {
        auto card = CharacterSpaceService::normalizeRoleCard(json::parse(R"({"basic":{"occupation":"Journalist","age":"34","junk":1},"characteristics":{"STR":55,"DEX":70,"POW":"x","LUK":1200},"derived":{"hp":11,"san":60,"db":"0"},"skills":{"Spot Hidden":65,"Library Use":70,"":9},"background":{"ideology":"Truth above all","unknown":"dropped"},"items":[{"name":"Notebook","note":"dog-eared","qty":1},"Revolver",{"name":""}],"wealth":{"cash":"$40"}})"));
        CHECK(card["basic"]["occupation"] == "Journalist"); CHECK(!card["basic"].isMember("junk")); CHECK(card["characteristics"]["STR"] == 55); CHECK(card["characteristics"]["LUK"] == 999); CHECK(card["characteristics"]["POW"] == 0);
        CHECK(card["skills"].size() == 2); CHECK(card["items"].size() == 2); CHECK(card["items"][1]["name"] == "Revolver"); CHECK(card["items"][1]["qty"] == 1); CHECK(!card["background"].isMember("unknown")); CHECK(card["wealth"]["cash"] == "$40");
        Json::Value attrs; attrs["luck"] = 30;   // an attribute the dice already stored under their own key
        auto mirrored = CharacterSpaceService::mirrorAttrs(attrs, card);
        CHECK(mirrored["STR"] == 55 || mirrored["str"] == 55); CHECK(mirrored["Spot Hidden"] == 65); CHECK(mirrored.isMember("luck") || mirrored.isMember("LUK") || mirrored.isMember("Luck"));
        bool hp = false; for (auto& k : mirrored.getMemberNames()) if (text::lower(k) == "hp" && mirrored[k] == 11) hp = true; CHECK(hp);
        CHECK(CharacterSpaceService::normalizeSubtitle(" say loud ") == "SAY_LOUD"); CHECK(CharacterSpaceService::normalizeSubtitle("fight!") == "FIGHT");
        auto p = CharacterSpaceService::buildPrompt("A gaunt woman in a grey coat", "1920s", "Thursday night", "subtitle", "FIGHT");
        CHECK(p.find("grey coat") != std::string::npos && p.find("1920s") != std::string::npos && p.find("Thursday night") != std::string::npos && p.find("FIGHT") != std::string::npos && p.find("standee") != std::string::npos);
        CHECK(p.find("transparent background") != std::string::npos && p.find("plain background") == std::string::npos);
        CHECK(CharacterSpaceService::buildPrompt("x", "", "", "avatar", "").find("head-and-shoulders") != std::string::npos);
    });
    test("mock standees have real transparent pixels while backgrounds remain RGB", [] {
        logstudio::ImageConfig config; config.provider = "mock";
        auto provider = logstudio::makeImageProvider(config);
        Json::Value request; request["kind"] = "standee";
        const auto result = provider->generate(request);
        CHECK(result.ok && result.mime == "image/png");
        CHECK(static_cast<unsigned char>(result.bytes.at(25)) == 6); // RGBA
        CHECK(result.bytes.find("MOCK test pattern") != std::string::npos);
        std::string compressed;
        for (size_t offset = 8; offset + 12 <= result.bytes.size();) {
            uint32_t size = 0;
            for (int i = 0; i < 4; ++i) size = (size << 8) | static_cast<unsigned char>(result.bytes[offset+i]);
            if (result.bytes.substr(offset+4, 4) == "IDAT") compressed += result.bytes.substr(offset+8, size);
            offset += size+12;
        }
        std::string pixels(180*(320*4+1), '\0'); uLongf length = pixels.size();
        CHECK(uncompress(reinterpret_cast<Bytef*>(pixels.data()), &length,
            reinterpret_cast<const Bytef*>(compressed.data()), compressed.size()) == Z_OK);
        CHECK(pixels[4] == 0); // First pixel is transparent, not a painted checkerboard backdrop.
        CHECK(static_cast<unsigned char>(pixels[90*(320*4+1)+1+160*4+3]) == 255);
        request["kind"] = "background";
        CHECK(static_cast<unsigned char>(provider->generate(request).bytes.at(25)) == 2);
    });
    test("mock speech produces measurable audio and dictionary never alters its source", [] {
        setenv("TTS_PROVIDER","mock",1);auto provider=logstudio::makeTtsProvider();logstudio::TtsSynthesisRequest req;req.text="调查员打开了门。";req.voiceId="mock-cherry";auto r=provider->synthesize(req);CHECK(r.ok&&r.mime=="audio/wav");CHECK(logstudio::wavDurationMs(r.audioBytes)==r.durationMs);CHECK(logstudio::wavDurationMs("RIFFtruncated")==0);
        auto entries=json::parse(R"([{"term":"拉莱耶","reading":"拉来耶","mode":"replace"}])");std::string source="我们前往拉莱耶。";CHECK(logstudio::TtsService::applyDictionary(source,entries,false)=="我们前往拉来耶。");CHECK(source=="我们前往拉莱耶。");
        Json::Value params;auto k=logstudio::TtsService::cacheKey("mock","model","voice",1,source,"",1,params);CHECK(k!=logstudio::TtsService::cacheKey("mock","model","voice",2,source,"",1,params));CHECK(k!=logstudio::TtsService::cacheKey("mock","model","voice",1,source,"whisper",1,params));
    });
    test("dice rules: fumbles against the needed number, spaced .sc, hyphenated .st names, .en limits and the 90% SAN bonus", [] {
        dice::TextSet en;
        dice::Context ctx; ctx.name = "Alice"; ctx.hasCharacter = true; ctx.attrs["Spot Hidden"] = 80; ctx.attrs["SAN"] = 60; ctx.attrs["Library Use"] = 85; ctx.attrs["Cthulhu Mythos"] = 5;
        // Skill 80 at Hard needs 40 or less: 97 is a fumble, not a plain failure; at Regular it stays a failure.
        dice::SeqRng hard({97}); auto h = dice::execute(*dice::parseCommand(".ra hard spot hidden"), ctx, en, hard);
        CHECK(h.detail["rolls"][0]["level"].asString() == "fumble");
        dice::SeqRng reg({97}); auto r = dice::execute(*dice::parseCommand(".ra spot hidden"), ctx, en, reg);
        CHECK(r.detail["rolls"][0]["level"].asString() == "failure");
        dice::SeqRng sc({50, 4}); auto spaced = dice::execute(*dice::parseCommand(".sc 1 / 1d6"), ctx, en, sc);
        CHECK(spaced.attrsChanged && spaced.attrs["SAN"].asInt() == 59);
        dice::SeqRng st({}); auto set = dice::execute(*dice::parseCommand(".st fast-talk 50"), ctx, en, st);
        CHECK(set.attrsChanged); CHECK(dice::lookup(set.attrs, "fast talk").value == 50);
        dice::SeqRng st2({2}); auto minus = dice::execute(*dice::parseCommand(".st san-2"), ctx, en, st2);
        CHECK(minus.attrs["SAN"].asInt() == 58);
        dice::SeqRng m({99}); bool refused = false; try { dice::execute(*dice::parseCommand(".en cthulhu mythos"), ctx, en, m); } catch (const dice::DiceError&) { refused = true; } CHECK(refused);
        // 85 + 6 crosses 90: 2D6 (3+4) SAN.
        dice::SeqRng g({97, 6, 3, 4}); auto grow = dice::execute(*dice::parseCommand(".en library use"), ctx, en, g);
        CHECK(grow.attrs["Library Use"].asInt() == 91); CHECK(grow.attrs["SAN"].asInt() == 67); CHECK(grow.detail["san_bonus"].asInt() == 7);
    });
    test("COC7 point-buy: specialisation keys, named specialties, Credit Rating and specialised bases", [] {
        CHECK(coc7::family("Language (Other) (拉丁)") == "Language (Other)");
        CHECK(coc7::family("外语（拉丁）") == "Language (Other)");
        CHECK(coc7::family("Science (生物)") == "Science");
        Json::Value chars; chars["DEX"] = 60; chars["EDU"] = 70;
        CHECK(coc7::skillBase("射击（来复）", chars) == 25); CHECK(coc7::skillBase("Firearms (SMG)", chars) == 15);
        // A career naming Science (Biology) takes Biology, not every science.
        const coc7::Career* doctor = nullptr;
        for (auto& c : coc7::careers()) for (auto& e : c.fixed) if (e["skill"].asString() == "Science" && json::str(e, "spec") == "生物") { doctor = &c; break; }
        CHECK(doctor != nullptr);
        if (doctor) {
            Json::Value card; card["career"]["name"] = doctor->name; card["characteristics"]["EDU"] = 80; card["characteristics"]["INT"] = 70; card["characteristics"]["DEX"] = 50;
            card["skill_points"]["Science (生物)"]["career"] = 10;
            card["skill_points"]["Science (化学)"]["career"] = 10;
            auto rep = coc7::apply(card);
            bool chemRefused = false, bioRefused = false;
            for (auto& v : rep["violations"]) { if (v["skill"].asString() == "Science (化学)") chemRefused = true; if (v["skill"].asString() == "Science (生物)") bioRefused = true; }
            CHECK(chemRefused); CHECK(!bioRefused);
            CHECK(!card["skills"].isMember("Credit Rating"));   // reading the range never inserts a null Credit Rating
        }
    });
    test("object store: images go to the image backend, reads fall back, copies are idempotent", [] {
        namespace fs = std::filesystem;
        auto root = fs::temp_directory_path() / ("acerciae-objects-" + crypto::randomHex(6));
        Config ca; ca.uploadDir = (root / "media").string(); Config cb; cb.uploadDir = (root / "images").string();
        std::shared_ptr<logstudio::ObjectStore> media = logstudio::makeBackend("local", ca), images = logstudio::makeBackend("local", cb);
        logstudio::RoutingObjectStore r(media, images);
        CHECK(r.kind() == "local+images:local");
        const std::string png = "channels/c/portrait/a.png", mp3 = "channels/c/tts/b.mp3", odd = "channels/c/portrait/c.bin";
        r.put(png, "PNG", "image/png"); r.put(mp3, "MP3", "audio/mpeg"); r.put(odd, "JPG", "image/jpeg");
        CHECK(images->exists(png) && !media->exists(png));
        CHECK(media->exists(mp3) && !images->exists(mp3));
        CHECK(images->exists(odd));                       // routed by content type even with a non-image extension
        CHECK(r.get(odd).value_or("") == "JPG");          // read prefers the media backend for ".bin", then falls back
        CHECK(r.exists(png) && r.get(png).value_or("") == "PNG" && !r.get("channels/c/portrait/none.png"));
        // Switching IMAGE_STORE back: images written before remain readable through the fallback.
        logstudio::RoutingObjectStore back(media, media, {images});
        CHECK(back.get(png).value_or("") == "PNG");
        back.put("channels/c/portrait/new.png", "NEW", "image/png"); CHECK(media->exists("channels/c/portrait/new.png"));
        // Copy images across, then a second run copies nothing.
        auto rep = logstudio::copyObjects(*images, *media, {{png, "image/png"}, {odd, "image/jpeg"}, {"channels/c/portrait/gone.png", "image/png"}});
        CHECK(rep.copied == 2 && rep.missingAtSource == 1 && rep.failed == 0);
        CHECK(logstudio::copyObjects(*images, *media, {{png, "image/png"}}).alreadyPresent == 1);
        CHECK(media->get(png).value_or("") == "PNG");
        back.remove(png); CHECK(!media->exists(png) && !images->exists(png));   // remove clears every backend
        CHECK(logstudio::isImageObject("a/b.WEBP") && logstudio::isImageObject("a/b.bin", "image/png") && !logstudio::isImageObject("a/b.mp3") && !logstudio::isImageObject("a.png/b"));
        for (auto* k : {"R2_ACCOUNT_ID", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"}) unsetenv(k);
        std::string why; try { logstudio::makeBackend("r2", ca); } catch (const std::exception& e) { why = e.what(); }
        CHECK(why.find("R2_BUCKET") != std::string::npos && why.find("R2_ACCOUNT_ID") != std::string::npos);
        setenv("R2_ACCOUNT_ID", "acct123", 1); setenv("R2_BUCKET", "b", 1); setenv("R2_ACCESS_KEY_ID", "k", 1); setenv("R2_SECRET_ACCESS_KEY", "s", 1);
        CHECK(logstudio::makeBackend("r2", ca)->kind() == "r2");
        for (auto* k : {"R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"}) unsetenv(k);
        bool unknown = false; try { logstudio::makeBackend("ftp", ca); } catch (const std::exception&) { unknown = true; } CHECK(unknown);
        std::error_code ec; fs::remove_all(root, ec);
    });
    std::cout << passed << " checks passed, " << failures << " failed\n";
    return failures == 0 ? 0 : 1;
}
