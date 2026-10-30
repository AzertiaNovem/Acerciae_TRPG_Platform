# gm-agent — an AI Game Master for Acerciae

A Node.js client that sits at an Acerciae table as the **Keeper**. It talks to the platform only through the public
HTTP and WebSocket API (`docs/API.md`), the same contract the web and mobile apps use. It plays three kinds of role:

| Role | On the platform | Who writes it | What its model is given |
|---|---|---|---|
| **GM (Keeper)** | the client's account, channel role `gm` | – | everything the Keeper may read (below) |
| **Real NPC** | an `npc` character | the GM model, when the story introduces one (or the Keeper by hand) | **the same context as the GM** |
| **Co-player** | an `npc` character | **the LLM writes its COC7 role card** at setup | **only the chat log its character witnessed**, plus its own card and persona and its companions' basic details and backgrounds |

Co-players are AI investigators who play *alongside* the human players. You choose how many (`--coplayers N`). On the
platform they are NPCs like any other, because only a GM may create characters without a player. Inside this client
they are separate from the real NPCs: they get different context, and the GM model is never allowed to speak for them.

The platform's own AI never speaks in chat. It writes tips for the Keeper: the pinned board, reminder bubbles, script
knowledge, documents, highlights and module hints. This client reads those tips for the GM and the real NPCs. Co-players
never get them.

## What each role sees

**GM and real NPCs** (one shared context, built per turn by `src/context/gmContext.mjs`):

- every line in every chat window, including Keeper-only notes, whispers and hidden rolls;
- the cast: every player character and co-player with its basic details (occupation, age, sex, residence, birthplace),
  bio and background from its role card, and each real NPC with its brief;
- the current scenario and the summaries of earlier ones;
- the platform's AI tips:
  - `GET /kp/board`
  - `/reminders` and `/script-knowledge`
  - `/documents/{id}`
  - `/highlights` and `/modules/hints`
  - live `reminder.created` and `highlight.created` pushes on `/ws/context`.

**Each co-player** (`src/context/coplayerContext.mjs`). The client signs in as the Keeper, who can read every line, so
it applies the platform's player filter itself. A co-player gets only:

- lines in the windows it sits in (the Main Chat by default);
- lines with `window` visibility, and whispers addressed to its own character.

It never gets `gm_only` lines (Keeper notes, hidden roll results), whispers to anyone else, other windows, or any
platform AI tip.

Besides the log, its prompt holds:
- its own role card and persona;
- the other investigators' basic details, bio and background (`src/context/profiles.mjs`): the player characters and
  the other co-players, as a human player can read any player character's page.

It never gets a real NPC's details, or another investigator's characteristics and skills.

## How a turn runs

1. A real person posts a line in a window. After `DEBOUNCE_MS` of quiet, one turn starts.
2. **The GM's move** (`src/director.mjs`). One model call with the GM context returns the Keeper's actions:

   | Action | What happens |
   |---|---|
   | `narrate` | posts narration |
   | `npc` | a line from a real NPC |
   | `new_npc` | creates the NPC: the model writes its role card, then it speaks |
   | `whisper` | posts a whisper to one character |
   | `request_roll` | asks a player to roll; for the client's own characters, the platform rolls against their sheet |
   | `note` | posts a Keeper-only line |
   | `timeline` | records a thread's narrative time, place, span and the Keeper's private notes |
   | `advance_scenario`, `enter_scenario` | opens the next scenario, or enters a prepared one (see below) |

   The same call says whether co-players may act now, and reports **whereabouts**: who is now where (see
   [Timelines](#timelines-proactive-splitting)). A line the GM model writes for a co-player or a player is dropped.
3. **Co-players' moves** (`src/coplayer.mjs`). Each co-player seated in the window gets its own model call with its
   own context. It speaks (in character or out of character), rolls (`.ra`, `.rc`, `.r` or `.sc`, rolled by the
   platform's dice against its own sheet), or passes.
4. **The Keeper answers the co-players at once.** If any co-player acted, a follow-up GM round runs in the same turn,
   so a co-player's choice gets its consequence now, not at the next human line. The GM prompt says every player,
   co-players included, needs an immediate response that propels the story.
5. At most `MAX_ACTIONS_PER_TURN` lines are posted per turn. Lines the client posted never start a turn by themselves.

The client never decides memory proposals; those stay with the human Keeper in the web app.

## Timelines and autonomy

The table does not always wait for a human, and it does not keep everyone in one room.

### Timelines: proactive splitting

The client keeps **timelines** (threads of the story) in its state file; the platform has none. Every player
character and co-player is in exactly one. The main timeline (handle `T0`) always exists and is played in the Main
Chat; every other thread has a window of its own, a persistent handle (`T1`, `T2`, … never reused), a place, a
narrative time and a **span**: *short* when the party is briefly apart (two rooms of one house), *long* when it is far
apart (two cities).

Each Keeper round may report **whereabouts**: who is now where, and whether a group is out of reach of the others and
can explore on its own. The client decides what that means (`src/whereabouts.mjs`, a pure, tested planner):

- **A player goes elsewhere** → a new window `Scene: <place>` with that player (and any co-players who went too) and
  the GM. Everyone stays a member of the Main Chat. The player is whispered a pointer to the new window, the opening
  is posted there, and an **arrival** turn opens the scene at once.
- **Co-players go elsewhere** → a `Side: <place>` window only they sit in, which moves on by itself (side turns).
- **Everyone in a scene goes to one place** → the thread just moves there; no new window.
- **A lone player leaves the co-players behind** → the Main Chat goes with the player (it is relocated); the co-players
  who stayed get a side window.
- **They meet again** → reunions always land in the main timeline, in the Main Chat, where every player already is.
  The old window gets a pointer `→ "Main Chat"` and is closed for autonomy; the reunion gets its own arrival turn.
- **Going where you already are** is no move; **going to another thread's place** joins that thread.

The rules that keep this safe:

- **Only a player moves their character.** A player character moves only when its own player said so, in this turn's
  lines in that window (not an old line, not an out-of-character one, not another player's or a co-player's
  suggestion). Co-players move only after their own lines. The Keeper decides for no one.
- **No flip-flopping.** A co-player's move that would undo a recent change needs two agreeing turns after it
  (`TIMELINE_GUARD_TURNS`, `TIMELINE_GUARD_MS`). Players' own moves are never deferred.
- **No history leaks.** Nobody is ever added to an existing window (its whole past would open to them). A player
  joining a thread whose window they are not in regroups the thread into a fresh window. A window is reused only for
  exactly the same people at the same place.
- **Bounded.** At most `TIMELINE_MAX_ACTIVE` threads at once; a new window for a player at most once per
  `TIMELINE_PC_COOLDOWN_MS`; at most `TIMELINE_MAX_ARRIVALS_PER_HOUR` arrival turns; arrivals never start further
  splits.
- **Relay.** A split-off player who keeps writing in the Main Chat is answered in their own scene; the Main Chat only
  gets a whisper pointer. A roll asked of an away player is asked in their window.
- **Crash-safe.** A split in progress is journaled; `run` finishes it on restart, and a thread whose first scene never
  played gets its arrival turn.

Lines carry the timeline their speaker was in **when they wrote them**, so a story told in the Main Chat by someone back
from a side trip is tagged with that trip, and a player's lines from before a split keep the old tag. A co-player
hears a window only while it sits there (its seats have a start and an end), knows which companions are **with it
here** and which are elsewhere, and never sees lines a player wrote from another scene.

> **Public channels.** In a channel whose knowledge mode is *public* (what `setup` creates), every player can read
> every window a member of their group sits in, so **split scenes are readable by every player**. `run` and `status`
> say so. Use an *isolated* channel if split scenes must stay private.

You can split and rejoin by hand too. While `run` keeps the channel, these commands are queued for it (it is the only
process that writes the state file); otherwise they are applied directly and their opening turn waits for `run`:

```bash
node src/cli.mjs split --channel <id> --who "Alice Hale,Harriet Vance" --place "Old Harbour" [--span long] [--time "Tuesday night"] [--opening "Fog hangs over the harbour."]
node src/cli.mjs rejoin --channel <id> --timeline "Old Harbour"      # or a handle: --timeline T2
node src/cli.mjs advance --channel <id> --title "The next morning"    # open the next scenario now
node src/cli.mjs status --channel <id>                                # read-only: threads, seats, settings
```

`TIMELINE_AUTO=false` goes back to the older, model-led `split`/`rejoin` actions for co-players only.

### Scenarios

Scenarios are the platform's story stages, for the whole campaign: opening the next one moves every window there and
closes and summarises the old one. The GM model opens it (`advance_scenario`) or enters a prepared one
(`enter_scenario`) when the story as a whole moves on: a jump in time, the party reaching a new place for good, a module
stage done, or the platform's own "New scenario?" reminder. The client refuses, with a Keeper-only note saying why,
unless:

- the turn is in the **Main Chat**, never in a split window;
- it is a turn after a player's or co-player's line, never an autonomous or arrival turn;
- **no short split** is active (a long one carries on into the new scenario);
- at least `SCENARIO_MIN_MINUTES` have passed since the current scenario began and it has at least
  `SCENARIO_MIN_LINES` events.

Each turn the GM is told whether a change is possible now. `SCENARIO_AUTO=false` leaves scenarios to you (`advance`).

### Autonomy

On its own clock (`AUTONOMY_TICK_MS`) the table also runs:

- **side** turns: a co-players-only window moves on, turn after turn, every `AUTONOMY_SIDE_INTERVAL_MS`, with no human
  line. The co-players drive the thread; the GM runs the world and answers them at once;
- **quiet** turns: a scene with human players that has been silent for `AUTONOMY_QUIET_MS` moves on a little: the
  world, the NPCs, a question to a named player, the co-players. The GM is told never to decide, speak or roll for a
  player character; the client enforces it too. After `AUTONOMY_QUIET_TURNS` quiet turns the window waits for a human
  again. Only windows where a human spoke recently are moved; the Main Chat never runs side turns.

Autonomy pauses when no human has posted in the channel for `AUTONOMY_IDLE_MINUTES`, is capped at
`AUTONOMY_MAX_TURNS_PER_HOUR`, never runs while another turn is pending, and any human line wakes the table up.
`AUTONOMY=false` turns it off.

**Costs.** Every player split creates a window with that player as a member; the platform then rebuilds that player
group's derived memory (journals, reminders) and web clients refresh. Every split or reunion also costs an arrival turn
(a GM call, the co-players and a follow-up).

## Setup

Requirements: Node 22.13+ and a running Acerciae backend.

```bash
cd gm-agent
npm install
cp .env.example .env
```

In `.env`, set:

- `ACERCIAE_API_BASE`;
- the account (`GM_USERNAME` and `GM_PASSWORD`; `GM_REGISTER=true` creates it if it does not exist);
- the model: `ANTHROPIC_API_KEY` for Claude, or `LLM_PROVIDER=openai_compatible` with `LLM_API_BASE`, `LLM_MODEL` and
  `LLM_API_KEY`. `openai_compatible` talks to the OpenAI Responses API (`{LLM_API_BASE}/responses`), so the endpoint must
  implement it; servers that only offer Chat Completions do not work.

```bash
# a new server and channel with three co-players
node src/cli.mjs setup --coplayers 3 --era 1920s
```

To use an existing channel, the account must be its GM:

```bash
node src/cli.mjs setup --channel <CHANNEL_ID> --coplayers 2
```

`setup` prints the channel id and, when it can, an invite code. Players join the server with that code. Then add them to
the channel in the web app, or with `POST /api/channels/{id}/members`. Every setup first checks existing co-players on the
platform: it fills missing appearance prompts, basic information, characteristics and background fields while preserving
filled values (including current HP/SAN). Complete characters are skipped without a model call. It then creates only
the additional co-players needed to reach `COPLAYERS`. It never recreates existing characters or fills human players' cards.

Appearance prompts are generated alongside new role cards (also for new NPCs during play) and saved under Appearance &
images. Saving the prompt does not change uploaded/generated image mode or automatically spend image-generation credits.
Missing injury, phobia, magic and Mythos-experience fields use an explicit "None" when applicable.

With the server's `coc7_points` feature enabled, setup also checks career and skill purchases. The model chooses a career,
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

Every option is an environment variable (or `.env`). The matching `--flag` overrides it.

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `ACERCIAE_API_BASE` | `--api` | `http://localhost:8080` | backend address |
| `GM_USERNAME`, `GM_PASSWORD` | `--username`, `--password` | – | the Keeper account the client signs in as |
| `GM_REGISTER`, `GM_DISPLAY_NAME` | `--register`, `--display-name` | `false`, `AI Keeper` | register the account when sign-in fails |
| `CHANNEL_ID` | `--channel` | – | the channel to keep (`setup` creates one when empty) |
| `SERVER_ID`, `SERVER_NAME`, `CHANNEL_NAME`, `CAMPAIGN_ERA` | `--server`, `--server-name`, `--channel-name`, `--era` | | used when `setup` creates the channel |
| `COPLAYERS` | `--coplayers` | `2` | number of co-players (0–8) |
| `COPLAYER_WINDOWS` | `--coplayer-windows` | Main Chat | comma-separated window ids or names the co-players sit in |
| `GM_LANGUAGE` | `--language` | server language | language of everything the client writes |
| `LLM_PROVIDER` | `--llm-provider` | `anthropic` if `ANTHROPIC_API_KEY` is set, else `mock` | `anthropic`, `openai_compatible` (the OpenAI Responses API) or `mock` |
| `LLM_MODEL` | `--llm-model` | `claude-opus-5-5` for Claude | model id |
| `LLM_API_BASE`, `LLM_API_KEY` | | | endpoint and key (Claude reads `ANTHROPIC_API_KEY` too) |
| `LLM_EFFORT` | `--llm-effort` | `medium` | Claude effort (`low` … `max`) |
| `LLM_FALLBACKS` | | `true` | Claude: re-run a declined request on Anthropic's recommended fallback model |
| `LLM_TRACE` | `--llm-trace` | – | append every model request and reply to this JSONL file, to audit what each role was shown |
| `LLM_STREAM` | `--llm-stream` | `true` | OpenAI Responses: receive streaming replies; set `false` only if the endpoint does not support streaming |
| `LLM_TIMEOUT_MS` | `--llm-timeout-ms` | `600000` | client request deadline; this does not extend a proxy/gateway's own timeout |
| `DEBOUNCE_MS`, `POST_DELAY_MS` | | `4000`, `1200` | quiet time before a turn; pause between posted lines |
| `MAX_ACTIONS_PER_TURN`, `CONTEXT_LINES` | | `6`, `60` | lines per turn; chat lines per prompt |
| `AUTONOMY` | `--autonomy` | `true` | side timelines and quiet windows move on the table's own clock |
| `AUTONOMY_TICK_MS` | | `30000` | how often the table looks for a window that should move |
| `AUTONOMY_SIDE_INTERVAL_MS` | | `90000` | pause between turns in a side window |
| `AUTONOMY_QUIET_MS`, `AUTONOMY_QUIET_TURNS` | | `180000`, `2` | silence before a shared window moves on, and how many such turns until a human posts again |
| `AUTONOMY_MAX_TURNS_PER_HOUR`, `AUTONOMY_IDLE_MINUTES` | | `20`, `30` | hourly cap on autonomous turns; no autonomy once nobody has posted for this long |
| `TIMELINE_AUTO` | `--timeline-auto` | `true` | the GM reports whereabouts and the table splits and reunites the party; `false`: model-led co-player splits |
| `TIMELINE_GUARD_TURNS`, `TIMELINE_GUARD_MS` | | `2`, `180000` | a co-player's move that undoes a recent change waits for two agreeing turns within this window |
| `TIMELINE_MAX_ACTIVE` | | `4` | at most this many threads at once (the main one included) |
| `TIMELINE_PC_COOLDOWN_MS` | | `300000` | a player gets a new window at most this often |
| `TIMELINE_MAX_ARRIVALS_PER_HOUR` | | `12` | arrival turns (opening a new or changed scene) per hour |
| `SCENARIO_AUTO` | `--scenario-auto` | `true` | the GM opens the next scenario itself (from the Main Chat only) |
| `SCENARIO_MIN_MINUTES`, `SCENARIO_MIN_LINES` | | `20`, `30` | the current scenario must be at least this old and this long before the GM changes it |
| `STATE_DIR` | `--state-dir` | `./.state` | the state file (co-players, real NPCs, seats, timelines, guard, scenario), its lock and the command inbox |

**Mock mode.** `LLM_PROVIDER=mock` writes labelled placeholder text (`[mock Keeper] …`). It exercises every pipeline
without a provider. It is for tests and demos, not for play.

During setup, the CLI prints which co-player it is generating and reports elapsed time every 15 seconds while waiting
for the model. HTTP 504 means the model gateway timed out, even if the client's deadline has not expired. Streaming
can keep an idle-timeout gateway connection active once the model starts sending data, but cannot fix an unavailable
upstream or a gateway's absolute request deadline. After a failure, run setup again; it keeps previously saved co-players.

**Recovering a lost roster.** Co-players carry a `[co-player]` prefix in their character's speaking style. If the state
file is lost, the roster is rebuilt from the channel's characters: marked NPCs become co-players and every other NPC is a
real NPC (including ones the Keeper makes in the web app).

## Tests

```bash
npm test
```

The tests need no backend and no model. They cover:

- the co-player filter (Keeper notes, other characters' whispers, other windows and AI tips never reach a co-player);
- role-card checks;
- a whole turn against an in-memory platform, with the mock model recording every prompt;
- the request shape of the Claude and OpenAI Responses providers.

## Known limitations

- **Co-player lines count as Keeper lines.** They are posted by the Keeper account, so the platform records them with
  `actor_role = gm`. The platform's chronicler accepts GM-authored lines as grounds for `confirmed` facts, so a
  co-player's in-character guess may be recorded as established. Co-player lines are posted under an NPC character, which
  the chronicler's instructions treat as an NPC claim, but nothing enforces that. A platform-side `co-player` character
  flag would fix this.
- Co-players start in the windows of `COPLAYER_WINDOWS` and move only through whereabouts (or `split` and `rejoin`). A
  private window the Keeper creates in the web app does not seat them automatically and is not part of any thread.
- Timelines live in the client's state file. The platform's own chronicler does not know about them, so a side
  thread's events reach the Keeper documents like any other lines.
- A split-off player stays a member of the Main Chat (as intended), so the platform keeps delivering the Main Chat's
  lines to them and its chronicler credits their character with them. A player who leaves a thread's window can still
  read it.
- Windows accumulate over a campaign: the platform has no way to rename, archive or delete one. Retired windows are
  reused only for the same people at the same place.
- One client process keeps one channel.
