// Core unit tests: no database required.
#include "core/Text.h"
#include "core/Json.h"
#include "core/Crypto.h"
#include "core/Db.h"
#include "llm/SchemaValidator.h"
#include "llm/MockLlmClient.h"
#include "llm/LlmGateway.h"
#include "knowledge/KnowledgeService.h"
#include "documents/DocumentService.h"
#include "logstudio/LogAdapters.h"
#include "dice/Dice.h"
#include "logstudio/TtsProvider.h"
#include "logstudio/TtsService.h"
#include "logstudio/PublicationService.h"
#include "logstudio/PresentationService.h"
#include "logstudio/VnScriptService.h"
#include "logstudio/ImageProvider.h"
#include <iostream>
#include <functional>
#include <vector>

using namespace acerciae;
static int failures = 0, passed = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "  FAIL " << __FILE__ << ":" << __LINE__ << " " #cond "\n"; failures++; } else passed++; } while (0)
static void test(const char* name, std::function<void()> fn) { std::cout << "- " << name << "\n"; try { fn(); } catch (const std::exception& e) { std::cerr << "  EXCEPTION " << e.what() << "\n"; failures++; } }

int main() {
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
        auto o = gw.runStructured(req); CHECK(o.ok); CHECK(o.data.isMember("conflicts")); CHECK(gw.isMock());
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
    test("mock speech produces measurable audio and dictionary never alters its source", [] {
        setenv("TTS_PROVIDER","mock",1);auto provider=logstudio::makeTtsProvider();logstudio::TtsSynthesisRequest req;req.text="调查员打开了门。";req.voiceId="mock-cherry";auto r=provider->synthesize(req);CHECK(r.ok&&r.mime=="audio/wav");CHECK(logstudio::wavDurationMs(r.audioBytes)==r.durationMs);CHECK(logstudio::wavDurationMs("RIFFtruncated")==0);
        auto entries=json::parse(R"([{"term":"拉莱耶","reading":"拉来耶","mode":"replace"}])");std::string source="我们前往拉莱耶。";CHECK(logstudio::TtsService::applyDictionary(source,entries,false)=="我们前往拉来耶。");CHECK(source=="我们前往拉莱耶。");
        Json::Value params;auto k=logstudio::TtsService::cacheKey("mock","model","voice",1,source,"",1,params);CHECK(k!=logstudio::TtsService::cacheKey("mock","model","voice",2,source,"",1,params));CHECK(k!=logstudio::TtsService::cacheKey("mock","model","voice",1,source,"whisper",1,params));
    });
    std::cout << passed << " checks passed, " << failures << " failed\n";
    return failures == 0 ? 0 : 1;
}
