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

