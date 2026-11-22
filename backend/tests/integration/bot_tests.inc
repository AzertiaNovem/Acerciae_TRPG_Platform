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
        S.botRuntime->tick(true);   // seats the bot at the window's end
        auto post = [&](const std::string& uid, const std::string& content, const char* kind = "ic", Json::Value extra = Json::Value(Json::objectValue)) {
            Json::Value m = extra; m["content"] = content; m["kind"] = kind; return S.chat->postMessage(S.auth->channelAccess(uid, ch), win, m); };
        auto byBot = [&] { return S.db->queryJson("SELECT kind, content, character_id, dice FROM messages WHERE chat_window_id=$1 AND author_id=$2 ORDER BY seq", {win, botUser}); };
        post(p1User, "I push the cellar door open.");
        CHECK(S.botRuntime->tick(true) == 1);
        auto lines = byBot();
        CHECK(lines.size() == 1);
        CHECK(lines[0]["kind"] == "ic"); CHECK(lines[0]["character_id"].asString() == harriet);
        CHECK(lines[0]["content"].asString().find("Harriet answers") != std::string::npos);
        CHECK(S.botRuntime->tick(true) == 0);   // its own line owes nothing
        // The GM speaks to its character: it rolls its own dice, against its own sheet.
        post(gmUser, "Harriet, roll Spot Hidden.", "narration");
        CHECK(S.botRuntime->tick(true) == 1);
        lines = byBot();
        CHECK(lines.size() == 3);
        CHECK(lines[2]["kind"] == "roll"); CHECK(lines[2]["dice"].isObject());
        // A whisper to someone else is never witnessed; a GM-only note neither.
        Json::Value secret; secret["visibility"] = "gm_only";
        post(gmUser, "Harriet is secretly a smuggler.", "narration", secret);
        CHECK(S.botRuntime->tick(true) == 0);
        // The run stops at two turns per human line, however often the GM names it.
        post(gmUser, "Harriet, anything else?", "narration");
        CHECK(S.botRuntime->tick(true) == 0);
        CHECK(byBot().size() == 3);
        // "[quiet]" makes the mock pass: logged, nothing posted.
        post(p1User, "[quiet] We wait.");
        CHECK(S.botRuntime->tick(true) == 1);
        CHECK(byBot().size() == 3);
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
        CHECK(lines() == 1);
        CHECK(S.db->queryOne("SELECT trigger FROM bot_turns WHERE bot_id=$1", {bot["id"].asString()})["trigger"] == "called");
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
        CHECK(act.size() >= 2); CHECK(act[act.size() - 1]["trigger"] == "called"); CHECK(act[act.size() - 1]["channel_name"] == "Called table");
        CHECK(outcome([&] { S.bots->activity(p1P, sid, bot["id"].asString()); }) == "forbidden");
        S.cfg.botSettleMs = 6000; S.cfg.botGmWaitMs = 90000;
    });

