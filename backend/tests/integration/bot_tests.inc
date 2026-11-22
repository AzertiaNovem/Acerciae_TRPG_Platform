    // Bots (BotService): included by db_tests.cpp, after the shared fixtures (gmP, server, channelId, p1User…).
    test("bots: maintainers set them up only while the feature is on; a bot never signs in", [&] {
        const auto sid = server["id"].asString();
        auto outcome = [](const std::function<void()>& fn) { try { fn(); return std::string("ok"); } catch (const ApiError& e) { return e.code(); } };
        Json::Value b; b["name"] = "Mina"; b["persona"] = "A cheerful librarian who loves riddles."; b["speaking_style"] = "Short, warm sentences.";
        CHECK(outcome([&] { S.bots->create(gmP, sid, b); }) == "feature_disabled");
        S.db->exec("INSERT INTO server_settings(server_id) VALUES($1) ON CONFLICT DO NOTHING", {sid});
        S.db->exec("UPDATE server_settings SET feature_bots=true WHERE server_id=$1", {sid});
        Principal p1P{p1User, "p1", "P1"};
        CHECK(outcome([&] { S.bots->create(p1P, sid, b); }) == "forbidden");   // members are not maintainers
        auto bot = S.bots->create(gmP, sid, b);
        CHECK(bot["name"] == "Mina"); CHECK(bot["persona"].asString().find("riddles") != std::string::npos);
        CHECK(bot["unprompted_per_hour"].asInt() == 2); CHECK(!bot["share_tables"].asBool());
        auto u = S.db->queryOne("SELECT username, is_bot, password_hash FROM users WHERE id=$1", {bot["user_id"].asString()});
        CHECK(u["is_bot"].asBool()); CHECK(u["username"].asString().rfind("bot-", 0) == 0);
        CHECK(S.db->queryOne("SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2", {sid, bot["user_id"].asString()})["role"] == "member");
        bool refused = false; try { S.auth->login(u["username"].asString(), "!"); } catch (const ApiError& e) { refused = e.status() == 401; }
        CHECK(refused);
        CHECK(outcome([&] { S.auth->registerUser("bot-mine", "password", "Not a bot"); }) == "bad_request");
        // Members see names only; the human paths never find a bot.
        auto seen = S.bots->list(p1P, sid);
        CHECK(seen.size() == 1); CHECK(!seen[0].isMember("persona"));
        CHECK(S.chat->searchUsers(gmP, "Mina", 10).empty());
        CHECK(outcome([&] { S.chat->addChannelMember(gm, u["username"].asString(), "player"); }) == "not_found");
        CHECK(outcome([&] { S.chat->setServerMemberRole(gmP, sid, bot["user_id"].asString(), "admin"); }) == "bad_request");
        Json::Value bad; bad["turns_per_hour"] = 0;
        CHECK(outcome([&] { S.bots->update(gmP, sid, bot["id"].asString(), bad); }) == "bad_request");
        Json::Value rename; rename["name"] = "Mina Bell"; rename["share_tables"] = true;
        auto renamed = S.bots->update(gmP, sid, bot["id"].asString(), rename);
        CHECK(renamed["name"] == "Mina Bell"); CHECK(renamed["share_tables"].asBool());
    });

    test("bots: any member invites, never into a player group; only the GM removes; the channel's switch and limit hold", [&] {
        const auto sid = server["id"].asString();
        auto outcome = [](const std::function<void()>& fn) { try { fn(); return std::string("ok"); } catch (const ApiError& e) { return e.code(); } };
        auto make = [&](const char* name) { Json::Value b; b["name"] = name; return S.bots->create(gmP, sid, b); };
        auto bot = S.bots->list(gmP, sid)[0], ken = make("Ken"), lu = make("Lu");
        // A fresh second player: earlier tests change who else is at this table.
        auto p5User = S.auth->registerUser("p5" + suffix, "password", "P5")["id"].asString();
        S.chat->addChannelMember(gm, "p5" + suffix, "player");
        auto p1a = S.auth->channelAccess(p1User, channelId), p3a = S.auth->channelAccess(p5User, channelId);
        auto groupVersion = [&] { return S.db->queryOne("SELECT g.version FROM player_groups g JOIN player_group_members m ON m.group_id=g.id WHERE m.user_id=$1 AND m.channel_id=$2", {p1User, channelId})["version"].asInt(); };
        const int before = groupVersion();
        auto view = S.bots->channelView(p1a);
        CHECK(view["can_invite"].asBool()); CHECK(!view["can_remove"].asBool()); CHECK(view["invitable"].size() == 3);
        auto after = S.bots->invite(p1a, bot["id"].asString());
        CHECK(after["present"].size() == 1); CHECK(after["present"][0]["invited_by_name"] == "P1");
        const auto botUser = bot["user_id"].asString();
        CHECK(S.db->queryOne("SELECT role FROM channel_members WHERE channel_id=$1 AND user_id=$2", {channelId, botUser})["role"] == "player");
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM player_group_members WHERE user_id=$1", {botUser})["n"].asInt() == 0);
        CHECK(groupVersion() == before);   // nobody's shared memory was rebuilt
        CHECK(S.db->queryOne("SELECT 1 AS ok FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2", {mainWin, botUser})["ok"].asInt() == 1);
        auto line = S.db->queryOne("SELECT content FROM messages WHERE chat_window_id=$1 AND kind='system' ORDER BY seq DESC LIMIT 1", {mainWin});
        CHECK(line["content"].asString().find("Mina Bell") != std::string::npos);
        CHECK(outcome([&] { S.bots->invite(p3a, bot["id"].asString()); }) == "conflict");   // already here
        auto group = S.db->queryOne("SELECT id FROM player_groups WHERE channel_id=$1 LIMIT 1", {channelId})["id"].asString();
        CHECK(outcome([&] { S.knowledge->movePlayer(gm, group, botUser); }) == "bad_request");
        // A message lists its author as a bot; the bot's character too.
        Json::Value pc; pc["name"] = "Mina's sleuth"; pc["user_id"] = botUser;
        auto character = S.chat->createCharacter(gm, pc);
        bool flagged = false;
        for (const auto& c : S.chat->listCharacters(gm)) if (c["id"] == character["id"]) flagged = c["player_is_bot"].asBool();
        CHECK(flagged);
        Json::Value stray; stray["name"] = "Nobody's"; stray["user_id"] = ken["user_id"];
        CHECK(outcome([&] { S.chat->createCharacter(gm, stray); }) == "bad_request");   // Ken was never invited
        // The GM turns invitations off: members are refused, the GM is not.
        Json::Value off; off["bot_invites_enabled"] = false;
        S.chat->updateChannel(gm, off);
        CHECK(outcome([&] { S.bots->invite(p3a, ken["id"].asString()); }) == "forbidden");
        CHECK(!S.bots->channelView(p3a)["can_invite"].asBool());
        S.bots->invite(gm, ken["id"].asString());
        // The server's limit per channel.
        S.db->exec("UPDATE server_settings SET bots_per_channel=2 WHERE server_id=$1", {sid});
        CHECK(outcome([&] { S.bots->invite(gm, lu["id"].asString()); }) == "conflict");
        // Only the GM removes; the character stays, owned by the bot.
        CHECK(outcome([&] { S.bots->removeFromChannel(p1a, bot["id"].asString()); }) == "forbidden");
        auto gone = S.bots->removeFromChannel(gm, bot["id"].asString());
        CHECK(gone["present"].size() == 1);
        CHECK(S.db->queryOne("SELECT user_id FROM characters WHERE id=$1", {character["id"].asString()})["user_id"].asString() == botUser);
        S.db->exec("UPDATE server_settings SET bots_per_channel=3 WHERE server_id=$1", {sid});
        { Json::Value back; back["bot_invites_enabled"] = true; S.chat->updateChannel(gm, back); }
        // Retiring a bot takes it out of every channel.
        S.bots->remove(gmP, sid, ken["id"].asString());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM channel_members WHERE user_id=$1", {ken["user_id"].asString()})["n"].asInt() == 0);
        CHECK(outcome([&] { S.bots->invite(gm, ken["id"].asString()); }) == "not_found");
    });

    test("bots: deleting a server deletes its bot accounts", [&] {
        auto other = S.chat->createServer(gmP, "Bots' home");
        const auto sid = other["id"].asString();
        S.db->exec("INSERT INTO server_settings(server_id) VALUES($1) ON CONFLICT DO NOTHING", {sid});
        S.db->exec("UPDATE server_settings SET feature_bots=true WHERE server_id=$1", {sid});
        Json::Value b; b["name"] = "Temporary";
        auto bot = S.bots->create(gmP, sid, b);
        Json::Value cb; cb["name"] = "Bots' table";
        auto ch = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.bots->invite(keeper, bot["id"].asString());
        Json::Value confirm; confirm["confirm"] = DeletionService::kServerPhrase;
        S.deletion->deleteServer(gmP, sid, confirm);
        CHECK(S.db->queryOne("SELECT id FROM users WHERE id=$1", {bot["user_id"].asString()}).isNull());
    });

    test("bots at play: a player's line, then the GM's: the bot plays its character, rolls its own dice, never past its run", [&] {
        S.cfg.botSettleMs = 0; S.cfg.botGmWaitMs = 0;
        const auto sid = server["id"].asString();
        Json::Value cb; cb["name"] = "Bots at play"; cb["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.chat->addChannelMember(keeper, "p1" + suffix, "player");
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        Json::Value b; b["name"] = "Wren"; b["persona"] = "A retired sailor who tells tall tales.";
        auto bot = S.bots->create(gmP, sid, b);
        const auto botUser = bot["user_id"].asString();
        S.bots->invite(keeper, bot["id"].asString());
        Json::Value pc; pc["name"] = "Harriet"; pc["user_id"] = botUser;
        auto harriet = S.chat->createCharacter(keeper, pc)["id"].asString();
        Json::Value sheet; sheet["set"]["Spot Hidden"] = 60;
        S.dice->updateAttributes(keeper, harriet, sheet);
        S.botRuntime->tick(true);   // seats the bot at the window's end; it takes up the character it was given (one line)
        CHECK(S.db->queryOne("SELECT trigger FROM bot_turns WHERE bot_id=$1", {bot["id"].asString()})["trigger"] == "adopt");
        auto post = [&](const std::string& uid, const std::string& content, const char* kind = "ic", Json::Value extra = Json::Value(Json::objectValue)) {
            Json::Value m = extra; m["content"] = content; m["kind"] = kind; return S.chat->postMessage(S.auth->channelAccess(uid, ch), win, m); };
        auto byBot = [&] { return S.db->queryJson("SELECT kind, content, character_id, dice FROM messages WHERE chat_window_id=$1 AND author_id=$2 ORDER BY seq", {win, botUser}); };
        post(p1User, "I push the cellar door open.");
        CHECK(S.botRuntime->tick(true) == 1);
        auto lines = byBot();
        CHECK(lines.size() == 2);
        CHECK(lines[1]["kind"] == "ic"); CHECK(lines[1]["character_id"].asString() == harriet);
        CHECK(lines[1]["content"].asString().find("Harriet answers") != std::string::npos);
        CHECK(S.botRuntime->tick(true) == 0);   // its own line owes nothing
        // The GM speaks to its character: it rolls its own dice, against its own sheet.
        post(gmUser, "Harriet, roll Spot Hidden.", "narration");
        CHECK(S.botRuntime->tick(true) == 1);
        lines = byBot();
        CHECK(lines.size() == 4);
        CHECK(lines[3]["kind"] == "roll"); CHECK(lines[3]["dice"].isObject());
        // A whisper to someone else is never witnessed; a GM-only note neither.
        Json::Value secret; secret["visibility"] = "gm_only";
        post(gmUser, "Harriet is secretly a smuggler.", "narration", secret);
        CHECK(S.botRuntime->tick(true) == 0);
        // The run stops at two turns per human line, however often the GM names it.
        post(gmUser, "Harriet, anything else?", "narration");
        CHECK(S.botRuntime->tick(true) == 0);
        CHECK(byBot().size() == 4);
        // "[quiet]" makes the mock pass: logged, nothing posted.
        post(p1User, "[quiet] We wait.");
        CHECK(S.botRuntime->tick(true) == 1);
        CHECK(byBot().size() == 4);
        CHECK(S.db->queryOne("SELECT status FROM bot_turns WHERE bot_id=$1 ORDER BY started_at DESC LIMIT 1", {bot["id"].asString()})["status"] == "passed");
        // The turn log never runs one trigger twice: a debt whose turn already exists is dropped unposted.
        post(p1User, "Anyone?");
        S.botRuntime->tick(false);   // no pool in tests: this runs the claimed turn inline too
        auto last = S.db->queryOne("SELECT trigger, trigger_seq FROM bot_turns WHERE bot_id=$1 ORDER BY started_at DESC LIMIT 1", {bot["id"].asString()});
        const auto before = byBot().size();
        S.db->exec("UPDATE bot_window_state SET owed=$3, owed_seq=$4 WHERE bot_id=$1 AND chat_window_id=$2", {bot["id"].asString(), win, last["trigger"].asString(), last["trigger_seq"].asInt64()});
        S.botRuntime->tick(true);
        CHECK(byBot().size() == before);
        CHECK(S.db->queryOne("SELECT owed FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {bot["id"].asString(), win})["owed"].isNull());
        // Outside the table (no character here), a bot answers only when named, and out of character.
        Json::Value pb; pb["name"] = "Pip";
        auto pip = S.bots->create(gmP, sid, pb);
        S.bots->invite(keeper, pip["id"].asString());
        S.botRuntime->tick(true);
        auto byPip = [&] { return S.db->queryJson("SELECT kind, content, character_id FROM messages WHERE author_id=$1 ORDER BY seq", {pip["user_id"].asString()}); };
        post(p1User, "Lovely weather.", "ooc");
        S.botRuntime->tick(true);
        CHECK(byPip().empty());
        post(p1User, "Pip, how was the sea?", "ooc");
        S.botRuntime->tick(true);
        auto said = byPip();
        CHECK(said.size() == 1);
        if (said.size() == 1) {
            CHECK(said[0]["kind"] == "ooc"); CHECK(said[0]["character_id"].isNull());
            CHECK(said[0]["content"].asString().find("Pip (mention)") != std::string::npos);
        }
        // With the server's feature off, no bot reads or speaks.
        S.db->exec("UPDATE server_settings SET feature_bots=false WHERE server_id=$1", {sid});
        post(p1User, "Pip?", "ooc");
        S.botRuntime->tick(true);
        CHECK(byPip().size() == 1);
        S.db->exec("UPDATE server_settings SET feature_bots=true WHERE server_id=$1", {sid});
        S.cfg.botSettleMs = 6000; S.cfg.botGmWaitMs = 90000;
    });

    test("bots: the GM's call gives every bot in the window a turn now; the GM's notes for bots stay the GM's; maintainers read the activity", [&] {
        S.cfg.botSettleMs = 0; S.cfg.botGmWaitMs = 0;
        const auto sid = server["id"].asString();
        auto outcome = [](const std::function<void()>& fn) { try { fn(); return std::string("ok"); } catch (const ApiError& e) { return e.code(); } };
        Json::Value cb; cb["name"] = "Called table"; cb["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.chat->addChannelMember(keeper, "p1" + suffix, "player");
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        Json::Value b; b["name"] = "Moss";
        auto bot = S.bots->create(gmP, sid, b);
        S.bots->invite(keeper, bot["id"].asString());
        Json::Value pc; pc["name"] = "Quill"; pc["user_id"] = bot["user_id"];
        S.chat->createCharacter(keeper, pc);
        S.botRuntime->tick(true);
        auto lines = [&] { return S.db->queryOne("SELECT count(*) AS n FROM messages WHERE chat_window_id=$1 AND author_id=$2", {win, bot["user_id"].asString()})["n"].asInt(); };
        auto p1a = S.auth->channelAccess(p1User, ch);
        CHECK(outcome([&] { S.bots->callTurn(p1a, win, Json::Value(Json::objectValue)); }) == "forbidden");
        // Its run is spent (two turns since the last human line), yet the GM's call still gives it a turn.
        S.db->exec("UPDATE bot_window_state SET chain=2 WHERE bot_id=$1 AND chat_window_id=$2", {bot["id"].asString(), win});
        auto called = S.bots->callTurn(keeper, win, Json::Value(Json::objectValue));
        CHECK(called["called"].size() == 1); CHECK(called["called"][0]["name"] == "Moss");
        CHECK(S.botRuntime->tick(true) >= 1);   // other tests' bots may have a turn due too
        CHECK(lines() == 2);   // the line taking up Quill, then the called turn
        CHECK(S.db->queryOne("SELECT trigger FROM bot_turns WHERE bot_id=$1 ORDER BY started_at DESC LIMIT 1", {bot["id"].asString()})["trigger"] == "called");
        // Only the characters named are called.
        Json::Value some; some["character_ids"] = Json::Value(Json::arrayValue); some["character_ids"].append("00000000-0000-0000-0000-000000000000");
        CHECK(S.bots->callTurn(keeper, win, some)["called"].empty());
        // A GM agent's call also leaves players' lines to it for a while.
        Json::Value pace; pace["pace"] = true;
        S.bots->callTurn(keeper, win, pace);
        CHECK(S.db->queryOne("SELECT bot_pacing_until > now() AS on FROM channels WHERE id=$1", {ch})["on"].asBool());
        S.botRuntime->tick(true);
        const auto before = lines();
        Json::Value hello; hello["content"] = "Hello there."; hello["kind"] = "ic";
        S.chat->postMessage(p1a, win, hello);
        S.botRuntime->tick(true);
        CHECK(lines() == before);   // the agent paces: a player's line owes nothing now
        Json::Value gmLine; gmLine["content"] = "Quill, the door stands open."; gmLine["kind"] = "narration";
        S.chat->postMessage(keeper, win, gmLine);
        S.botRuntime->tick(true);
        CHECK(lines() == before);   // nor the GM naming its character: the agent calls the bots itself
        // Pacing alone: an empty list calls nobody, and a turn owed for a player's line before the agent took over is its to give.
        S.db->exec("UPDATE channels SET bot_pacing_until=NULL WHERE id=$1", {ch});
        Json::Value again; again["content"] = "Anyone there?"; again["kind"] = "ic";
        S.chat->postMessage(p1a, win, again);
        S.cfg.botGmWaitMs = 90000;   // it waits for the GM: the debt stays
        S.botRuntime->tick(true);
        CHECK(S.db->queryOne("SELECT owed FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {bot["id"].asString(), win})["owed"] == "player");
        S.cfg.botGmWaitMs = 0;
        Json::Value paceOnly; paceOnly["pace"] = true; paceOnly["character_ids"] = Json::Value(Json::arrayValue);
        CHECK(S.bots->callTurn(keeper, win, paceOnly)["called"].empty());
        CHECK(S.db->queryOne("SELECT bot_pacing_until > now() AS on FROM channels WHERE id=$1", {ch})["on"].asBool());
        CHECK(S.db->queryOne("SELECT owed FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {bot["id"].asString(), win})["owed"].isNull());
        S.botRuntime->tick(true);
        CHECK(lines() == before);
        S.db->exec("UPDATE channels SET bot_pacing_until=NULL WHERE id=$1", {ch});
        // The notes for bots: the GM's to write and read.
        Json::Value note; note["text"] = "The harbour master is secretly kind.";
        CHECK(outcome([&] { S.bots->setBrief(p1a, note); }) == "forbidden");
        S.bots->setBrief(keeper, note);
        CHECK(S.chat->getChannel(keeper)["bot_brief"] == "The harbour master is secretly kind.");
        CHECK(!S.chat->getChannel(p1a).isMember("bot_brief"));
        Principal p1P{p1User, "p1", "P1"};
        for (const auto& c : S.chat->listChannels(p1P, sid)) CHECK(!c.isMember("bot_brief"));
        Json::Value tooLong; tooLong["text"] = std::string(12001, 'x');
        CHECK(outcome([&] { S.bots->setBrief(keeper, tooLong); }) == "bad_request");
        // The activity: maintainers only.
        auto act = S.bots->activity(gmP, sid, bot["id"].asString());
        CHECK(act.size() >= 2); CHECK(act[act.size() - 1]["trigger"] == "adopt"); CHECK(act[act.size() - 2]["trigger"] == "called"); CHECK(act[act.size() - 1]["channel_name"] == "Called table");
        CHECK(outcome([&] { S.bots->activity(p1P, sid, bot["id"].asString()); }) == "forbidden");
        S.cfg.botSettleMs = 6000; S.cfg.botGmWaitMs = 90000;
    });

    test("bots make their own character when asked (Call of Cthulhu, point buy), or take up one the GM makes", [&] {
        S.cfg.botSettleMs = 0; S.cfg.botGmWaitMs = 0;
        const auto sid = server["id"].asString();
        Json::Value cb; cb["name"] = "Character table"; cb["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        Json::Value pb; pb["point_buy"] = true; S.chat->updateChannel(keeper, pb);
        S.chat->addChannelMember(keeper, "p1" + suffix, "player");
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        Json::Value b; b["name"] = "Sable"; b["persona"] = "Loves old books and quiet mysteries.";
        auto bot = S.bots->create(gmP, sid, b);
        const auto botUser = bot["user_id"].asString();
        S.bots->invite(keeper, bot["id"].asString());
        S.botRuntime->tick(true);
        auto p1a = S.auth->channelAccess(p1User, ch);
        auto say = [&](const std::string& content) { Json::Value m; m["content"] = content; m["kind"] = "ooc"; S.chat->postMessage(p1a, win, m); };
        say("Sable, make your character for tonight!");
        S.botRuntime->tick(true);
        auto pcs = S.db->queryJson("SELECT id, name, role_card, sheet FROM characters WHERE channel_id=$1 AND user_id=$2", {ch, botUser});
        CHECK(pcs.size() == 1);
        if (pcs.size() == 1) {
            CHECK(pcs[0]["name"].asString().find("Sable Vale") != std::string::npos);
            CHECK(pcs[0]["role_card"]["career"]["name"] == "自定义职业");
            CHECK(!pcs[0]["role_card"]["skills"].isMember("Cthulhu Mythos"));
            CHECK(pcs[0]["role_card"]["skills"]["Library Use"].asInt() > 20);
            // Bound to the window: from now on it plays it at the table.
            CHECK(S.db->queryOne("SELECT character_id FROM chat_window_members WHERE chat_window_id=$1 AND user_id=$2", {win, botUser})["character_id"] == pcs[0]["id"]);
        }
        CHECK(!S.db->queryOne("SELECT 1 AS ok FROM messages WHERE chat_window_id=$1 AND author_id=$2 AND content LIKE '%character is ready%'", {win, botUser}).isNull());
        // Asked again, it has one already: nothing more is made.
        say("Sable, make your character again?");
        S.botRuntime->tick(true);
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM characters WHERE channel_id=$1 AND user_id=$2", {ch, botUser})["n"].asInt() == 1);
        // A character the GM makes for a bot is taken up: one turn, in character.
        Json::Value b2; b2["name"] = "Fern";
        auto fern = S.bots->create(gmP, sid, b2);
        S.bots->invite(keeper, fern["id"].asString());
        S.botRuntime->tick(true);
        Json::Value pc; pc["name"] = "Old Tom"; pc["user_id"] = fern["user_id"];
        S.chat->createCharacter(keeper, pc);
        S.botRuntime->tick(true);
        auto took = S.db->queryOne("SELECT m.kind, m.content FROM messages m JOIN characters c ON c.id=m.character_id WHERE m.chat_window_id=$1 AND m.author_id=$2 AND c.name='Old Tom' ORDER BY m.seq DESC LIMIT 1", {win, fern["user_id"].asString()});
        CHECK(!took.isNull());
        CHECK(S.db->queryOne("SELECT trigger FROM bot_turns WHERE bot_id=$1 ORDER BY started_at DESC LIMIT 1", {fern["id"].asString()})["trigger"] == "adopt");
        S.cfg.botSettleMs = 6000; S.cfg.botGmWaitMs = 90000;
    });

    test("bots remember a table: the window's lines in its account, whispers in a private part read only there, notes on people", [&] {
        S.cfg.botSettleMs = 0; S.cfg.botGmWaitMs = 0;
        for (int i = 0; i < 20 && S.botRuntime->memoryTick(true) > 0; ++i) {}   // what other tests' bots still had to write down
        const auto sid = server["id"].asString();
        Json::Value cb; cb["name"] = "Lighthouse"; cb["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.chat->addChannelMember(keeper, "p1" + suffix, "player");
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        Json::Value b; b["name"] = "Moth"; b["persona"] = "Collects ghost stories.";
        auto bot = S.bots->create(gmP, sid, b);
        const auto botId = bot["id"].asString(), botUser = bot["user_id"].asString();
        // Lines from before it came are never its to remember.
        Json::Value before; before["content"] = "Before Moth came, the lamp went out."; before["kind"] = "ic";
        S.chat->postMessage(S.auth->channelAccess(p1User, ch), win, before);
        S.bots->invite(keeper, botId);
        Json::Value pc; pc["name"] = "Ivo"; pc["user_id"] = botUser;
        // Given a character before the runtime first looked, it starts reading and remembering from the window's end.
        auto ivo = S.chat->createCharacter(keeper, pc)["id"].asString();
        auto seated = S.db->queryOne("SELECT cursor_seq, memory_seq FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {botId, win});
        CHECK(!seated.isNull()); CHECK(seated["memory_seq"].asInt64() == seated["cursor_seq"].asInt64()); CHECK(seated["memory_seq"].asInt64() > 0);
        S.botRuntime->tick(true);
        auto post = [&](const std::string& uid, const std::string& chId, const std::string& w, const std::string& content, const char* kind = "ic", Json::Value extra = Json::Value(Json::objectValue)) {
            Json::Value m = extra; m["content"] = content; m["kind"] = kind; return S.chat->postMessage(S.auth->channelAccess(uid, chId), w, m); };
        post(p1User, ch, win, "We climb the lighthouse stairs.");
        S.botRuntime->tick(true);
        // Its run is over (the mock would answer the whisper aloud): the whisper is only witnessed.
        S.db->exec("UPDATE bot_window_state SET chain=2 WHERE bot_id=$1 AND chat_window_id=$2", {botId, win});
        Json::Value whisper; whisper["visibility"] = "whisper"; whisper["whisper_to"].append(ivo);
        post(gmUser, ch, win, "Ivo, you recognise the keeper.", "narration", whisper);
        Json::Value secret; secret["visibility"] = "gm_only";
        post(gmUser, ch, win, "The keeper is a ghost.", "narration", secret);
        S.botRuntime->tick(true);
        auto memory = [&](const char* kind, const std::string& chId) { return S.db->queryOne("SELECT text, highlight FROM bot_memories WHERE bot_id=$1 AND kind=$2 AND channel_id=$3", {botId, kind, chId}); };
        // Not yet: a few lines, no scenario closed.
        CHECK(S.botRuntime->memoryTick(true) == 0);
        S.botRuntime->memory().flushChannel(ch);
        CHECK(S.botRuntime->memoryTick(true) == 1);
        auto account = memory("table", ch), whispered = memory("table_private", ch);
        CHECK(account["text"].asString().find("We climb the lighthouse stairs") != std::string::npos);
        CHECK(account["text"].asString().find("Before Moth came") == std::string::npos);
        CHECK(account["text"].asString().find("recognise the keeper") == std::string::npos);
        CHECK(account["text"].asString().find("ghost") == std::string::npos);
        CHECK(!account["highlight"].asString().empty());
        CHECK(whispered["text"].asString().find("recognise the keeper") != std::string::npos);
        CHECK(whispered["text"].asString().find("ghost") == std::string::npos);
        CHECK(!S.db->queryOne("SELECT 1 AS ok FROM bot_memories WHERE bot_id=$1 AND kind='person' AND subject_user_id=$2", {botId, p1User}).isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM bot_memories WHERE bot_id=$1 AND kind='person' AND subject_user_id IN ($2, $3)", {botId, botUser, gmUser})["n"].asInt() == 0);
        CHECK(S.botRuntime->memoryTick(true) == 0);   // nothing new
        // At the table: its account and the whispers. As itself elsewhere, with people who were not there: neither.
        auto here = S.botRuntime->memory().recall(botId, ch, win, true);
        CHECK(here.find("THIS TABLE SO FAR") != std::string::npos); CHECK(here.find("recognise the keeper") != std::string::npos);
        Json::Value cb2; cb2["name"] = "Harbour"; cb2["knowledge_mode"] = "isolated";
        auto ch2 = S.chat->createChannel(gmP, sid, cb2)["id"].asString();
        auto keeper2 = S.auth->channelAccess(gmUser, ch2);
        S.chat->addChannelMember(keeper2, "p2" + suffix, "player");
        auto win2 = S.chat->listWindows(keeper2)[0]["id"].asString();
        Json::Value early; early["content"] = "Earlier at the harbour, a gull stole a pie."; early["kind"] = "ooc";
        S.chat->postMessage(S.auth->channelAccess(p2User, ch2), win2, early);
        S.bots->invite(keeper2, botId);
        S.bots->callTurn(keeper2, win2, Json::Value(Json::objectValue));   // the GM's call seats it before the runtime looks
        auto called = S.db->queryOne("SELECT cursor_seq, memory_seq FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {botId, win2});
        CHECK(!called.isNull()); CHECK(called["memory_seq"].asInt64() == called["cursor_seq"].asInt64());
        S.botRuntime->tick(true);
        CHECK(S.botRuntime->memory().recall(botId, ch2, win2, false).find("lighthouse") == std::string::npos);
        // Its maintainers let it share between tables: the account comes up everywhere, never the whispers.
        Json::Value share; share["share_tables"] = true;
        S.bots->update(gmP, sid, botId, share);
        auto shared = S.botRuntime->memory().recall(botId, ch2, win2, false);
        CHECK(shared.find("Lighthouse") != std::string::npos); CHECK(shared.find("Most striking") != std::string::npos);
        CHECK(shared.find("recognise the keeper") == std::string::npos);
        post(p2User, ch2, win2, "Moth, tell us a story.", "ooc");
        S.botRuntime->tick(true);
        auto told = S.db->queryOne("SELECT content FROM messages WHERE chat_window_id=$1 AND author_id=$2 ORDER BY seq DESC LIMIT 1", {win2, botUser});
        CHECK(told["content"].asString().find("I remember:") != std::string::npos);
        // Maintainers read and correct it; the GM's briefing is read at that table only; the GM can make it forget.
        auto all = S.bots->memories(gmP, sid, botId)["memories"];
        std::set<std::string> kinds; std::string tableId;
        for (const auto& m : all) { kinds.insert(m["kind"].asString()); if (m["kind"] == "table" && m["channel_id"].asString() == ch) tableId = m["id"].asString(); }
        CHECK(kinds.count("table") && kinds.count("table_private") && kinds.count("person"));
        Json::Value fix; fix["text"] = "I met a ghost's friend at the lighthouse."; fix["highlight"] = "The stairs.";
        S.bots->editMemory(gmP, sid, botId, tableId, fix);
        CHECK(S.db->queryOne("SELECT source FROM bot_memories WHERE id=$1", {tableId})["source"] == "edited");
        Json::Value note; note["text"] = "Owes Ada a song.";
        S.bots->addNote(gmP, sid, botId, note);
        CHECK(S.botRuntime->memory().recall(botId, ch2, win2, false).find("Owes Ada a song.") != std::string::npos);
        Json::Value brief; brief["text"] = "Ivo owes the keeper a debt.";
        CHECK(S.bots->setBriefing(keeper, botId, brief)["briefing"]["text"] == "Ivo owes the keeper a debt.");
        CHECK(S.botRuntime->memory().recall(botId, ch, win, true).find("owes the keeper") != std::string::npos);
        CHECK(S.botRuntime->memory().recall(botId, ch2, win2, false).find("owes the keeper") == std::string::npos);
        auto outcome = [](const std::function<void()>& fn) { try { fn(); return std::string("ok"); } catch (const ApiError& e) { return e.code(); } };
        CHECK(outcome([&] { S.bots->tableMemory(S.auth->channelAccess(p1User, ch), botId); }) == "forbidden");
        auto forgot = S.bots->forgetTable(keeper, botId);
        CHECK(forgot["table"].isNull()); CHECK(forgot["table_private"].isNull()); CHECK(!forgot["briefing"].isNull());
        // Leaving a table, it writes down what it saw there; invited back, it starts again from the window's end.
        post(p2User, ch2, win2, "We row out at dawn.", "ooc");
        S.botRuntime->tick(true);
        S.bots->removeFromChannel(keeper2, botId);
        CHECK(S.botRuntime->memoryTick(true) == 1);
        CHECK(memory("table", ch2)["text"].asString().find("We row out at dawn") != std::string::npos);
        CHECK(memory("table", ch2)["text"].asString().find("gull stole a pie") == std::string::npos);
        S.botRuntime->tick(true);
        CHECK(S.db->queryOne("SELECT 1 AS ok FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {botId, win2}).isNull());
        S.cfg.botSettleMs = 6000; S.cfg.botGmWaitMs = 90000;
    });

    test("bots join in on their own outside the table: after people talk a while, within the hourly allowance and the GM's switch", [&] {
        S.cfg.botSettleMs = 0; S.cfg.botChatterGapMs = 0; S.cfg.botChatterQuietMs = 0;
        const auto sid = server["id"].asString();
        Json::Value cb; cb["name"] = "Tavern"; cb["knowledge_mode"] = "isolated";
        auto ch = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, ch);
        S.chat->addChannelMember(keeper, "p1" + suffix, "player");
        auto win = S.chat->listWindows(keeper)[0]["id"].asString();
        Json::Value b; b["name"] = "Lark"; b["unprompted_per_hour"] = 1;
        auto bot = S.bots->create(gmP, sid, b);
        const auto botId = bot["id"].asString(), botUser = bot["user_id"].asString();
        S.bots->invite(keeper, botId);
        S.botRuntime->tick(true);
        auto say = [&](const std::string& content) { Json::Value m; m["content"] = content; m["kind"] = "ooc"; S.chat->postMessage(S.auth->channelAccess(p1User, ch), win, m); };
        auto lines = [&] { return S.db->queryJson("SELECT content FROM messages WHERE chat_window_id=$1 AND author_id=$2 ORDER BY seq", {win, botUser}); };
        say("Nice night.");
        CHECK(S.botRuntime->tick(true) == 0);   // one line is not yet a conversation
        say("Anyone up for cards?");
        CHECK(S.botRuntime->tick(true) == 1);
        auto said = lines();
        CHECK(said.size() == 1);
        if (!said.empty()) CHECK(said[0]["content"].asString().find("Lark (unprompted)") != std::string::npos);
        CHECK(S.db->queryOne("SELECT heard FROM bot_window_state WHERE bot_id=$1 AND chat_window_id=$2", {botId, win})["heard"].asInt() == 0);
        // Its allowance for the hour is spent.
        say("Deal me in."); say("Me too.");
        CHECK(S.botRuntime->tick(true) == 0);
        CHECK(lines().size() == 1);
        // More allowance, but the GM turns chatter off here: it only answers when named.
        Json::Value more; more["unprompted_per_hour"] = 5;
        S.bots->update(gmP, sid, botId, more);
        Json::Value off; off["bot_chatter_enabled"] = false;
        S.chat->updateChannel(keeper, off);
        say("Shuffle."); say("Cut.");
        CHECK(S.botRuntime->tick(true) == 0);
        Json::Value on; on["bot_chatter_enabled"] = true;
        S.chat->updateChannel(keeper, on);
        say("Your turn."); say("Hearts.");
        CHECK(S.botRuntime->tick(true) == 1);
        CHECK(lines().size() == 2);
        S.cfg.botSettleMs = 6000; S.cfg.botChatterGapMs = 300000; S.cfg.botChatterQuietMs = 20000;
    });

    test("private chats: one per person and bot, never listed, spectated or joined; every line is for the bot; its memory stays there", [&] {
        S.cfg.botSettleMs = 0;
        for (int i = 0; i < 20 && S.botRuntime->memoryTick(true) > 0; ++i) {}
        const auto sid = server["id"].asString();
        auto outcome = [](const std::function<void()>& fn) { try { fn(); return std::string("ok"); } catch (const ApiError& e) { return e.code(); } };
        Json::Value b; b["name"] = "Quill"; b["share_tables"] = true;
        auto bot = S.bots->create(gmP, sid, b);
        const auto botId = bot["id"].asString(), botUser = bot["user_id"].asString();
        Principal p1P{p1User, "p1" + suffix, "P1"}, p2P{p2User, "p2" + suffix, "P2"};
        auto chat = S.bots->openChat(p1P, sid, botId);
        CHECK(chat["created"].asBool()); CHECK(chat["bot_name"] == "Quill");
        const auto ch = chat["channel_id"].asString(), win = chat["window_id"].asString();
        auto again = S.bots->openChat(p1P, sid, botId);
        CHECK(!again["created"].asBool()); CHECK(again["channel_id"].asString() == ch);
        CHECK(S.bots->chats(p1P, sid).size() >= 1); CHECK(S.bots->chats(p2P, sid).empty());
        // Hidden everywhere else.
        for (const auto& c : S.chat->listChannels(p1P, sid)) CHECK(c["id"].asString() != ch);
        for (const auto& c : S.chat->allChannels(gmP, sid)) CHECK(c["id"].asString() != ch);
        for (const auto& c : S.chat->spectatableChannels(p2P, sid)) CHECK(c["id"].asString() != ch);
        CHECK(!S.chat->canSpectate(p2User, ch));
        for (const auto& c : S.bots->list(gmP, sid)) if (c["id"].asString() == botId) CHECK(c["channels"].empty());
        auto mine = S.auth->channelAccess(p1User, ch);
        CHECK(mine.botChat);
        Json::Value pc; pc["name"] = "Stray";
        CHECK(outcome([&] { S.chat->createCharacter(mine, pc); }) == "forbidden");
        CHECK(outcome([&] { S.bots->invite(mine, botId); }) == "forbidden");
        CHECK(outcome([&] { S.chat->addChannelMember(mine, "p2" + suffix, "player"); }) == "forbidden");
        CHECK(outcome([&] { S.auth->channelAccess(p2User, ch); }) == "forbidden");
        // Every line of theirs is for the bot.
        S.botRuntime->tick(true);
        Json::Value hi; hi["content"] = "Rainy day here."; hi["kind"] = "ooc";
        S.chat->postMessage(mine, win, hi);
        CHECK(S.botRuntime->tick(true) == 1);
        auto answer = S.db->queryOne("SELECT content FROM messages WHERE chat_window_id=$1 AND author_id=$2 ORDER BY seq DESC LIMIT 1", {win, botUser});
        CHECK(answer["content"].asString().find("Rainy day here.") != std::string::npos);
        // Its memory of the chat: never elsewhere (sharing on or not), and no notes on people.
        S.botRuntime->memory().flushChannel(ch);
        CHECK(S.botRuntime->memoryTick(true) == 1);
        CHECK(!S.db->queryOne("SELECT 1 AS ok FROM bot_memories WHERE bot_id=$1 AND kind='table' AND channel_id=$2", {botId, ch}).isNull());
        CHECK(S.db->queryOne("SELECT count(*) AS n FROM bot_memories WHERE bot_id=$1 AND kind='person'", {botId})["n"].asInt() == 0);
        CHECK(S.botRuntime->memory().recall(botId, ch, win, false).find("Rainy day") != std::string::npos);
        Json::Value cb; cb["name"] = "Quill's table"; cb["knowledge_mode"] = "isolated";
        auto table = S.chat->createChannel(gmP, sid, cb)["id"].asString();
        auto keeper = S.auth->channelAccess(gmUser, table);
        S.chat->addChannelMember(keeper, "p1" + suffix, "player");
        S.bots->invite(keeper, botId);
        auto tableWin = S.chat->listWindows(keeper)[0]["id"].asString();
        CHECK(S.botRuntime->memory().recall(botId, table, tableWin, false).find("Rainy day") == std::string::npos);
        for (const auto& m : S.bots->memories(gmP, sid, botId)["memories"]) CHECK(m["channel_id"].asString() != ch);
        // A person's private chats share an hourly allowance of the bots' turns.
        S.db->exec("INSERT INTO bot_turns(bot_id, channel_id, chat_window_id, trigger, trigger_seq, mode, status) "
                   "SELECT $1, $2, $3, 'mention', -g, 'self', 'posted' FROM generate_series(1, 30) g", {botId, ch, win});
        Json::Value more; more["content"] = "Still there?"; more["kind"] = "ooc";
        S.chat->postMessage(mine, win, more);
        CHECK(S.botRuntime->tick(true) == 0);
        // Only its person deletes it, without a phrase.
        CHECK(outcome([&] { S.deletion->deleteChannel(p2P, ch, Json::Value(Json::objectValue)); }) == "not_found");
        CHECK(outcome([&] { S.deletion->deleteChannel(gmP, ch, Json::Value(Json::objectValue)); }) == "not_found");
        CHECK(S.deletion->deleteChannel(p1P, ch, Json::Value(Json::objectValue))["ok"].asBool());
        CHECK(S.db->queryOne("SELECT id FROM channels WHERE id=$1", {ch}).isNull());
        S.cfg.botSettleMs = 6000;
    });

