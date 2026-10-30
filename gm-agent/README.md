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
   | `split` | sends some co-players off on a timeline of their own: a new window only they sit in |
   | `rejoin` | brings a side timeline's co-players back and merges the timeline |
   | `timeline` | records a timeline's narrative time, place and the Keeper's private notes; moves investigators between timelines |

   The same call says whether co-players may act now. A line the GM model writes for a co-player is dropped.
3. **Co-players' moves** (`src/coplayer.mjs`). Each co-player seated in the window gets its own model call with its
   own context. It speaks (in character or out of character), rolls (`.ra`, `.rc`, `.r` or `.sc`, rolled by the
   platform's dice against its own sheet), or passes.
4. **The Keeper answers the co-players at once.** If any co-player acted, a follow-up GM round runs in the same turn,
   so a co-player's choice gets its consequence now, not at the next human line. The GM prompt says every player,
   co-players included, needs an immediate response that propels the story.
5. At most `MAX_ACTIONS_PER_TURN` lines are posted per turn. Lines the client posted never start a turn by themselves.

The client never opens scenarios or decides memory proposals; those stay with the human Keeper in the web app. When the
story should move on, the GM model leaves a Keeper-only note.

## Timelines and autonomy

The table does not always wait for a human.

**Timelines.** Investigators may be living different threads of the story. The client keeps timelines in its state
file (the platform has none): every player character and co-player is in exactly one, and the main timeline always
exists. A timeline can be bound to a window: a **side window** that only co-players sit in (the Keeper account is its
only user member, so players never see it). Timelines are not windows, though: even in the Main Chat, a co-player back
from a side trip speaks from what it lived there. The GM context has a Timelines section and every chat line is tagged
with the timeline it comes from, with the rule that a line from another timeline is a story *about* that thread, not
something happening in this scene, and that knowledge crosses timelines only when someone who was there tells it.

A co-player's seat in a window has a start and an end. It hears a window's lines only while it sits there. After a
side trip it remembers the side window and the Main Chat from its return, so it can tell the party what it saw, and
only that. It is told its own timeline's name, time and place; never the Keeper's notes.

The GM model splits and rejoins by itself (`split`, `rejoin`, `timeline` actions). You can also do it by hand, even
while `run` is running (it reloads the state file):

```bash
node src/cli.mjs split --channel <id> --name "The docks" --coplayers "Harriet Vance,Tomas Leclerc" --location "Old Harbour" --time "Tuesday night" --opening "Fog hangs over the harbour."
node src/cli.mjs rejoin --channel <id> --timeline "The docks"
node src/cli.mjs status --channel <id>        # timelines, seats, autonomy settings
```

**Autonomy.** On its own clock (`AUTONOMY_TICK_MS`) the table also runs:

- **side** turns: a side window moves on, turn after turn, every `AUTONOMY_SIDE_INTERVAL_MS`, with no human line. The
  co-players drive the thread; the GM runs the world and answers them at once;
- **quiet** turns: a window with human players that has been silent for `AUTONOMY_QUIET_MS` moves on a little: the
  world, the NPCs, a question to a named player, the co-players. The GM is told never to decide, speak or roll for a
  player character; the client enforces it too. After `AUTONOMY_QUIET_TURNS` quiet turns the window waits for a human
  again. Only windows where a human spoke recently are moved.

Autonomy pauses when no human has posted in the channel for `AUTONOMY_IDLE_MINUTES`, is capped at
`AUTONOMY_MAX_TURNS_PER_HOUR`, never runs while a human's turn is pending, and any human line wakes the table up.
`AUTONOMY=false` turns it off.

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
| `STATE_DIR` | `--state-dir` | `./.state` | the state file: co-players, real NPCs, seats and timelines |

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
- Co-players start in the windows of `COPLAYER_WINDOWS` and move only through `split` and `rejoin`. A private window
  the Keeper creates in the web app does not seat them automatically.
- Timelines live in the client's state file. The platform's own chronicler does not know about them, so a side
  thread's events reach the Keeper documents like any other lines.
- One client process keeps one channel.
