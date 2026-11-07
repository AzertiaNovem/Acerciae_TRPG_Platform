# gm-agent — an AI GM for Acerciae

A Node.js client that sits at an Acerciae table as the **GM** (Game master), in every rule system. It talks to the
platform only through the public HTTP and WebSocket API (`docs/API.md`), the same contract the web and mobile apps
use. It plays three kinds of role:

| Role | On the platform | Who writes it | What its model is given |
|---|---|---|---|
| **GM** | the client's account, channel role `gm` | – | everything the GM may read (below) |
| **Real NPC** | an `npc` character | the GM model, when the story introduces one (or the GM by hand) | **the same context as the GM** |
| **Story planner** | nothing on the platform | – | the GM's whole context plus the previous plan, in the background, with its own model |
| **Co-player** | a GM-cast PC: a `pc` character owned by the client's account | **the LLM writes its CoC, D&D or PbtA role card** at setup (or the GM made it by hand) | **only the chat log its character witnessed**, plus its own card and persona and its companions' basic details and backgrounds |

Co-players are AI investigators who play *alongside* the human players. You choose how many (`--coplayers N`). On the
platform they are PCs cast by the GM: player characters owned by the client's own (GM) account, so players see them
in the character list and can read (not edit) their sheets, and Log Studio files their lines as investigators' lines.
Every PC the GM account owns is a co-player: `setup` adopts the ones already in the channel (made by hand in the web
app, say) and generates only the missing ones. Inside this client co-players are separate from the real NPCs: they get
different context, and the GM model is never allowed to speak for them.

The platform's own AI never speaks in chat. It writes tips for the GM: the pinned board, reminder bubbles, script
knowledge, documents, highlights and module hints. This client reads those tips for the GM and the real NPCs. Co-players
never get them.

## Hosting several channels in one process

`npm run host -- --config gm-host.yml` runs one Node.js process with an isolated worker thread per channel. Each worker owns its table, rule profile, API session, WebSockets, timers, SQLite database and state lock. CoC, D&D and PbtA channels can run together. Existing `setup`, `run` and manual commands still work; do not run two hosts for the same channel.

Copy `gm-host.example.yml` to `gm-host.yml`, create `channels/`, and copy the files from `examples/channels/` there. Replace the channel IDs with existing platform channels where the shared account is GM. Paths are relative to the configuration file that contains them. The channel's rule system comes from the platform; change it in the GM workspace and restart that channel.

The shared file contains the platform address, account, state directory, LLM provider/endpoint/key, optional planner connection and channel list. Keep it private (`chmod 600 gm-host.yml`). Passwords and keys can instead come from `.env` (`GM_PASSWORD`, `LLM_API_KEY`/`ANTHROPIC_API_KEY`, `PLANNER_API_KEY`). The shared file takes precedence. Never commit real credentials. Channel files cannot override credentials, provider or endpoint; they can select a model, effort, token budgets, language, co-player count, calendar pacing, autonomy, scene strategies and modes using the existing configuration keys. Each channel has its own daily token budget; there is no combined provider spending cap.

At startup the host prepares each enabled channel independently, adopts existing co-players, creates any missing requested co-players and applies explicit world/casual settings. PbtA waits for its rule review without delaying other channels. A failed worker stays failed until explicitly started or restarted; it does not terminate its peers or repeatedly retry a broken configuration. `enabled: false` prevents automatic startup but still lists the channel in the UI. A second host using the same state directory is refused. For an established CoC/D&D table being migrated, set `prepare_on_start: false` on its shared channel entry to attach without generating or completing cards or reapplying setup modes; existing state remains authoritative. PbtA still performs its required review checks.

Set `webui.enabled: true` in the shared file and supply a random `webui.token` of at least 24 characters (for example `openssl rand -hex 24`). The UI defaults to `http://127.0.0.1:8787`. Enter the token in its login field; it stays in page memory and is never put into the URL. The UI lists the channels with their state, name, rule system, today's token use and any failure, and starts/stops/restarts each one. A selected channel has four tabs:

- **Overview** — the live table, read from its worker every few seconds: how long it has run and how often it started, the last error (why a start failed, or how the worker exited), the WebSocket streams, the GM role and knowledge mode, activity (turns, queued turns, the last player line, paused or away), today's and the week's model use against the daily budget with a breakdown by purpose, player characters, co-players and their windows, NPCs, timelines with their windows and members, the story planner (plan version, beat, planner window notes, the session in progress), calendar, casual and improvisation modes, and relationships. A stopped channel shows its last snapshot, marked as such.
- **Settings** — every channel key as a form, grouped and searchable, each with its help, the value in effect and its default. Only the keys you change are written; the file keeps its comments and other keys. "Default" removes a key. Values are checked against their ranges before anything is saved.
- **YAML** — the file itself, with a validate button that checks it without saving.
- **Logs** — the worker's last 600 log lines, filterable, with errors highlighted. Known passwords, keys and the UI token, and anything shaped like a credential (bearer tokens, JWTs, `sk-` keys, `token=` parameters), are masked before a line is kept.

A save validates the configuration, rejects stale edits from another browser, writes atomically and restarts only that channel if it was active.

**New hosting tasks.** "＋ 新建主持任务" adds a channel to the running host, without a restart. Either pick a channel the shared account is already GM of (listed from the platform; channels this host keeps are marked), or create one on the platform the way `setup --create` does: on an existing server or a new one (which also returns an invite code for the players), with its name, rule system and era; casual mode makes it an isolated channel so phones stay private. The form takes the first settings (language, co-players, D&D level, casual mode, scene forks, autonomy, planner) and whether the channel starts with the host, is prepared on start, and starts now. The host writes `channels/<channel id>.yml` next to the other channel files and adds the entry to the shared file's `channels:` list, in place: comments and credentials stay, and the file is written atomically with mode 600. Each channel's Settings tab also switches auto-start and prepare-on-start (written to the shared file, used at the next start) and removes the task: the channel stops and leaves the list, while its channel file, state and the platform channel stay, so it can be attached again (a new file is written; the old one is never overwritten). A host can start with an empty `channels: []` and get every channel from the UI. Stopped channels stay stopped. Unsaved edits are not replaced by status refreshes. Shared credentials are never returned to the browser. To change shared connections or the UI listener, edit the shared file and restart the host; the channel list can also be changed from the UI. Changes made directly to channel files take effect on the next channel restart.

The UI grants administrative control of the configured channels, including world-file paths; give the token only to trusted operators. Keep the default loopback listener or place a deliberately exposed listener behind an HTTPS reverse proxy. The server checks bearer authentication and rejects cross-origin API requests: a browser's `Origin` must be the address the UI was opened at. Behind a reverse proxy or tunnel that rewrites the `Host` header (nginx does by default), every save fails with "Origin not allowed" until the proxy forwards the original host (nginx: `proxy_set_header Host $http_host;`, which keeps a non-default port such as `:15505`; or `X-Forwarded-Host`) or the public address, port included, is listed under `webui.allowed_origins` (for example `https://gm.example.com:15505`). The shared file is read when the host starts: restart it after changing `allowed_origins`.

On shutdown or configuration restart, workers stop accepting events, cancel generation and drain active work before releasing their locks. A worker that cannot stop within 15 seconds is terminated and its owned lock is released after thread exit. Configuration restarts preserve the session and do not run an end-of-session story review; the existing standalone `run` signal behavior still runs that review. In-flight network calls at forced termination may already have reached the platform, so inspect the last posted lines before resuming a timed-out channel.

## Hosting a PbtA table

For a channel already created in the web or desktop app, select PbtA in GM workspace → Settings and give the agent account the GM role. With the account and LLM configured, start the host from `gm-agent`:

```sh
node src/cli.mjs run --channel <CHANNEL_ID> --world world.md --coplayers 2
```

The host waits for you in GM workspace → Settings → Rule pack before creating characters or posting the opening. Activate the draft or keep the current rules to continue in the same process. If you stop it during review, restart with the channel ID and the same state directory. The public world, requested number of co-players and draft are recovered. Omitting the world on a fresh channel uses its current pack directly. The agent reads the channel’s selected system. To change systems, use the workspace.

To have the CLI create the channel instead:

```sh
node src/cli.mjs setup --create --rules pbta --world world.md --coplayers 2
# Review the draft in GM workspace → Settings → Rule pack, then repeat the same setup.
node src/cli.mjs setup --create --rules pbta --world world.md --coplayers 2
node src/cli.mjs run --channel <CHANNEL_ID>
```

The first setup prints the channel ID and exits before creating the cast. Edit the proposed moves, save a draft to return later, then choose **Activate draft** or **Keep current rules**. Retry design in the workspace and rerun setup if the local agent was interrupted. Use the same state directory when repeating `--create`. With the channel ID you can always resume using `setup --channel <CHANNEL_ID>`. An attached PbtA table with play history or a custom pack uses its existing rules. Without a public world, a new PbtA table starts with the platform starter. Only the public world file is sent to the rules designer.

PbtA designs and role cards get up to three validation-repair rounds. Validation names the exact JSON fields and expected types/IDs; the model returns replacements only for those fields, which are merged into the last parsed draft and validated again. Valid names, biographies, playbooks and unrelated moves stay unchanged. Independent errors in several moves, or in both resource and condition maps, can be repaired together. A reply that edits other fields is rejected. If the reply is not parseable JSON at all, a full JSON correction is still needed. The platform preview remains authoritative, and rules still require GM review before activation.

Structured JSON model calls automatically retry interrupted streams, transient connection errors, idle timeouts and selected temporary HTTP failures at most twice, waiting 2 then 4 seconds. This retry budget is shared across the initial response and all its repairs; it does not restart for each field. Each inference attempt has its own usage record under the original request ID, including failures with unknown usage. A disconnected stream is never accepted as a completed answer. Cancellation interrupts backoff; authentication failures, refusals, output truncation and platform validation/access/conflict errors do not trigger transport retries. These retries repeat model inference only, never character creation, chat messages or other platform writes. Exhausted recovery leaves the existing visible failure/review flow in place.

**Playbooks for everyone.** Every character takes a different playbook. The designer is told the table's size: the requested co-players and the human players who are channel members so far. It designs at least two playbooks more than the co-players, and at least one for each of those characters plus a spare. A draft with no playbook left over for a human player is sent back for repair. Each co-player is offered only playbooks nobody holds yet, so the spares stay free for the human players. Top-level fields the platform does not take are left out of a draft before it is checked.

**Co-player cards.** A card that names a playbook, stat, resource or condition by its name instead of its ID, gives a number as text ("+1"), or lists the marked conditions is fitted to the pack; entries the pack does not define are left out. When a co-player's card still cannot be built after its repair rounds and one fresh try, setup goes on without it and logs why; the next start tries that co-player again. One bad card no longer stops the host.

The GM can invoke a triggered move for the speaking player, with a reference to their declaration. The platform rolls or returns the diceless instructions. For a player choice the GM asks in the same window and waits for their answer. Required choices may be marked for each outcome in the rule editor. When the cost is known the GM records the old and new resource or condition values on the card and cites the ruling in chat. Conflicting edits require manual reconciliation. Keep private sessions in their own window. Co-players see their own playbook and witnessed chat. GM reference moves stay in the GM context.

## What each role sees

**GM and real NPCs** (one shared context, built per turn by `src/context/gmContext.mjs`):

- every line in every chat window, including GM-only notes, whispers and hidden rolls (older history as compacted
  chapters; see "Long campaigns");
- the cast: every player character and co-player with its basic details (occupation, age, gender, residence,
  birthplace), its most distinctive traits, bio and background from its role card, and each real NPC with its gender,
  age, distinctive traits and brief (see "Time and people");
- in a casual game, the story's calendar and everyday routine; in every game, the relationships between characters;
- the current scenario and the summaries of earlier ones;
- the platform's AI tips:
  - `GET /kp/board`
  - `/reminders` and `/script-knowledge`
  - `/documents/{id}`
  - `/highlights` and `/modules/hints`
  - live `reminder.created` and `highlight.created` pushes on `/ws/context`.

**Each co-player** (`src/context/coplayerContext.mjs`). The client signs in as the GM, who can read every line, so
it applies the platform's player filter itself. A co-player gets only:

- lines in the windows it sits in (the Main Chat by default);
- lines with `window` visibility, and whispers addressed to its own character.

It never gets `gm_only` lines (GM notes, hidden roll results), whispers to anyone else, other windows, or any
platform AI tip.

Besides the log, its prompt holds:
- its own memories: chapters it wrote, in the first person, from lines it witnessed (see "Long campaigns");
- at most one private impulse from the story planner: an in-character urge, never the plan or a secret (see "The
  story planner");
- its own role card and persona;
- the other investigators' basic details, distinctive traits, bio and background (`src/context/profiles.mjs`): the
  player characters and the other co-players, as a human player can read any player character's page;
- in a casual game, the story's date, the everyday routine, and how much time passed since it last spoke;
- the real NPCs it has seen speak in its own scenes, with what anyone would notice about them (gender, age,
  distinctive traits);
- the relationships it is part of, and the public ones between people it knows;
- the players' corrections about it or about no one in particular, from the planner window (never their wishes);
- in casual mode, the texts it sent or received, including those in the phone log.

It never gets a real NPC's brief, an NPC it has not met, a secret relationship it is not part of, or anyone's
characteristic and skill numbers.

## Long campaigns: memory, compaction and caching

The client keeps its own data store: one SQLite file per channel, `STATE_DIR/<channel>.db`, built into Node (no extra
package). It holds:
- a local copy of the chat as the GM reads it, fetched once, with any gap filled after the table was down;
- compacted chapters;
- the token usage of every model call.

The JSON state file stays the source of truth for the table itself.

**Long context, compacted.** The models read as much of the campaign as fits a token budget, not a fixed number of
lines.
- **The GM and real NPCs** (`context.gm_tokens`, default 60,000) read:
  - every window's chapters, which hold the story so far;
  - this window's lines since its last chapter, word for word;
  - the newest lines of the other windows.

  When a window's lines pass about 60% of the budget, the oldest half becomes a chapter, written by the model. It
  keeps names, clues, promises, decisions, injuries, where each investigator ended up, and the line numbers of key
  moments. When a window's chapters pass about 25% of the budget, the oldest half merge into one. A scene that ends
  (a thread merged) becomes a chapter whole.
- **Each co-player** (`context.coplayer_tokens`, default 24,000) has its own memory in the same way. Its chapters are
  written in the first person, only from the lines it witnessed. They never include GM notes, others' whispers or
  another timeline's lines, and no one else reads them.
- **GM documents** keep their newest entries when they are too long; a note says how many older ones were left
  out. Their full versions stay in the local document cache, so older entries can still be found without fetching
  the document again. A version change or platform update invalidates the cache; failed fetches are retried.

**Relevant earlier evidence.** Before a turn, the client searches locally for Chinese/English terms from the recent
conversation in older chat lines and omitted GM document entries. It adds a few source-labelled excerpts after
the cached context. This can recover names, clues and promises lost from a summary, without an extra model or
embedding call. Earlier excerpts are explicitly historical; current state and recent corrections take precedence.
Co-players search only the lines they witnessed, after the existing window, timeline and whisper filters. They
never search GM documents or another character's private history.

`context.recall_tokens` defaults to 1,200 approximate tokens per turn, additionally capped at 5% of that role's
context budget (maximum setting 4,000; `0` disables it). That allowance is reserved from the raw-history limit.
Only matching excerpts are sent; no extra tokens are used for an empty search. The recall section itself obeys this
ceiling, including its labels. It does not increase the configured context or output limits. This is lexical recall,
not semantic search: it can miss paraphrases and can only use history already synced into the local store.

Compaction runs beside the turns, so a turn never waits for it.

**Prompt caching.** Every prompt is laid out stable-first, and providers cache the prefix:
1. The fixed rules.
2. Parts that change rarely: campaign, world setting, cast, scenarios, chapters.
3. This window's older lines, in separate frozen blocks of 50. Appending a block leaves earlier blocks byte-identical.
4. Parts that change every few turns: hidden truths, timelines, GM board and documents.
5. This turn's details: relevant earlier excerpts, the scenario's event count, reminders, tips, the newest lines, the instruction. These come last
   and are never cached.

Providers:
- **Anthropic** gets cache markers with a one-hour lifetime by default (`llm.cache_ttl: 1h|5m|off`). The GM's more
  frequently changing platform/context block uses five minutes; later markers also stay at five minutes, as required
  for mixed TTLs. `5m` shortens all blocks; `off` disables all explicit markers. The four-marker limit is preserved.
  See [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  for block-boundary lookback, mixed TTLs and write pricing.
- **OpenAI's own API** gets a `prompt_cache_key` per purpose. Other compatible gateways rely on the stable order alone.

A co-player's changing HP, sanity and inventory come after its cached identity, memories and history. They remain
visible every turn without invalidating that prefix. The GM, co-players and planner have different system prompts:
cache reuse is primarily between successive calls for the same role, not automatically across those roles. Actual
hits and prices depend on the provider/model and gateway; the local `status` totals are a token-weighted budget
heuristic, not a currency invoice. Compare its cache-read share before increasing the main context budgets.

**Usage.** Every completed or failed client model call appends a row to the channel's local SQLite file
(`STATE_DIR/<channel-id>.db`), including `setup` character generation/completion, point buying, GM/NPC turns,
co-player turns/phones, memory summaries, and planning. Each row includes its timestamp, call/request IDs, type,
phase, attempt, provider/model, duration, status, input/output tokens, and cache reads/writes. Terminal logs print
these counters as calls finish. Token records contain no prompts, replies, credentials or provider error bodies.

Planner draft, critique and revision (including final session reviews) are separate phases; GM turn modes are also
separate. JSON repair gets its own row/attempt with the original request ID. A refusal or truncated response still
counts any usage the provider returned. Missing/incomplete usage is marked unknown, never claimed to cost zero;
mock token counts are labelled estimates. SDK-internal transport retries are not separate client calls, and their
usage cannot be reconstructed when the provider doesn't return it. A completed call means a model response arrived,
not that subsequent JSON validation or platform posting succeeded. Cache reads/writes are subsets of input: total
is input + output, not input + cache + output. These counters are not a currency invoice.

From the `gm-agent` directory:

```sh
npm run usage                         # last 7 days: summary and latest 50 calls
npm run usage -- --purpose planner     # filter one call type, split by phase/model
npm run usage -- --days all --limit 100
npm run usage -- --days all --before-id 123 --limit 100  # older details
npm run usage -- --days all --json > usage.json
```

`usage` reads local records without logging in or calling a model; select the channel with the usual config or
`--channel`. `--days` is a rolling time range; `all` includes every saved row. The summary covers the selected range
and type; `--limit`/`--before-id` page only the details. JSON includes `nextBeforeId` for continuing an export.
`status` also shows today's classification, plus today/week totals and cache-read share. Existing databases upgrade
in place and retain earlier counters; historical records cannot acquire missing phase, duration or failure metadata.

`context.daily_token_budget` caps billable-equivalent tokens a day (cache reads count a tenth); once it is spent,
the table stops starting autonomous turns, while answers to players still run. Unknown provider usage cannot be
included in that heuristic budget.

**The living world.** The platform keeps the world record itself: its observer tracks what is true about each person,
place, group and item now (active, missing, dead, destroyed; a short state; where it is), with a history of changes.
The client works with it in three ways:
- **Reading it.** The GM and real NPCs get it as "The world now" in their context.
- **Declaring changes.** When the world moves on where play does not show it (off-screen, between visits, while the
  investigators are elsewhere), the GM records the change with a `world_change` action. A secret declaration stays
  GM-only. Declarations never appear in chat.
- **Improvisation mode.** The world setting and the GM's secrets are handed to the record once per version of the
  text, so the observer knows the places, groups and people from the start. Hidden truths the GM decides are declared
  as secrets too, so a human GM sees them in the web app.

Co-players never read the record. They know only what their characters witnessed and the public world setting. A
platform without the record (404) is noted once, and the table carries on with its own notes.

The GM and planner favour a small recurring NPC cast and relationships that develop over multiple scenes and
sessions. They consult existing people and bonds before introducing someone new, follow through on promises and
shared experiences, and let peripheral NPCs stay off-screen. The planner's critique/revision explicitly checks for
unnecessary newcomers and neglected relationships. Newer plots grow out of the people already in the story: a
familiar NPC gets the new problem, request, secret or job before someone is invented for it. Reuse must respect
whereabouts, identities and the module. Neither role decides player/co-player feelings or treats proposed
relationships as already established.

When the story does need someone new, the GM makes them a real NPC, a character on the platform with a role card
and lines of their own, if they pass all three tests: they **could build a lasting bond** with the player characters
or co-players; they **have more than one sentence to say**; and they are **one specific person**, not a voice
standing for a crowd ("someone in the crowd shouts", "the guards mutter"). A real NPC's words are never put inside
narration or summed up there. Anyone who fails a test (a single remark, a passer-by, a clerk the story will not
return to) stays unnamed in narration; someone first met there who turns out to matter is made a real NPC then.
`npc` only voices an existing cast member: an unknown name is not posted (a misspelling must not create a
character), and a GM-only note tells the next round to use `new_npc` if the person passes the tests. `new_npc`
creates the character, or reuses the existing one when that name is already in the cast.

## How a turn runs

1. A real person posts a line in a window. After `pacing.debounce_ms` of quiet, one turn starts.
2. **The GM's move** (`src/director.mjs`). One model call with the GM context returns the GM's actions:

   | Action | What happens |
   |---|---|
   | `narrate` | posts narration |
   | `npc` | a line from a real NPC |
   | `world_change` | a change to the world the chat does not show, recorded by the platform's world record (`secret` keeps it GM-only) |
   | `truth` | improvisation mode: a hidden fact the GM just decided, kept for later turns and declared as a secret |
   | `text` | casual mode: a real NPC texts a player character's phone |
   | `planner_note` | a word for the story planner: what the players did that changed the plan, or that the beat is done |
   | `date` | casual mode: moves the story's calendar on (`advance_days`, the time of day) or to a later YYYY-MM-DD date; never backwards, and the date only at the GM's pace (`calendar.*`) |
   | `bond` | records, changes or ends a relationship between two characters (`secret`: the investigators do not know it) |
   | `new_npc` | creates the NPC: the model writes its role card, then it speaks |
   | `whisper` | posts a whisper to one character |
   | `request_roll` | asks a player to roll (`.ra Spot Hidden`; in D&D `.rc Stealth dc 15`); for the client's own characters, the platform rolls against their sheet |
   | `dice` | D&D only: a dice command run as the GM account itself: `.ri +2 Goblin` (a monster's initiative), `.init next`, `.init del <name>`, `.init clr`, `.r 1d8+3` |
   | `note` | posts a GM-only line |
   | `timeline` | records a thread's narrative time, place, span and the GM's private notes |
   | `advance_scenario`, `enter_scenario` | opens the next scenario, or enters a prepared one (see below) |

   The same call says whether co-players may act now, and reports **whereabouts**: who is now where (see
   [Timelines](#timelines-proactive-splitting)). A line the GM model writes for a co-player or a player is dropped.
3. **Co-players' moves** (`src/coplayer.mjs`). Each co-player seated in the window gets its own model call with its
   own context. It speaks (in character or out of character), rolls (`.ra`, `.rc`, `.r` or `.sc`; in D&D `.rc`, `.ri`,
   `.ds`, `.ss` or `.r`, rolled by the platform's dice against its own sheet), or passes.
4. **The GM answers the co-players at once.** If any co-player acted, a follow-up GM round runs in the same turn,
   so a co-player's choice gets its consequence now, not at the next human line. The GM prompt says every player,
   co-players included, needs an immediate response that propels the story.
5. At most `pacing.max_actions_per_turn` lines are posted per turn. Lines the client posted never start a turn by themselves.

The client never decides memory proposals; those stay with the human GM in the web app.

## Recalled lines

On the platform the author of a line may recall it for two minutes after sending it (not a roll, a system line or a
PbtA move's record). The line becomes a tombstone everywhere, and the client takes it out of every context: no
prompt of the GM, an NPC or a co-player quotes it again. What happens to the table's answer depends on how recent it
still is:

- **Ten or more lines since** in its window: only the line goes. What the table said and did after it stays.
- **Fewer than ten lines since**: the table rolls back as if the line had never been sent (`src/rollback.mjs`).
  - Every turn that answered it, or that ran after it in that window, is undone, together with the turns those
    started (a follow-up, the opening of a scene a move created). A turn still running is stopped; one not started
    yet is cancelled.
  - The client recalls every line those turns posted, in any window, and its own later lines in that window:
    narration, NPC and co-player lines, whispers, notes, and the copy of a recalled text in another player's phone.
  - It restores what they changed in its own state: where everyone is (timelines, co-player seats, the move guard,
    and window access with scene forks), the date, relationships, hidden truths, and phone texts still on their way.
    A part that a later, unrelated turn changed again is left as it is.
  - What the platform already holds stays: a roll's result, a scenario change, a world change, a new NPC (who stays
    in the cast). A GM-only note in the window says what was taken back and what stays.
  - Other players' lines after the recalled one stay, and the GM answers them again in a new turn.
- A line recalled before its turn started is simply not answered; one sent right after it is answered once.
- A wish or correction recalled in the planner window leaves the planner's inbox.

Each turn keeps a checkpoint for this in memory for five minutes, so a restart forgets them. Lines the GM account
recalls itself never start a rollback.

## Timelines and autonomy

The table does not always wait for a human, and it does not keep everyone in one room.

### Timelines: proactive splitting

The client keeps **timelines** (threads of the story) in its state file; the platform has none. Every player
character and co-player is in exactly one. The main timeline (handle `T0`) always exists and starts in the Main Chat;
every other thread has a window of its own, a persistent handle (`T1`, `T2`, … never reused), a place, a narrative
time and a **span**: *short* when the party is briefly apart (two rooms of one house), *long* when it is far apart (two
cities).

Each GM round may report **whereabouts**: who is now where, and whether a group is out of reach of the others and
can explore on its own. The client decides what that means (`src/whereabouts.mjs`, a pure, tested planner), in one of
two ways, chosen with `timelines.scene_forks` (`--scene-forks`):

**Main Chat stays the story (`scene_forks: false`, the default; best for a single player).** The main timeline is
always played in the Main Chat, with the players; only those who go elsewhere get a window. A single player is always
in the Main Chat, and the co-players move around them.

- **A player goes elsewhere** → a new window `Scene: <place>` with that player (and any co-players who went too) and
  the GM. Everyone stays a member of the Main Chat. The player is whispered a pointer to the new window, the opening
  is posted there, and an **arrival** turn opens the scene at once.
- **Co-players go elsewhere** → a `Side: <place>` window only they sit in, which moves on by itself (side turns).
- **Everyone in a scene goes to one place** → the thread just moves there; no new window.
- **A lone player leaves the co-players behind** → the Main Chat goes with the player (it is relocated); the co-players
  who stayed get a side window.
- **They meet again** → reunions always land in the main timeline, in the Main Chat, where every player already is.
  The old window gets a pointer `→ "Main Chat"` and is closed for autonomy; the reunion gets its own arrival turn.
- **No history leaks.** Nobody is ever added to an existing window (its whole past would open to them). A player
  joining a thread whose window they are not in regroups the thread into a fresh window; when a player leaves a
  thread others stay in, those who stay continue in a fresh window. A window is reused only for exactly the same
  people at the same place; a window the platform failed to open three times is given up (the people stay).
- Going where you already are is no move; going to another thread's place joins that thread.

**Scene forks (`scene_forks: true`; for several players who must not read each other's scenes).** The main timeline
moves to its own restricted window on the first split, and the Main Chat becomes a public lobby the GM never
narrates in.

- A split creates restricted forks for both the departing party and any party still playing in Main Chat. The
  fork shows source history only up to its creation boundary, with the original reader permissions. All audiences
  are prepared before the next narration. Main Chat then carries public conversation, not either private scene.
- When a real player leaves an existing scene, their new-message visibility there is paused. Those staying keep
  their window. Returning resumes access; messages during the absence remain hidden. A new arrival gains only
  future messages. Co-players continue to use their internal seat intervals instead of platform user memberships.
- A later arrival joins the earlier party's existing window. If multiple parties instead converge on a new scene
  simultaneously, the fork inherits from the source with the most distinct human players; co-players do not count.
  Players still cannot read the other party's previously private history.
- Everyone already together travelling to one destination can relocate in the same window. New scenes may be forked
  explicitly. Windows whose stories have ended are archived and remain readable in the sidebar's archive section.
- Going where you already are is no move; going to another thread's place joins that thread.

The rules that keep this safe:

- **Only a player moves their character.** A player character moves only when its own player said so, in this turn's
  lines in that window (not an old line, not an out-of-character one, not another player's or a co-player's
  suggestion). Before applying a proposed split, the agent independently reads each character's own decisions
  in that scene. A later change of mind takes precedence. A companion can follow a player on the strength of
  an earlier commitment even if someone else spoke last.
- A player can correct a misplaced companion in the scene chat or the planner window. Once the correction
  identifies the character and thread, the agent updates the actual seat before answering and bypasses the
  ordinary move cooldown. Players can also correct their own character.
- **Already together is not a new movement request.** Before and after a normal GM round, an independent
  presence reader compares up to forty recent public play lines per occupied thread. It recognises established
  arrivals from character actions and published narration, including contextual room names and stale window
  labels. If two investigators have separately arrived in room 507, their actual timeline and co-player seats
  reunite without requiring another declaration or waiting out a move cooldown. Each reconciliation cites a
  confirming line from both scenes in the agent log. Newer messages invalidate an in-flight result. The next
  response uses the corrected cast; it does not narrate the arrival a second time.
  Intentions, washroom errands still in progress, different rooms in the same building and incompatible story
  times are distinguished from current co-presence. The reader sees no whispers, GM-only notes or planner
  secrets, and copies none of another thread's history into the reunion window. Window membership intervals and
  player-group access still apply. These checks use the configured LLM; the offline provider reports
  no inferred reunion unless a test supplies a fixture. Shared journeys through intermediate corridors or lobbies
  are narrated together instead of opened as separate adventures at each waypoint.
- **No flip-flopping.** A co-player's move that would undo a recent change needs two agreeing turns after it
  (`timelines.guard_turns`, `timelines.guard_ms`). Players' own moves and reconciliation of established presence
  are never deferred.
- **No history leaks** (scene forks). The server enforces membership intervals for reads, search, references, exports and live
  delivery. Pause/resume never fills the absence with old messages. Same-group players still share the union of
  their readable perspectives. Fork ancestry does not widen any reader's original permissions.
- **Bounded.** At most `timelines.max_active` threads at once; a new window for a player at most once per
  `timelines.pc_cooldown_ms`; at most `timelines.max_arrivals_per_hour` arrival turns; arrivals never start further
  splits.
- **Relay.** A split-off player who keeps writing in the Main Chat is answered in their own scene; the Main Chat only
  gets a whisper pointer. A roll asked of an away player is asked in their window.
- **Crash-safe.** A split in progress is journaled; `run` finishes it on restart before any narration, and a thread
  whose first scene never played gets its arrival turn. With scene forks the journal keeps stable fork request IDs,
  so lost HTTP responses cannot create duplicate forks; without them, windows already opened are reused.
- **Switching.** Decide `scene_forks` when the campaign starts. Turned off later, a main story still played in a fork
  comes back to the Main Chat at the next start once nobody is split off (until then it stays where it is).

Lines carry the timeline their speaker was in **when they wrote them**, so a story told in the Main Chat by someone back
from a side trip is tagged with that trip, and a player's lines from before a split keep the old tag. A co-player
hears a window only while it sits there (its seats have a start and an end), knows which companions are **with it
here** and which are elsewhere, and never sees lines a player wrote from another scene.

> **Public channels.** In a channel whose knowledge mode is *public* (what `setup` creates), every player can read
> every window a member of their group sits in, so **split scenes are readable by every player**. In an *isolated*
> channel, players who share a player group can still read each other's split scenes. `run` and `status` warn in
> either case. Use an isolated channel with one player per group if split scenes must stay private.

You can split and rejoin by hand too. While `run` keeps the channel, these commands are queued for it (it is the only
process that writes the state file); otherwise they are applied directly and their opening turn waits for `run`. If
`run` finds the state file changed by another writer anyway, it stops rather than act on a stale table; start it again
to continue from the file. A command refuses to run while a split is half-finished; `run` finishes it first:

```bash
node src/cli.mjs split --channel <id> --who "Alice Hale,Harriet Vance" --place "Old Harbour" [--span long] [--time "Tuesday night"] [--opening "Fog hangs over the harbour."]
node src/cli.mjs rejoin --channel <id> --timeline "Old Harbour"      # or a handle: --timeline T2
node src/cli.mjs advance --channel <id> --title "The next morning"    # open the next scenario now
node src/cli.mjs status --channel <id>                                # read-only: threads, seats, settings
```

`timelines.auto: false` goes back to the older, model-led `split`/`rejoin` actions for co-players only.

### Scenarios

Scenarios are the platform's story stages, for the whole campaign: opening the next one moves every window there and
closes and summarises the old one. The GM model opens it (`advance_scenario`) or enters a prepared one
(`enter_scenario`) when the story as a whole moves on: a jump in time, the party reaching a new place for good, a module
stage done, or the platform's own "New scenario?" reminder. The client refuses, with a GM-only note saying why,
unless:

- the turn is in the primary story window (`T0`: the Main Chat, or its fork with scene forks), never in a side thread or the public lobby;
- it is a turn after a player's or co-player's line, never an autonomous or arrival turn;
- **no short split** is active (a long one carries on into the new scenario);
- at least `scenarios.min_minutes` have passed since the current scenario began and it has at least
  `scenarios.min_lines` events.

Each turn the GM is told whether a change is possible now. `scenarios.auto: false` leaves scenarios to you (`advance`).

### Autonomy

On its own clock (`autonomy.tick_ms`) the table also runs:

- **side** turns: a co-players-only window moves on, turn after turn, every `autonomy.side_interval_ms`, with no human
  line. The co-players drive the thread; the GM runs the world and answers them at once;
- **quiet** turns: a scene with human players that has been silent for `autonomy.quiet_ms` moves on a little: the
  world, the NPCs, a question to a named player, the co-players. The GM is told never to decide, speak or roll for a
  player character; the client enforces it too. After `autonomy.quiet_turns` quiet turns the window waits for a human
  again. Only windows where a human spoke recently are moved; the Main Chat never runs side turns.

Autonomy is capped at `autonomy.max_turns_per_hour` (and by `context.daily_token_budget`), never runs while another turn
is pending, and any human line wakes the table up. `autonomy.enabled: false` turns it off.

**Fragmented play.** A campaign can also go on for weeks with people dropping in hours or days apart:
- **Away mode.** Once no human has posted in the channel for `autonomy.idle_minutes`, the table is "away". Shared
  windows wait. Co-players-only threads still move, but only every `autonomy.away_side_interval_ms` (default 6 hours; 0 makes
  them wait too), so the story moves on a little between visits without spending much.
- **Returning players.** A player who writes after being away for longer than that gets a welcome back in the GM's
  answer: where their character is now and what has moved on meanwhile, then the scene is theirs. Recaps of the story
  so far come from the platform's own tips for players.
- **Absent characters.** In the window list the GM sees which player characters' players are away. Those characters stay
  in the scene but passive: the GM never acts for them, never makes the scene wait on them, and lets no harm befall them
  until their player is back.
- **Pace.** A human line gives each co-player one turn. In a quiet turn that follows, a co-player who has already
  answered stays quiet, so slow human players are not drowned out by the AI side of the table.

**Costs.** A genuine new scene creates a fork and may rebuild the affected player group's derived memory.
Pausing/resuming an existing member preserves accumulated memory. A split or reunion may also cost an arrival turn
(a GM call, the co-players and a follow-up).

## The story planner

The GM reads the recent chat and plays step by step. In a long casual campaign nobody holds the whole story: one
trivial event stretches over many turns, and neither the GM nor the co-players dare to move on. The **story planner**
is a second, slower model role above the GM (`src/planner.mjs`): now and then, in the background and with its own model,
it rereads the campaign, keeps a plan of the twists and turns, reviews its own draft, and tells the GM when the current
event has run its course.

- **It advises; the GM decides.** The plan is a section of the GM's context: the throughline, the current beat with
  its exit condition, the verdict (continue or move on), the next twists and the threads to weave in. The GM steers
  toward it and deviates when the players surprise it. When the planner says the event has run its course, the GM gets
  a note to bring it to a close, and the scenario pace guard (`scenarios.min_minutes` / `min_lines`) is lifted until the
  scenario changes.
- **It plans slowly.** A plan is made at a turn boundary, never during a turn, when one of these holds: the first ten
  lines of a campaign; the GM asked (a `planner_note` action); the scenario changed; the story stalled
  (`planner.stall_turns` turns in the same place with no world change, no new truth, no split and no scenario change);
  or `planner.interval_minutes` of play and `planner.min_lines` lines have passed. Never while everyone is away (no
  player line for `autonomy.idle_minutes`; co-players' and NPCs' lines do not count), never over the daily token
  budget, at most `planner.max_runs_per_hour` and `planner.cooldown_minutes` apart. The only run without anyone at the
  table is the final review below.
- **The final review closes every session.** A session is a stretch of player lines with no gap longer than
  `autonomy.idle_minutes`. When one with at least `planner.final_review_min_lines` player lines ends (nobody has
  written for the idle time, or `run` is stopped), the planner reviews the whole session once, reading every window's
  lines of it, and prepares the next one. It is bolder than a plan made during play: in a casual game it moves the
  calendar on (up to `planner.final_review_max_days`; one day when it does not say) and sets the routine for the new
  date; it records what the world did meanwhile in the world record (improvisation mode only; secret when the
  investigators would not know it), and writes how the next session should open. The GM gets a GM-only note;
  the first GM turn of the next session is told how many days passed, what happened off-screen and how to open. Ctrl-C
  on `run` waits for the review; a second Ctrl-C skips it.
- **It reviews itself.** One run is three calls in one conversation, so the big context is cached once: a draft; a
  critique by "a second GM, a harsh script editor who did not write this" (what is boring, implausible or contradicts
  the world and the truths, which threads are stale or should be merged, whether the beat is done, whether the verdict
  is honest); and a revision that must fix every fault. The critique is kept with the plan.
- **It dares.** In improvisation mode it invents original plots, weaves several into one situation and raises the
  stakes, within the world setting and the hidden truths; each invention is a secret twist the GM reveals through play.
- **Co-players get impulses.** Each co-player may get one private urge, written in character ("you want to see the
  docks tonight"), shown only to it as its own thought and dropped after `planner.impulse_lines` lines. An impulse that
  quotes a secret or a truth, or talks about the game itself, is discarded. The GM sees only who got one.
- **Module-led campaigns: pace only.** With a module, the planner invents nothing and judges only when to let an event
  go.
- **The GM sees it.** Every new plan version is announced once as a GM-only note in the Main Chat; `status`
  shows the plan, and `plan show` prints it (`--full`: the draft, the critique and the revision).

```bash
node src/cli.mjs plan show --full
```

```bash
node src/cli.mjs plan now
```

```bash
node src/cli.mjs plan off
```

The planner's own provider, endpoint, model and effort are `planner.*` in `gm-agent.yml` (defaults: the GM's, at
`high` effort); its key is `PLANNER_API_KEY`, or the provider's. Its calls count toward `context.daily_token_budget`.

## Time and people

**The calendar (casual games only).** In casual mode the story keeps a date (`src/calendar.mjs`), always YYYY-MM-DD
with its weekday: "1923-10-02 (Tuesday), morning". A solemn game has no date from the agent: no calendar section, no
`date` action, and no date in the plan or the final review.
- **The first date is the planner's.** With no date set, the first plan runs at the first turn boundary. It picks a
  date and a time of day that fit the era, the World setting and the plots it plans. A year outside the channel's era
  (`1920s`, `1890-1899`, `1923`) is moved to the nearest year inside it. Until then, the GM keeps the day vague, and a
  first date from the GM is left to the planner.
- **Everyday life follows a routine.** With the date, the planner sets what everyday life is busy with on that date
  and the routine events of the next weeks. It takes them from the world's own calendar when world.md describes one (a
  school year, a fishing season, holidays, festivals) and from the era, and invents fitting ones where world.md says
  nothing. The routine is common knowledge: a routine that quotes a secret or a hidden truth is dropped. Each plan and
  each final review refreshes it. Once the date moves past it, it is marked with the date it was set for.
- **Who reads it.** The GM reads the date, the routine and the latest changes in its context. Each co-player reads
  "TODAY IN THE STORY", with its own thread's time of day, and the routine. It also reads a line when time passed
  since it last spoke.
- **It moves forward only.** The GM moves it with the `date` action when time passes in play, or with `advance_days`
  on a scenario change. The planner says in its plan when it should move next. The final review after each session
  moves it on between sessions, and the operator can use the `date` command.
- **The GM moves it slowly.** After the date moves (by anyone), the GM may move it on again only once
  `calendar.min_minutes` of real time and `calendar.min_lines` player lines of play have passed (out-of-character
  chatter does not count), and by at most `calendar.max_days` days at once (30 minutes, 30 lines and 2 days by
  default; 0 turns a limit off). Until then only the time of day moves. The GM's Calendar section says which of the
  two it is ("may move on now" or "may not move on again yet"; no countdown, so the prompt cache holds). A `date`
  action that comes too soon is refused, and the GM gets a GM-only note saying how much time and play are still
  missing. One that asks for more days is cut to the most, with a note to tell the time to match. A scenario change
  with `advance_days` that comes too soon is refused whole, so the new scene's time and the date never disagree; the
  same change within the day goes through. The operator's `date` command and the final review are not held to it
  (the final review keeps `planner.final_review_max_days`). `status` shows the pace and what it is waiting for.

When play skips ahead, the GM posts the new time in the affected window. The handoff distinguishes completed
events from outstanding plans in one or two short AI-written sentences, without quoting dialogue or adding reference
cards. It mentions only what matters for the next scene and avoids repeating reminders already shown. Source line
numbers remain in internal diagnostics, not the player-facing post. If no reminder is useful, or summarisation fails,
only the time is shown. Overlong summaries are rewritten rather than cut mid-sentence. This applies to same-day cuts,
session resumptions and date changes; private planning notes and parallel scenes cannot supply the summary.

```bash
node src/cli.mjs date --days 2 --time morning
```

```bash
node src/cli.mjs date
```

**What is striking about people.** Characteristics are never shown as numbers. The extremes are turned into words
(`src/context/traits.mjs`): 80 and above is "extremely good-looking, striking" for APP or "extremely intelligent" for
INT. Near the bottom of the range is the opposite, such as "very plain" or "slow-witted": 25 for STR, CON, DEX, APP and
POW, and 45 for SIZ, INT and EDU, which start at 40. Luck is left out. In a D&D channel the six ability scores count
instead: 18 and above, or 7 and below. At most three traits are given, the most extreme
first, with gender and age. The GM and the planner read them for everyone; a co-player reads them for its companions
and for the NPCs it has met.

**Relationships.** Who lives with, loves, is related to, works with or is at odds with whom (`src/bonds.mjs`). The GM
records them with the `bond` action. The planner adds the ones the profiles state and, in improvisation mode, the ones
it invents to tie plots to people. It records a bond with a player character only when that character's profile or the
chat already states it. The operator can use the `bond` command. The GM and the planner read every bond. A co-player
reads its own bonds, secret or not, and the public bonds between people it knows.

```bash
node src/cli.mjs bond "Alice Hale" "Harriet Vance" "lives with" --note "they share rooms above the shop"
```

```bash
node src/cli.mjs bond end "Alice Hale" "Mr. Grimsby" rivals
```

## Improvisation mode

Without a module, the table can improvise a campaign from a world setting you write yourself:

```bash
node src/cli.mjs setup --channel <CHANNEL_ID> --coplayers 2 --improv --world world.md --secrets secrets.md
```

- **`world.md`, the world setting** (your own text, used as written, up to 30,000 characters): places, factions, people,
  tone, what everyone knows.
  - Shared with **everyone**. `run` posts it in the Main Chat for the human players (in parts if it is long), once per
    version of the text.
  - The GM, the real NPCs and every co-player get it as a section of their prompt. The posted copy is left out of
    their chat logs, so it is not read twice.
- **`secrets.md`, the GM's hidden layer** (optional): what is really going on. Only the GM and the real NPCs read
  it; it is never posted.
- **The GM improvises.** It grows the story from the world, the investigators' backgrounds and the players' choices,
  and is told to reveal hidden things only through play.
  - Whenever it decides a hidden fact (who did it, what someone wants), it records it with a `truth` action.
  - Recorded truths are kept in the state file and shown to the GM, never to the co-players, so later turns stay
    consistent.
- **Co-players are written into the world.** New ones get a full personality and a background story rooted in it.
  Each co-player knows its own story and its companions' public profiles. Missing background on an adopted GM-cast PC
  is also filled in to fit the world.
- **No module.** The platform's script knowledge and module hints are not read in this mode.
- **BRP with CoC presets.** An improvised campaign is a Basic Roleplaying game on the Call of Cthulhu 7th edition
  presets: CoC's characteristics, skills, dice and sanity, with genre and tone taken from your world, not necessarily
  horror. A module-led campaign stays Call of Cthulhu as such. In a D&D channel the same holds with the fifth-edition
  rules: a fifth-edition game whose genre and tone follow the world setting, not necessarily fantasy.

To change the setting during a campaign, use `world` (handed to `run` if it is up):

```bash
node src/cli.mjs world --world world-v2.md
```

```bash
node src/cli.mjs world --secrets secrets-v2.md
```

```bash
node src/cli.mjs world --improv false
```

A text you leave out keeps its current version. `status` shows whether the mode is on, the setting's size, whether it
has been posted, and how many truths the GM has recorded.

## D&D 2024 channels

A channel plays by one rule system, its GM's choice on the platform: Call of Cthulhu 7e (`coc7e`, the default), D&D
2024 from the System Reference Document 5.2 (`dnd2024`; see `docs/DND_2024.md`), or PbtA (`pbta`). The client reads `rule_system` from
the channel and chooses a rules profile (`src/rules/`): the words its prompts use, the game's framing, the dice each
role may use, how role cards are written and checked, and what counts as striking. A test holds a CoC table's prompts
byte for byte, so a release does not rebuild its prompt caches by accident (calling the GM "GM" in every system
rebuilt them once).

```bash
node src/cli.mjs setup --create --rules dnd2024 --coplayers 2 --level 1
```

- **Words.** The player characters are adventurers and the game is "a fifth-edition fantasy roleplaying game (D&D
  2024 rules, SRD 5.2)", as the platform's own prompts name them. The GM is "GM", as in every system, and its lines
  are labelled "GM" for every model.
- **Cards.** A co-player's card is a D&D build in `role_card.dnd` (`src/roles/dndcard.mjs`): class, species and
  background from the SRD lists, a 27-point array of base scores, the background's increases, the proficiencies, AC,
  features and spells. The model chooses the character; the client computes saves, hit points, speed, hit dice, spell
  slots and the spellcasting ability, checks the build against the same rules the platform applies under point buy
  (budget, 8–15, increases, saves, skill counts), asks the model for one repair when it breaks them, and still repairs
  the platform's own `points_rule` refusals. New co-players are built at `table.level` (`--level`, default 1);
  existing GM-cast PCs keep their level and their own scores, and `setup` only fills what is missing. The CoC
  background fields carry the D&D texts: ideals under ideology, bonds under significant people, personality traits and
  flaws under traits. NPCs get a build too; under point buy an NPC is a legal character build like anyone's. Monsters
  have no card: the GM rolls them by name.
- **Dice.** Co-players roll `.rc` D20 Tests (checks, saves, attacks with their own bonus typed), `.ri` initiative,
  `.ds` death saves, `.ss` spell slots and `.r`; never `.init`, `.st`, hidden rolls or `.sc`. The GM asks players with
  `request_roll` (`.rc Stealth dc 15`, `.rc WIS save dc 13`, `.rc attack +5 ac 14`) and has a `dice` action of its
  own for what the platform lets the GM account roll without a sheet: a monster's initiative (`.ri +2 Goblin`), the
  order (`.init next`, `.init del`, `.init clr`) and plain rolls (`.r 1d20+4`, `.r 1d8+3`).
- **Combat.** The GM's prompt carries a combat rule: when a fight starts everyone rolls initiative, the GM follows the
  window's Initiative order (shown in its context while a fight is on, refreshed on the platform's
  `initiative.changed` event), acts for the monsters on their turns, asks each character's player on theirs, calls
  `.init next` after every turn, removes the fallen and clears the order when the fight is over. Monsters' AC and hit
  points live in the GM's notes.
- **What is striking.** Final ability scores of 18 and above are named ("extremely strong", "extremely charismatic,
  magnetic"), 7 and below the opposite; a co-player's own sheet shows its modifiers, proficiency bonus, AC, live HP,
  saves, skills and slots, while companions see its build line ("level 3 Elf Rogue (Criminal)") and traits only.

Everything else (timelines, scenarios, the planner, phones, the calendar, relationships, the final review) is the same
across the supported systems.

## Casual mode: phones

For casual roleplaying, usually (not necessarily) together with improvisation. It is a client option; the platform
knows nothing of it. Without it the game is solemn and there are no phones.

```bash
node src/cli.mjs setup --channel <CHANNEL_ID> --coplayers 2 --casual --improv --world world.md
```

```bash
node src/cli.mjs casual on
```

```bash
node src/cli.mjs casual off
```

- **Phones.** Each player character gets a phone: a private window, `Phone: <name>`, with only its player in it. New
  players get theirs when they join.
- **Texting.** Write `@` and a name, e.g. `@Silas Mott where are you?`. A line without `@` goes to whoever you texted
  last (or who texted you last). An unknown name gets a hint and reaches no one.
- **Replies:**
  - A real NPC answers through the GM, as that NPC, after a believable delay of its choosing, or leaves the message on
    read.
  - A co-player answers in character the same way, at most `modes.casual_max_delay_minutes` later.
  - Pending replies are kept in the state file, so they survive a restart and still arrive while everyone is away.
- **Other players.** A text to another player appears in their phone at once, posted as the sender's character.
- **First contact.** The GM may have an NPC text a player or a co-player (a hook, news, an invitation). A co-player
  may text anyone it knows instead of speaking in the scene: a player, a companion, or an NPC it has met.
- **The phone log.** Texts with no player character in them go to `Phone log (GM only)`, a window with only the
  GM's account in it (a channel that already has one keeps it under the name it was made with). That covers co-player
  to co-player, co-player to NPC, and NPC to co-player. Each line is one text, posted as the sender: "→ Tomas
  Leclerc: Meet me at the pier at nine." The recipient answers there in its own
  time: a co-player through its own model, an NPC through the GM. The GM reads the log like any other window.
- **AI texting has limits.** Two AI characters stop after `modes.casual_ai_chain` texts in a row until a person writes
  again. At most `modes.casual_ai_texts_per_hour` such texts are answered an hour, and none while everyone is away
  (they still arrive).
- **Who knows what.** A text never starts a scene turn and never moves anyone between scenes. The GM reads every
  phone; a co-player knows only the messages it sent or received.
- **Privacy.** Phones are private only on an **isolated** channel with one player per group, so casual mode stays off
  anywhere else. Create the channel with knowledge mode *isolated* in the web app (with `setup --create --casual`, a
  new channel is made isolated).

`status` shows the phones, the phone log and the texts still on their way.

## The planner window and new players

**The planner window.** When the story planner is on, `run` opens `To the story planner`, a window with every player
of the channel in it (`planner.wish_window`). It is out of character and no scene is played there. Players write two
kinds of things:
- **A wish:** where they would like the story to go ("a slow-burn rivalry with the harbour master").
- **A correction:** what the story got wrong against their setting, stated or implicit ("Harriet would never leave a
  friend behind", "there is no magic in this world", a tone they do not want).

The lines start no run of their own: the planner keeps to its usual routine. Its next run, whatever triggers it, is
given the new lines, keeps the standing wishes and corrections as numbered table notes (N1, N2…), refines or drops
them as the players write more, and answers in the window along the way. Its answer never quotes a twist
or a hidden truth. Who reads the notes:
- the GM reads them all in its context: corrections to keep to strictly, wishes to steer toward;
- a co-player reads only the corrections about it or about no one in particular, as out-of-character table rules;
- a wish is the planner's to weave in, so co-players never see one.

`status` lists the notes. Every player in the channel can read what the others write there.

Send `/pause` on its own in this window to pause the channel. It cancels current and queued GM, co-player
and planner generation. Phone messages whose text and delivery time are already saved still arrive. Their delivery
does not trigger another reply while paused. The next message from any human player in the channel resumes hosting,
including a message in the planner window or on their character’s phone. A pause survives restarting the agent.

**New players.** When someone joins the channel, the platform seats them in the Main Chat. The client then seats them
in the planner window and, in casual mode, opens their phone. When their player character appears, the GM gets an
arrival turn in the current primary scene, after granting access to that scene's future messages. The platform sends no event when a character is
created, so the client looks again every minute.

## Setup

Requirements: Node 22.13+ and a running Acerciae backend.

```bash
cd gm-agent
npm install
cp gm-agent.example.yml gm-agent.yml
cp .env.example .env
```

Settings live in `gm-agent.yml` (every key is explained in `gm-agent.example.yml` and the table under Configuration);
the environment or `.env` holds only secrets and what differs between deployments:

- `ACERCIAE_API_BASE`, `CHANNEL_ID`, `STATE_DIR`;
- `GM_PASSWORD` (the account's name is `account.username` in the file; `account.register: true` creates it);
- the model's key: `ANTHROPIC_API_KEY` for Claude, or `LLM_API_KEY` with `llm.provider: openai_compatible`,
  `llm.api_base` and `llm.model` in the file. `openai_compatible` talks to the OpenAI Responses API
  (`{api_base}/responses`), so the endpoint must implement it; servers that only offer Chat Completions do not work;
- `PLANNER_API_KEY`, when the story planner uses another provider than the GM.

The client keeps a channel you already run. In the web app, create a server and a channel (or open an existing one)
and make the client's account its GM (channel members → role GM). Then:

```bash
node src/cli.mjs setup --channel <CHANNEL_ID> --coplayers 2
```

Without `--channel`, `setup` lists the channels the account is GM of and asks which one to keep (or, with none, says how
to create one). The client never creates a server, a channel or an invite code on its own. If you want it to anyway (for
scripts and tests), `setup --create` makes a new server and channel, prints an invite code for the players, and uses
`channel.server_name`, `channel.channel_name`, `--era` and `--rules` (`channel.rule_system`: `coc7e`, `dnd2024` or `pbta`):

```bash
node src/cli.mjs setup --create --coplayers 3 --era 1920s
```

```bash
node src/cli.mjs setup --create --coplayers 2 --rules dnd2024 --level 3
```

`setup` prints the channel id. Add the players to the channel in the web app, or with `POST /api/channels/{id}/members`.
Every setup first checks existing co-players on the
platform: it fills missing appearance prompts, basic information, characteristics (in D&D: the build) and background
fields while preserving filled values (including current HP/SAN, and in D&D the level, AC, hit points and improvements). Complete characters are skipped without a model call. It then creates only
the additional co-players needed to reach `table.coplayers`. It never recreates existing characters or fills human players' cards.

Appearance prompts are generated alongside new role cards (also for new NPCs during play) and saved under Appearance &
images. Saving the prompt does not change uploaded/generated image mode or automatically spend image-generation credits.
Missing injury, phobia, magic and Mythos-experience fields use an explicit "None" when applicable.

With the channel's `point_buy` option on (GM workspace → Settings → Rules; older servers: the `coc7_points` feature), setup also checks career and skill purchases. The model chooses a career,
then receives that career's complete point formula, fixed skills, choice groups, free specialties, Credit Rating range and
skill bases. It allocates career/hobby increments; the platform computes the final skill values. Existing growth points
are retained. Missing/invalid allocations are repaired, including older co-players with only handwritten skill totals.
The platform's validation errors get up to two allocation repairs; setup fails visibly if they still cannot be saved,
instead of discarding the career and points. Corrections to allocations recalculate the affected skill totals.

```bash
CHANNEL_ID=<id> npm start          # or: node src/cli.mjs run --channel <id> [--kickoff]
node src/cli.mjs status --channel <id>
```

`--kickoff` opens the session with a scene-setting narration. Without it, the GM waits for the first player line.

## Configuration

Ordinary settings live in `gm-agent.yml`, found as `--config <file>`, `GM_AGENT_CONFIG`, `./gm-agent.yml` or the file
beside the client. A `--flag` overrides a key for one run. The environment (or `.env`) is read only for the seven
names in the last rows. Other variables older versions read are ignored, with a warning that names the key to use.

| Key in `gm-agent.yml` | Flag | Default | Meaning |
|---|---|---|---|
| `account.username`, `account.display_name` | `--username`, `--display-name` | –, `AI GM` | the GM account the client signs in as (its password: `GM_PASSWORD`) |
| `account.register` | `--register` | `false` | register the account when sign-in fails |
| `channel.create` | `--create` | `false` | let `setup` create a new server and channel (and an invite code) instead of keeping one the account is GM of |
| `channel.server_id`, `channel.server_name`, `channel.channel_name`, `channel.era` | `--server`, `--server-name`, `--channel-name`, `--era` | | used only with `--create` |
| `channel.rule_system` | `--rules` | `coc7e` | the rule system of a channel made by `setup --create`: `coc7e`, `dnd2024` or `pbta`; `channel.rules` remains an alias (an existing channel's is read from the platform) |
| `table.coplayers` | `--coplayers` | `2` | number of co-players (0–8) |
| `table.level` | `--level` | `1` | D&D: the level new co-players are built at (1–20); existing characters keep theirs |
| `table.coplayer_windows` | `--coplayer-windows` | Main Chat | window ids or names the co-players sit in |
| `table.language` | `--language` | server language | language of everything the client writes |
| `table.kickoff`, `table.verbose` | `--kickoff`, `--verbose` | `false` | open the session without waiting; log every post |
| `llm.provider` | `--llm-provider` | `anthropic` if `ANTHROPIC_API_KEY` is set, else `mock` | `anthropic`, `openai_compatible` (the OpenAI Responses API) or `mock` |
| `llm.model` | `--llm-model` | `claude-opus-5-5` for Claude | model id |
| `llm.api_base` | `--llm-api-base` | | the endpoint (`openai_compatible`); the key is `LLM_API_KEY` or `ANTHROPIC_API_KEY` |
| `llm.effort` | `--llm-effort` | `medium` | Claude effort (`low` … `max`) |
| `llm.fallbacks` | `--llm-fallbacks` | `true` | Claude: re-run a declined request on Anthropic's recommended fallback model |
| `llm.trace` | `--llm-trace` | – | append every model request and reply to this JSONL file, to audit what each role was shown |
| `llm.stream` | `--llm-stream` | `true` | stream Anthropic and OpenAI-compatible replies, including a separately configured planner |
| `llm.timeout_ms` | `--llm-timeout-ms` | `600000` | maximum wait for data when streaming, or the total deadline with streaming disabled |
| `llm.cache_ttl` | `--llm-cache-ttl` | `1h` | Anthropic prompt-cache lifetime: `1h`, `5m` or `off` |
| `planner.enabled` | `--planner` | `true` | the story planner (see "The story planner") |
| `planner.provider`, `planner.api_base`, `planner.model` | `--planner-provider`, `--planner-api-base`, `--planner-model` | the GM's | the planner's own model and endpoint (its key: `PLANNER_API_KEY`, else the provider's key) |
| `planner.effort` | `--planner-effort` | `high` | the planner's reasoning effort (ignored by `openai_compatible`) |
| `planner.interval_minutes`, `planner.min_lines` | | `30`, `40` | play time and lines since the last plan before an automatic one (`interval_minutes: 0`: only `plan now`) |
| `planner.cooldown_minutes`, `planner.max_runs_per_hour` | | `10`, `4` | least gap between runs; hourly cap |
| `planner.stall_turns` | | `6` | turns in the same place with no world change, truth, move or scenario change before the planner is asked |
| `planner.impulse_lines`, `planner.plan_tokens` | | `60`, `1500` | how long a co-player's impulse lives; budget of the GM's "Story plan" section |
| `planner.wish_window` | `--planner-window` | `true` | the planner window for the players' wishes and corrections, read at the planner's next run |
| `planner.final_review`, `planner.final_review_min_lines`, `planner.final_review_max_days` | `--final-review`, `--final-review-min-lines`, `--final-review-max-days` | `true`, `10`, `30` | the review when a session of human play ends: on or off, how many player lines a session needs, how many story days it may move the calendar |
| `pacing.debounce_ms`, `pacing.post_delay_ms` | `--debounce-ms`, `--post-delay-ms` | `4000`, `1200` | quiet time before a turn; pause between posted lines |
| `pacing.max_actions_per_turn` | `--max-actions` | `6` | lines per turn |
| `context.gm_tokens`, `context.coplayer_tokens` | | `60000`, `24000` | context budget for the GM and for each co-player; older history is compacted into chapters |
| `context.recall_tokens` | `--context-recall-tokens` | `1200` | local relevant excerpts per turn, also capped at 5% of the role budget; 0 disables, max 4000 |
| `context.page_lines`, `context.backfill_lines` | | `100`, `1000` | lines fetched per page when syncing the local copy of the chat; how far back the first sync goes |
| `context.daily_token_budget` | | `0` (off) | billable-equivalent tokens a day; once spent, no autonomous turns or plans until tomorrow |
| `autonomy.enabled` | `--autonomy` | `true` | side timelines and quiet windows move on the table's own clock |
| `autonomy.tick_ms` | | `30000` | how often the table looks for a window that should move |
| `autonomy.side_interval_ms` | | `90000` | pause between turns in a side window |
| `autonomy.quiet_ms`, `autonomy.quiet_turns` | | `180000`, `2` | silence before a shared window moves on, and how many such turns until a human posts again |
| `autonomy.max_turns_per_hour`, `autonomy.idle_minutes` | | `20`, `30` | hourly cap on autonomous turns; "away" once nobody has posted for this long |
| `autonomy.away_side_interval_ms` | | `21600000` (6 h) | while away, how often a co-players-only thread moves (0: never) |
| `timelines.auto` | `--timeline-auto` | `true` | the GM reports whereabouts and the table splits and reunites the party; `false`: model-led co-player splits |
| `timelines.scene_forks` | `--scene-forks` | `false` | `true`: after the first split the main story moves to a private fork and the Main Chat becomes a lobby the GM never narrates in; `false`: the main story stays in the Main Chat with the players (see Timelines) |
| `timelines.guard_turns`, `timelines.guard_ms` | | `2`, `180000` | a co-player's move that undoes a recent change waits for two agreeing turns within this window |
| `timelines.max_active` | | `4` | at most this many threads at once (the main one included) |
| `timelines.pc_cooldown_ms` | | `300000` | a player gets a new window at most this often |
| `timelines.max_arrivals_per_hour` | | `12` | arrival turns (opening a new or changed scene) per hour |
| `scenarios.auto` | `--scenario-auto` | `true` | the GM opens the next scenario itself (from the primary story window only) |
| `scenarios.min_minutes`, `scenarios.min_lines` | | `20`, `30` | the current scenario must be at least this old and this long before the GM changes it (lifted when the planner says move on) |
| `calendar.min_minutes`, `calendar.min_lines`, `calendar.max_days` | `--calendar-min-minutes`, `--calendar-min-lines`, `--calendar-max-days` | `30`, `30`, `2` | casual games: how long, and how many player lines of play, after the date last moved before the GM may move it on again; how many days the GM may skip at once (0: no limit) |
| `modes.improv` | `--improv` | unset | improvisation mode (with `setup` or `world`; then kept in the state file) |
| `modes.world_file`, `modes.secrets_file` | `--world`, `--secrets` | | your world setting and the GM's secrets, read by `setup` and `world` (relative to the file) |
| `modes.casual` | `--casual` | unset | casual mode, phones for the player characters (with `setup` or `casual on/off`; then kept in the state file) |
| `modes.casual_max_delay_minutes` | | `240` | longest delay before an NPC's or co-player's reply to a text |
| `modes.casual_ai_texts_per_hour`, `modes.casual_ai_chain` | | `12`, `4` | texts between AI characters answered at most an hour; how many in a row before an exchange rests until a person writes |
| env `ACERCIAE_API_BASE` | `--api` | `http://localhost:8080` | backend address |
| env `CHANNEL_ID` | `--channel` | – | the channel to keep; without it `setup` lists the channels the account keeps and asks |
| env `STATE_DIR` | `--state-dir` | `./.state` | the state file, the SQLite store, the lock and the command inbox |
| env `GM_PASSWORD`, `ANTHROPIC_API_KEY`, `LLM_API_KEY`, `PLANNER_API_KEY` | | | secrets |
| env `GM_AGENT_CONFIG` | `--config` | | where `gm-agent.yml` is |

**Mock mode.** `llm.provider: mock` writes labelled placeholder text (`[mock GM] …`). It exercises every pipeline
without a provider. It is for tests and demos, not for play.

During setup, the CLI prints which co-player it is generating and reports elapsed time every 15 seconds while waiting
for the model. HTTP 504 means the model gateway timed out, even if the client's deadline has not expired. Streaming
can keep an idle-timeout gateway connection active once the model starts sending data, but cannot fix an unavailable
upstream or a gateway's absolute request deadline. After a failure, run setup again; it keeps previously saved co-players.

**Recovering a lost roster.** If the state file is lost, the roster is rebuilt from the channel's characters: PCs owned by
the GM account are co-players and every NPC is a real NPC (including ones the GM makes in the web app).
Co-players made by older versions are NPCs whose speaking style starts with `[co-player]`; they are still recognised,
because the platform cannot change a character's kind.

## Tests

```bash
npm test
```

The tests need no backend and no model. They cover:

- the co-player filter (GM notes, other characters' whispers, other windows and AI tips never reach a co-player);
- role-card checks;
- a whole turn against an in-memory platform, with the mock model recording every prompt;
- the request shape of the Claude and OpenAI Responses providers;
- the configuration file and its precedence;
- the story planner: triggers, the three-step review, the plan's place in the GM's context, impulses and their
  privacy, pace-only in module play, the lifted pace guard, no run while nobody is at the table, and the final review
  after a session;
- the calendar, the distinctive traits and the relationships, and which role reads which of them;
- the phone log and its limits, the planner window (wishes, corrections, who reads them), and new players;
- D&D 2024: the rules profile, the build maths and the local point-buy check, generation, repair and completion of
  D&D cards, the GM's and co-players' prompts and dice, the `dice` action, the initiative section, and a snapshot that
  keeps a CoC table's prompts byte for byte.

## Sessions

The platform's sessions end (`AUTH_TOKEN_TTL_HOURS`, 168 by default, or when an admin revokes them), and it checks a
WebSocket's session only when the socket connects. The client signs in again on its own: a REST call refused with 401
signs in once and retries, and a socket refused as unauthorized after a reconnect (a backend restart, a network blip)
signs in again and reconnects at once with the new session. Both sockets and the REST client share one sign-in. If no
session can be had (a suspended account, a changed password), the sockets keep retrying with backoff and the log says
why; the control page shows the chat and context streams as disconnected.

## Known limitations

- **Co-player lines count as GM lines.** They are posted by the GM account, so the platform records them with
  `actor_role = gm`. The platform's chronicler accepts GM-authored lines as grounds for `confirmed` facts, so a
  co-player's in-character guess may be recorded as established. Log Studio and the players' group memory count them
  as the investigator's lines (the character is a PC); the GM-side observers, reminders and script tracking still
  see a GM line.
- The story planner's impulses are planner text in a co-player's prompt: quoted, capped and filtered, but not provably
  inert. Its stall detector counts turns, so a long, talky scene can cost one extra advisory run. The GM may ignore the
  plan, and a plan can change every ten minutes: the "Story plan" section re-caches each time (parts A and B do not).
- D&D: NPCs under point buy are legal character builds, never stat blocks (monsters have no card). Attack bonuses are
  typed by the GM or the co-player, not read from the sheet, as the platform's `.rc attack` works. The GM account has no
  character, so it cannot roll `.rc` for itself. The Initiative order is read for this turn's window only.
- The era check reads years from the channel's era text only. An era with no year in it ("Victorian") is not
  checked.
- The calendar is the campaign's: a long split shares one date, and each thread keeps only its own time of day.
  Traits come from the characteristics alone, so a background that says otherwise ("a plain face") is not reconciled.
- The final review on Ctrl-C makes three planner calls before `run` exits; with a slow model at high effort that can
  take minutes (a second Ctrl-C skips it). If the client was down when the players left, the review runs at the next
  start, unless a player writes first.
- Co-players start in the windows of `table.coplayer_windows` and move only through whereabouts (or `split` and `rejoin`). A
  private window the GM creates in the web app does not seat them automatically and is not part of any thread.
- Timelines live in the client's state file. The platform's own chronicler does not know about them, so a side
  thread's events reach the GM documents like any other lines.
- Main Chat is always shared. Players in the same player group continue to share views even if only one remains
  active in a window. Use separate groups when the players need separate knowledge.
- Without scene forks, a split-off player stays a member of the Main Chat (as intended), so the platform keeps
  delivering the Main Chat's lines to them and its chronicler credits their character with them; windows accumulate,
  reused only for the same people at the same place.
- With scene forks, a paused member keeps access to previously witnessed history. Removing membership entirely is different: it can
  revoke old history and rebuild derived memory. Use pause/resume for temporary absence.
- Scene forks require the backend with migration `0055_window_forks.sql`. Do not run the old agent alongside it or
  roll back to an old state file during play: old membership logic cannot enforce the new scene lifecycle.
- Standalone `run` keeps one channel; `host` keeps multiple isolated channel workers in one process.

## Deployment of the scene-window update

GM-agent deployment is manual. Pushing or deploying the platform must not update the agent on server-sh.
Deploy the backend and migration 0055 first, then the web/desktop UI. Before an explicitly requested agent upgrade,
stop its old process and back up its state directory. Start only one agent per channel. On restart it recovers
unfinished forks and audience changes and partitions existing split parties before narrating again.
