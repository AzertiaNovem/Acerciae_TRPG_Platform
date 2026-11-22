<!-- The plan for removing daily life and moving co-players to the platform as bots, kept with the code so the staged work can continue in a later session. Updated as stages land; it becomes docs/BOTS.md at the end. -->

# Plan: remove daily life; move co-players to the platform as bots

## Context

Two requests from the owner:

1. **Remove "daily life".** The work that lets the story run while players are absent is abandoned.
2. **Bots.** Today the gm-agent is both a GM agent and a co-player agent. Co-players move to the platform as *bots*:
   a server's owner sets them up (name, speaking style, a persona for use outside the table, a long-term memory);
   a "bot" tag follows their name; players can invite them; they notice in chat when they are asked to make their role
   card and make one in keeping with persona and memory, or accept one the GM designs; at the table they play as
   co-players do now; their outside persona receives a summary of what they saw at each table, with the most striking
   moment, so players can keep them as regular friends.

## Decisions made by the owner

| Question | Decision |
|---|---|
| What to remove | All of daily life (clock/timetable, sparks, unattended scenes, daily planner, passive presence, stand-ins, `/away`, day summaries, thread owners, platform and app marks). Older autonomy (quiet turns, side threads, away mode) stays. |
| Who may invite a bot into a table | Any member of that channel; it joins at once. The GM can remove it; a per-channel switch turns bot invitations off. |
| Outside the table | A bot answers when addressed and may join in on its own, within an hourly limit the server owner sets. |
| Where bots chat outside the table | In any channel they are invited to, and in private one-to-one chats with a player (new platform feature, own stage). |
| Bot memory across tables | The server owner chooses per bot: keep tables separate (default) or share freely. Whispers and private scenes never leave their table. |
| Co-players in the GM agent | Removed once platform bots work. The GM agent keeps the GM, NPCs and the planner. |
| Mobile apps | Show the "bot" tag only. Bots are created, edited and invited in the web or desktop app. |
| Delivery | Staged, built in this session, one pull request per step, in sequence on the session branch. |
| Merging | I merge each pull request when CI passes and continue; I stop only on a failure or a needed decision. |

## What the research found

**Removal**
- Daily life is off by default (`daily.enabled: false`), and with it off almost every daily branch already behaves as
  before. Removal rule: **remove exactly what only runs when daily life is on, plus the platform marks; behaviour with
  it off must not change.** Proof: `gm-agent/test/fixtures/prompts.*.json` stay byte-identical.
- Commit `2be1b1cf` mixed in things that run with daily life off and are not absent-player features: the co-player
  attention review in attended turns, proactive scene discovery, co-player rotation, side turns in the primary window.
  They stay in stage 1 (attention leaves later with the co-players). Only its unattended "gentle" variant goes.
- Migration `0065` cannot be deleted; a new migration drops `messages.stand_in` and `characters.passive_since`.

**Bots**
- New for the platform: bot accounts, chat outside channels, per-bot memory, member-initiated invitations.
- Existing building blocks: acting as any user in-process (`AuthService::channelAccess` + `ChatService::postMessage`,
  as `chat/Illustrations.cpp` does); `InspirationService`'s player-voice prompt; per-use models, budget, concurrency
  and usage (`LlmGateway`, `ai/ProviderCatalog.cpp`, `AiPolicyService`); role-card validation
  (`CharacterSpaceService::updateCard`, `coc7::apply`, `dnd2024::check`); `SceneManager::setClosedHook`.
- A bot posting from its own account is an ordinary player line (this also ends today's flaw that co-player lines are
  recorded as GM lines). To the GM agent a bot is automatically a player with a PC, so both coexist until stage 6.
- Corrections the design review forced on my first draft:
  1. **Bots must stay out of player knowledge groups.** Joining one fires `reset_player_memory` (migration 0013),
     wiping and rebuilding the table's shared memory on every invite. Bots get their own per-user "witnessed" filter.
  2. `InspirationService` cannot be called as is (prompt built inline, 3 tool rounds). Its helpers are extracted; a
     bot turn is one model call without tools.
  3. Bot runtime uses its own tables with row leases, not `ai_jobs` (its lock is cleared on every restart).
  4. Loop safety: a bot's turn allowance resets **only on a human player's line**, never on a GM line, because the GM
     agent answers every player line.

## Step 0 (before stage 1)

- Pull `main` (local is 7 commits behind: `a4ab55bf` vs `1763b907`) and restart the session branch from it.
- Try to enable a local backend build: switch the two URIs in `/etc/apt/sources.list.d/ubuntu.sources` to `https://`,
  `apt-get update`, install `libdrogon-dev libtrantor-dev libpqxx-dev libpq-dev libjsoncpp-dev libpoppler-cpp-dev
  libcurl4-openssl-dev libhiredis-dev libyaml-cpp-dev libmariadb-dev libmariadb-dev-compat ccache`; start the
  PostgreSQL 16 cluster and set the `postgres` password; `npm ci` in `tests/integration`. Expected: clean build
  10–20 min, full `scripts/test.sh` 15–30 min. **If this fails, backend work is verified by CI only** (30–40 min a
  round), which is why logic goes into pure, unit-tested functions.
- Commit this plan as `docs/BOTS_PLAN.md` with the first pull request, so it survives a container restart; keep it
  updated as steps land; it becomes `docs/BOTS.md` at the end.

## Overview of steps (13 pull requests)

| Step | Content | Local verification |
|---|---|---|
| 1a | Remove daily life from the GM agent | full |
| 1b | Remove stand-in / passive marks from platform, web, mobile | backend if step 0 works; mobile CI only |
| 2a | Bot accounts, settings page, tag, invitations (backend + web) | as above |
| 2b | "bot" tag on mobile | CI only |
| 3a | Bot runtime: pacing, speaking as itself or as its PC | as above |
| 3b | Dice, typing flag, GM "bots' turn", table brief, GM recall of bot lines | as above |
| 4a | Role cards: CoC 7e, and adopting a GM-made character | as above |
| 4b | Role cards: D&D 2024 and PbtA | as above |
| 5a | Memory: per-table summaries, notes on people, sharing switch, editor | as above |
| 5b | Unprompted speech with hourly limit | as above |
| 6a | GM agent cooperates with bots (paces them, pushes the table brief) | full |
| 6b + 6c | GM agent: switch co-players off, then delete their code | full |
| 7 | Private chats with a bot | as above |

## Stage 1: remove daily life

Two pull requests, GM agent first: if the platform dropped `stand_in` first, an old agent with daily life on would
post stand-ins as ordinary GM lines.

### 1a: GM agent (`gm-agent/`)

Method: constant-fold the "off" values, then delete dead code. Run `npm test` after each step.

| Expression | Folds to |
|---|---|
| `dailyOn()`, `isPassive()`, `sparkCancelled()`, `gentle`, `spark`, `whistle`, `mode === "spark"` | `false` |
| `readClock()` | `true` |
| `passiveNote()` | `''` |
| `standinReplies()`, `standinAct()` | `0` |

1. **Tests first.** Delete `test/daily.test.mjs`, `test/daily-loop.test.mjs`. Trim daily cases in
   `turn-format.test.mjs`, `world-state.test.mjs`, `writing.test.mjs`, `config.test.mjs`, the gentle case in
   `attention.test.mjs`, and the references in `loop.test.mjs` and `worldbook-loop.test.mjs`. Keep
   `test/fixtures/platform.mjs` (shared).
2. **Call sites.**
   - `src/table/scheduling.mjs`: `onMessage` is `dispatchMessage` again (no `handledMessages`, no daily branch); remove
     `clockTick`, `budgetPressure`, gentle arrivals, the daily gates in `tick`. Keep the attention tick.
   - `src/loop.mjs`: remove the daily import and its 22 delegates, checkpoint fields, the spark block, `dailyReturns`,
     both `standinReplies` passes, gentle branches, the passive clause in `mayMove`. Keep attended attention.
     Rename `init({dailyStart})` to `init({syncWorld})` (it still gates `syncWorldbook()`); update `cli.mjs`.
   - `src/table/attention.mjs`: drop the `gentle` parameter, the UNATTENDED sentence, `!m.stand_in`, `sparkCancelled`.
   - `src/table/actions.mjs`: remove `question_done`, `readClock` calls, spark/gentle in `mayPost`/`notePosted`; keep
     `sendLine` with the Forge `expected_owner_id` logic, minus the `stand_in` exemption.
   - `src/table/planning.mjs` + `src/planner.mjs`: remove thread owners (`threadOwnerIds`, `ownerStatus`, `owners`,
     `needs`), `week`, "Player availability", bond refusal for passive PCs, the daily branches of `moveCalendar`,
     `applyBetween` and `maybePlan` (the final review moves the calendar again).
   - `src/director.mjs`, `src/coplayer.mjs`, `src/table/coplayers.mjs`, `src/turn-format.mjs`: remove `daily`,
     `unattended`, spark, whistle, gentle, `question_done`, `needs_reply_from`, `standinRequests`. Keep
     `attention_review`.
   - Smaller edits: `table/windows.mjs`, `whereabouts.mjs` (`passiveFollowers`), `table/world-state.mjs`,
     `context/gmContext.mjs`, `table/context.mjs`, `table/social.mjs` (`/away`), `table/recovery.mjs`, `presence.mjs`,
     `context/coplayerContext.mjs`, `api.mjs` (`setCharacterPresence`), `timelines.mjs` + `calendar.mjs` (clock),
     `table/worldbook.mjs` (comment).
3. **Delete modules:** `src/daily.mjs`, `daily-locale.mjs`, `daily-planner.mjs`, `standin.mjs`,
   `context/standinContext.mjs`, `table/daily.mjs`.
4. **Config and surfaces:** `config.mjs` (daily section, `standin-context-tokens`), `host-schema.mjs`,
   `host-status.mjs`, `llm/routes.mjs` (4 purposes), `llm/mock.mjs`, `cli.mjs`, `web/app.js` (daily card),
   `web/usage.js`, `gm-agent.example.yml`, `README.md`. Keep `context.daily_token_budget` (unrelated).
5. **Existing data:** stop reading the state's `daily` key and delete it on save; `calendar.clock` and thread clocks
   are dropped by the normalisers. In `store.mjs` remove `day_summaries`, `daily_derived_lines`, `forgetStandin`; keep
   `context_omissions` and its filter as a frozen list (dropping it would bring lines derived from recalled stand-ins
   back into old campaigns' contexts).
6. **Docs:** delete `docs/DAILY_LIFE_PLAN.md`, `docs/DAILY_LIFE_FIXES.md`.

### 1b: platform and clients

- **Migration `backend/migrations/0070_remove_daily_life.sql`:** drop `messages.stand_in`, `characters.passive_since`;
  strip `stand_in` from `events.payload` and `log_events.metadata`. Old stand-in lines remain as ordinary lines; the
  owner's unlimited recall of them ends. Not reversible without re-adding the columns.
- **Backend:** `chat/Messages.cpp` (validation, insert, event role/payload, owner-recall branch; `stand_in: true` in a
  request returns 400 for one release), `chat/CharacterProfiles.cpp` (`setCharacterPresence`, `passive_since` in
  `transferCharacter`), `chat/ChatService.h`, `api/CharacterRoutes.cpp`, `logstudio/LogStudioService.cpp`,
  `logstudio/LogAdapters.cpp`, the test in `backend/tests/integration/db_tests.cpp`, `docs/API.md`.
- **Web:** `CharacterStatus.tsx` (`PassiveMark`), `ChannelSidebar.tsx`, `MessageList.tsx`, `types/index.ts`, 3 i18n
  keys; in `frontend/tests/passive-presence.test.cjs` move the unrelated interactive-message test (lines 44–56) to a
  kept file, delete the rest.
- **Mobile (CI only):** `MainActivity.kt`, `AppViewModel.kt` (keep the `!m.recalled` fix), `Models.kt`,
  `RootView.swift`, `AcerciaeApp.swift`, `Models.swift`; `mobile.tsv` rows, then
  `python3 mobile/scripts/sync-localizations.py`; delete the fixture and both tests; add a dated section to
  `mobile/contracts/INTEGRATION.md`.
- Delete `tests/integration/passive-presence.test.mjs` (also removes a 121 s sleep from CI).

## Stage 2: bot accounts, settings, tag, invitations

Bots exist, can be invited and are tagged everywhere; they are silent until stage 3.

**Migration `0071_bots.sql`**
- `users.is_bot BOOLEAN NOT NULL DEFAULT false`.
- `server_bots(id, server_id, user_id UNIQUE, persona ≤8000 bytes, speaking_style ≤1000, enabled,
  unprompted_per_hour 0–60 default 2, turns_per_hour 1–600 default 60, share_tables BOOLEAN default false,
  created_by, created_at, updated_at, deleted_at)`.
- `server_settings.feature_bots` (default off: maintainers opt in), `server_settings.bots_per_channel` (default 3,
  max 8).
- `channels.bot_invites_enabled` (default true); `channel_members.invited_by`.
- Extend the `server_ai_uses.use` CHECK with `text_bots`.
- Replace `assign_default_player_group()` so it skips `is_bot` users.

**Backend** (new `backend/src/bots/`)
- `bots/BotService.{h,cpp}`: `list`, `create` (user row with `password_hash='!'`, username `bot-<hex>`, server member
  with role `member`, `server_bots` row), `update`, `remove` (soft: sets `deleted_at`, leaves all channels, keeps the
  user row for old lines), `channelView`, `invite`, `removeFromChannel`. `api/BotRoutes.cpp`; wiring in
  `app/Services.{h,cpp}`.
- `auth/AuthService.cpp`: reject bots in `login`, `authenticate`, `authenticateFileToken`; extract `setAvatar`;
  reserve the `bot-` username prefix.
- `chat/ChannelSettings.cpp`: extract `joinChannel(...)` from `addChannelMember` (which now refuses bot targets);
  `bot_invites_enabled` in `updateChannel`; `is_bot` in `channelMembers`.
- Flags: `u.is_bot AS author_is_bot` in `MSG_SELECT` (`chat/ChatQueries.cpp`); `player_is_bot` in `listCharacters`;
  `is_bot` in server members and window members.
- Keep bots out of human paths: `searchUsers`, `addServerMember`, role changes, `discoverServers`/invite previews and
  admin counts, `AdminService::setAdmin`, `KnowledgeService::movePlayer`; `DeletionService::deleteServer` deletes the
  server's bot users. `createCharacter` with a bot owner requires the bot to be a channel member.
- `servers/ServerSettingsService.cpp`: `bots` in `FEATURES`; `ai/ProviderCatalog.cpp`: the `text_bots` use (tasks
  `bot_turn`, `bot_card`, `bot_memory`; default: inherit the server's text model).

**Routes**
- `GET/POST /api/servers/{s}/bots`, `PUT/DELETE /api/servers/{s}/bots/{b}` (maintainers).
- `GET /api/channels/{c}/bots` (any member): `{invites_enabled, can_invite, invitable[], present[]}`.
- `POST /api/channels/{c}/bots {bot_id}` (any member; checks feature, channel switch, same server, enabled, per-channel
  cap, per-user throttle; posts a system line "X invited bot Y"). `DELETE /api/channels/{c}/bots/{b}` (GM).
- WebSocket: `bots.changed {channel_id}`.

**Web:** new `BotTag.tsx` used in `MessageList.tsx`, `MessageNotifications.tsx`, `ChannelSidebar.tsx`,
`UserPicker.tsx`, `WindowMembersModal.tsx`, `GMWorkspace.tsx` (members + invite switch), `ServerSettingsModal.tsx`
(Members), `CharacterSpace.tsx`; new `ServerBots.tsx` settings tab (pattern: `DiceTexts`); an "Invite a bot" dialog
in `ChannelSidebar.tsx` for all members; about 25 strings × 10 languages in `i18n/catalog.json`.

**Mobile (2b):** `author_is_bot` in `Models.kt` / `Models.swift`; " · bot" in `MainActivity.kt` and `RootView.swift`;
one `mobile.tsv` row; fixture `mobile/contracts/fixtures/bots.json`; one test per platform; `INTEGRATION.md` section.

**Docs:** `docs/API.md`, `docs/BOTS.md`, `docs/AI_PROVIDERS.md`, `docs/ADMIN.md`.

## Stage 3: bots speak and play

**Migration `0072_bot_runtime.sql`**
- `bot_window_state(bot_id, chat_window_id, channel_id, cursor_seq, owed, owed_seq, owed_at, gm_seen, last_line_at,
  chain, last_turn_at, last_eval_at, lease_until, lease_token, failures, retry_after, last_error)`, primary key
  (bot, window). `owed` is one of `player | addressed | invited | mention | unprompted | adopt`.
- `bot_turns(id, bot_id, channel_id, chat_window_id, trigger, trigger_seq, mode table|self, status
  running|posted|passed|discarded|failed, action, message_ids, llm_calls, error, started_at, finished_at)`, unique on
  (bot, window, trigger, trigger_seq): a turn is taken at most once, even with two backend instances.
- `channels.bot_brief` (≤12000 bytes), `channels.bot_pacing_until`.

**Backend**
- `knowledge/Visibility`: `witnessFilter(userId)`: lines in windows the user is a member of, within their membership
  periods, with `window` visibility or whispered to one of their PCs. Never `gm_only`, other windows, other whispers.
- `inspiration/PlayerPrompt.{h,cpp}`: `cardSummary`, `renderLogLine`, `diceShape`, condition, companions, extracted
  from `InspirationService` (pure refactor; Inspiration keeps working through them).
- `bots/BotPacing.{h,cpp}` (pure state machine below), `bots/BotScheduler.{h,cpp}` (a loop every `BOT_TICK_MS`,
  default 2 s, plus a 2-thread pool; started next to the observer), `bots/BotTurn.{h,cpp}`.
- **A turn:** one `runStructured` call, no tools. Context: who it is (persona, speaking style), its PC's card and
  condition when it has one, companions in the window, the channel description and `bot_brief`, the last ~40
  witnessed lines, why it is asked. System prompt ported from `gm-agent/src/coplayer.mjs` (`coplayerSystem`).
  Output `{action: speak|roll|pass|make_character, kind: ic|ooc, messages[≤2], command, concept}`; validator allows
  only `.r .ra .rc .sc .move` (never `.st`, `.en`, hidden rolls). Posted with the bot's own access, so every
  ownership and visibility rule of a human player applies.
- **Mode:** `table` when the bot has a PC bound in a story window of a running story; otherwise `self` (speaks out of
  character as itself).
- `llm/MockLlmClient`: deterministic `bot_turn` branch for tests.
- 3b: dice through the normal dice path (the bot owns its sheet); a typing flag for the bot's PC while it composes
  (`ws/WsGateway`); `POST /api/channels/{c}/windows/{w}/bot-turns` (GM: "bots' turn" now); `PUT
  /api/channels/{c}/bot-brief` (GM: shared table notes for bots); the GM may recall a bot's line at any time;
  `GET /api/servers/{s}/bots/{b}/activity` (maintainers). Web: a "Bots' turn" button, a brief editor in the GM
  workspace, an activity list in the Bots tab.
- GM agent patch in 3a: exclude `is_bot` members from the planner window (`src/table/social.mjs`), so bot lines are
  never read as wishes.

**Pacing state machine** (one row per bot and window; rows start at the window's current end)

Reading new witnessed lines in order:

| Line | Table mode | Self mode |
|---|---|---|
| own, system, recalled | ignored | ignored |
| human player line | `chain = 0`; owes one turn (`player`), `gm_seen = false` | owes a turn (`mention`) if it names the bot or replies to it; otherwise only counts toward unprompted speech |
| GM line | if a turn is owed: `gm_seen = true`; else if it names or whispers to the PC and `chain < 2`: owes `addressed` | as a human line |
| another bot's line | only if it names me, nothing is owed and `chain < 2`: owes `addressed` | only if it names me and `chain < 1` |

A turn is ready when it is owed, nobody else is typing in the window (waits at most 45 s), the bot's hourly cap and
the server budget allow, and:
- `player`: the GM has answered and the window has been quiet 6 s, or 90 s have passed with no GM line ("the GM
  answers first", as today);
- the others: the window has been quiet 6 s.

Taking it: claim the row lease; insert the `bot_turns` row (a duplicate means another instance has it); bots owing in
the same window act one after another in one round, and their lines are posted together; if a newer human line
arrived meanwhile, the drafts are discarded and the debt kept; after posting `chain += 1`. A turn interrupted by a
crash is marked failed and never posted twice. Failures back off and drop after 3.

Why it cannot loop: `chain` resets only on a human player's line, so each bot speaks at most twice per human line
whatever the GM (human or agent) and other bots do. With no human player talking, bots act only when the GM calls
"bots' turn" or, alone in a window (a phone), at most 6 times an hour.

## Stage 4: role cards

- `bots/BotCards.{h,cpp}`: when a turn returns `make_character` and the bot has no PC in the channel, a background
  job runs task `bot_card` (rules summary + persona + concept + memory from stage 5) producing
  `{name, speaking_style, bio, role_card}`; it saves through `ChatService::createCharacter` and
  `CharacterSpaceService::updateCard` with the bot's own access: the same gate a human player passes. On a
  `points_rule` rejection the violations go back to the model, at most 3 rounds; on failure the blank character is
  deleted and the bot asks the GM, out of character, to make the card. One PC per bot per channel.
- **Adopting a GM-made card:** `createCharacter` / `transferCharacter` with a bot owner set `owed = adopt`; the bot
  acknowledges once and plays that character.
- 4a: CoC 7e + adoption. 4b: D&D 2024 (`dnd2024::check`) and PbtA (playbook from the channel's pack, sends `.move`
  like a human player).

## Stage 5: memory and unprompted speech

**Migration `0073_bot_memory.sql`:** `bot_memories(id, bot_id, kind table|table_private|person|note|briefing,
channel_id, subject_user_id, text, highlight, through_seq, source, updated_at)`; `channels.bot_chatter_enabled`
(default true).

- `bots/BotMemory.{h,cpp}`, task `bot_memory`: previous summary + new witnessed lines →
  `{summary, highlight (the most striking moment), people[{user_id, note}]}`, first person. Refreshed when a scenario
  closes (`SceneManager::setClosedHook` becomes a list of hooks), after 60 new witnessed lines and 10 quiet minutes,
  at story end, and when the bot leaves. `table` memory is built from window-visible lines only; whispers go to
  `table_private`.
- **What each mode reads:** at a table: that table's memory, its private part, the GM's briefing, notes on the people
  present; never another table's story. As itself: its notes and people, plus table memories according to the bot's
  `share_tables` switch (off: only tables every human in the window belongs to; on: all). `table_private` never
  leaves its table.
- Role-card creation reads persona and memory, so characters stay in keeping with who the bot is.
- **Unprompted speech (5b):** in self mode a bot may be asked "do you want to say something?" when at least 2 new
  human lines arrived, 5 minutes passed since its last such check, the window has been quiet 20 s, its
  `unprompted_per_hour` is not used up, and the channel's `bot_chatter_enabled` is on. Passing still costs a call; the
  5-minute gap bounds the cost.
- Routes: `GET/PUT/DELETE /api/servers/{s}/bots/{b}/memories[/{id}]` (maintainers; table rows only for channels they
  are in unless the bot shares freely), `GET/DELETE /api/channels/{c}/bots/{b}/memory` and `PUT …/briefing` (GM).
  Web: a memory editor in `ServerBots.tsx`.

## Stage 6: GM agent cleanup

- **6a, cooperate:** split `isHuman` in `src/table/context.mjs` so bots are players in the story but not "human
  presence" (away mode, sessions, final review, pause/resume, wishes). After a GM turn that lets co-players act, call
  `bot-turns` for the window and schedule the follow-up when the round finishes; this also sets
  `channels.bot_pacing_until`, so the platform leaves pacing to the agent while it runs. Push the public world
  (bible, public worldbook entries in play, date and routine, players' corrections) to `bot-brief`.
- **6b, switch off:** remove co-player turns, the attention review, rotation, impulses, intentions, co-player phone
  replies and card generation at setup. GM-owned PCs are voiced by the GM like NPCs until handed over; new CLI
  `bots handoff` invites a bot, transfers the character and posts the co-player's memory chapters as its briefing.
- **6c, delete:** `src/coplayer.mjs`, `table/coplayers.mjs`, `table/attention.mjs`, `intentions.mjs`,
  `table/intentions.mjs`, most of `context/coplayerContext.mjs` (keep `renderLine`, `speakerOf`), co-player parts of
  `roles/cardgen.mjs`, `roles/complete.mjs`, `pbta.mjs`, `memory.mjs`, `planner.mjs`, `config.mjs`, `cli.mjs`,
  `host-schema.mjs`, `host-status.mjs`, `llm/routes.mjs`, `llm/mock.mjs`; the web UI's Intentions tab and co-player
  views; README and example config; tests (`attention`, `coplayer-scenes`, `coplayerContext` deleted; `loop.test.mjs`
  rewritten; prompt fixtures regenerated, the one step where they change on purpose).

## Stage 7: private chats with a bot

- **Migration `0074_bot_chats.sql`:** `channels.kind campaign|bot_chat`, `chat_user_id`, `chat_bot_id`, unique per
  (user, bot); window purpose `chat`.
- A private chat is a hidden channel with every AI switch off, the player and the bot as members and one window. It
  reuses messages, history and the WebSocket unchanged. It is excluded from channel lists, spectating and admin
  listings (so mobile and old clients never see it); invitations and window changes are refused there. Every human
  line counts as addressing the bot; a per-user cap of 30 bot turns an hour.
- Routes: `POST /api/servers/{s}/bots/{b}/chat` (find or create), `GET /api/servers/{s}/bot-chats`,
  `DELETE /api/channels/{c}` by its user. Web: "Chat with a bot" in `ServerSidebar.tsx`, a slim `BotChat.tsx` around
  `ChatWindow`.

## Verification

Every step: the full relevant suites below, then the pull request's CI (`ci.yml`: backend unit/database tests,
`tests/integration` against a live server with the mock model, gm-agent, frontend, browser tests; `mobile.yml` when
mobile changes).

- **1a:** `cd gm-agent && npm test`; `git diff --exit-code gm-agent/test/fixtures/prompts.*.json`; no hits for
  `git grep -n -i -E "dailyOn|isPassive|spark|gentle|standin|handledMessages|parseClock|needs_reply_from|whistle|unattended|question_done|away_rule|planner_daily|day_summ" -- gm-agent`;
  `tests/browser/gm-host.mjs` with Chromium.
- **1b:** no hits for `git grep -n -i -E "stand_in|standIn|stand-in|passive_since|setCharacterPresence"` outside
  migrations 0065/0070; `cd frontend && npx tsc --noEmit && npm test && npm run build`; `scripts/test.sh <pg-url>` if
  step 0 worked.
- **2–5, 7 (new tests):**
  - `backend/tests/unit/unit_tests.cpp`: the pacing table ("a player line owes one turn, taken after the GM answers",
    "no GM line: taken after the timeout", "GM and bot ping-pong stops at the cap", "another bot's line owes nothing
    unless it names me", "validator refuses .st and hidden rolls").
  - `backend/tests/integration/db_tests.cpp`: "a bot never joins a player group and an invite keeps the group's
    version", "a bot cannot log in", "witness filter: window lines and own whispers only", "two schedulers take one
    debt once", "an interrupted turn is not posted again", "a bot's card passes the same point-buy check as a
    player's", "table memory never contains whispers", "sharing off: a table's story stays with its players",
    "a bot chat is never listed or spectated".
  - `tests/integration/`: `bots.test.mjs`, `bots-table.test.mjs` (player line → GM line → the bot speaks as its PC;
    bots alone never talk; caps), `bot-cards.test.mjs` (three rule systems), `bot-memory.test.mjs`,
    `bot-chat.test.mjs`; `frontend/tests/bots.test.cjs`.
  - In the browser (Chromium, mock model): create a bot, invite it as a player, see the tag, ask it to make its
    character, play a line, read its memory in the settings page.
- **6:** `cd gm-agent && npm test`; new `tests/integration/gm-agent-bots.test.mjs` (the agent paces platform bots);
  the regenerated prompt fixtures are reviewed by hand.

## Risks to keep in view

1. **Cost.** Every bot opportunity is a model call, a "pass" included. Bounds: at most 2 turns per bot per human
   line, per-bot hourly caps, bots per channel, the server token budget. Until 6a a GM agent also answers each bot
   line with a GM turn.
2. **Backend build in this sandbox** is unproven until step 0; if it fails, each backend round trip is a CI run.
3. **Mobile** changes are checked only by CI.
4. **Parity with today's co-players.** Platform bots do not read the GM agent's private structures (bonds, timelines,
   planner impulses). The table brief carries the public world, date, routine and corrections instead; intentions
   end (a standing aim can go into the bot's persona or the GM's briefing).
5. **Stage 1b is not reversible** without re-adding two columns; old stand-in lines lose their mark.
6. **Size.** 13 pull requests; the order keeps each one shippable and the table playable throughout.

## Progress

- 1a (GM agent: daily life removed): merged (#68).
- 1b (platform, web and apps: stand-in and passive marks removed, migration 0070): merged (#69).
- 2 (bot accounts, settings, the "bot" tag on web and apps, invitations; migration 0071; 2a and 2b together): merged (#70).
- 3 (bots speak: pacing, turns, the runtime, GM recall of bot lines, the GM's call, notes for bots, typing, activity; migration 0072; 3a and 3b together): merged (#71).
- 4 (role cards: bots make their own Call of Cthulhu, D&D 2024 and PbtA characters when asked, and take up characters the GM makes; 4a and 4b together): merged (#72).
- 5 (memory: accounts of each table with the most striking moment, private whispers, notes on people, sharing switch, editor, GM briefing and forgetting; joining in on their own; migration 0073; 5a and 5b together): merged (#73).
- 6a (the GM agent paces the platform's bots: bot lines are players' lines, not people; it calls them after answering a person; notes for bots from the public world; `bots handoff`): merged (#74).
- 7 (private chats with a bot: hidden one-to-one channels, every line answered, a shared hourly allowance, memory kept to the chat; migration 0074): in review.
- 6b+6c (the GM agent's co-players retired): in progress.
