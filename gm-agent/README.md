# gm-agent — an AI Game Master for Acerciae

A Node.js client that sits at an Acerciae table as the **Keeper**. It talks to the platform only through the public
HTTP and WebSocket API (`docs/API.md`), the same contract the web and mobile apps use. It plays three kinds of role:

| Role | On the platform | Who writes it | What its model is given |
|---|---|---|---|
| **GM (Keeper)** | the client's account, channel role `gm` | – | everything the Keeper may read (below) |
| **Real NPC** | an `npc` character | the GM model, when the story introduces one (or the Keeper by hand) | **the same context as the GM** |
| **Story planner** | nothing on the platform | – | the Keeper's whole context plus the previous plan, in the background, with its own model |
| **Co-player** | a GM-cast PC: a `pc` character owned by the client's account | **the LLM writes its COC7 role card** at setup (or the Keeper made it by hand) | **only the chat log its character witnessed**, plus its own card and persona and its companions' basic details and backgrounds |

Co-players are AI investigators who play *alongside* the human players. You choose how many (`--coplayers N`). On the
platform they are PCs cast by the GM: player characters owned by the client's own (Keeper) account, so players see them
in the character list and can read (not edit) their sheets, and Log Studio files their lines as investigators' lines.
Every PC the Keeper account owns is a co-player: `setup` adopts the ones already in the channel (made by hand in the web
app, say) and generates only the missing ones. Inside this client co-players are separate from the real NPCs: they get
different context, and the GM model is never allowed to speak for them.

The platform's own AI never speaks in chat. It writes tips for the Keeper: the pinned board, reminder bubbles, script
knowledge, documents, highlights and module hints. This client reads those tips for the GM and the real NPCs. Co-players
never get them.

## What each role sees

**GM and real NPCs** (one shared context, built per turn by `src/context/gmContext.mjs`):

- every line in every chat window, including Keeper-only notes, whispers and hidden rolls (older history as compacted
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

**Each co-player** (`src/context/coplayerContext.mjs`). The client signs in as the Keeper, who can read every line, so
it applies the platform's player filter itself. A co-player gets only:

- lines in the windows it sits in (the Main Chat by default);
- lines with `window` visibility, and whispers addressed to its own character.

It never gets `gm_only` lines (Keeper notes, hidden roll results), whispers to anyone else, other windows, or any
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
- the relationships it is part of, and the public ones between people it knows.

It never gets a real NPC's brief, an NPC it has not met, a secret relationship it is not part of, or anyone's
characteristic and skill numbers.

## Long campaigns: memory, compaction and caching

The client keeps its own data store: one SQLite file per channel, `STATE_DIR/<channel>.db`, built into Node (no extra
package). It holds:
- a local copy of the chat as the Keeper reads it, fetched once, with any gap filled after the table was down;
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
  written in the first person, only from the lines it witnessed. They never include Keeper notes, others' whispers or
  another timeline's lines, and no one else reads them.
- **Keeper documents** keep their newest entries when they are too long; a note says how many older ones were left
  out.

Compaction runs beside the turns, so a turn never waits for it.

**Prompt caching.** Every prompt is laid out stable-first, and providers cache the prefix:
1. The fixed rules.
2. Parts that change rarely: campaign, world setting, cast, scenarios, chapters.
3. This window's older lines, in frozen chunks of 50.
4. Parts that change every few turns: hidden truths, timelines, Keeper board and documents.
5. This turn's details: the scenario's event count, reminders, tips, the newest lines, the instruction. These come last
   and are never cached.

Providers:
- **Anthropic** gets cache markers with a one-hour lifetime by default (`llm.cache_ttl: 1h|5m|off`).
- **OpenAI's own API** gets a `prompt_cache_key` per purpose. Other compatible gateways rely on the stable order alone.

One player line costs several calls (the GM, each co-player, a follow-up), and they share most of their prompt.

**Usage.** Every call's input, cache reads and writes, and output tokens are recorded. `status` shows today's and the
week's totals and the share of input read from cache. `context.daily_token_budget` caps billable-equivalent tokens a day
(cache reads count a tenth); once it is spent, the table stops starting turns of its own, and answers to players still
run.

**The living world.** The platform keeps the world record itself: its observer tracks what is true about each person,
place, group and item now (active, missing, dead, destroyed; a short state; where it is), with a history of changes.
The client works with it in three ways:
- **Reading it.** The GM and real NPCs get it as "The world now" in their context.
- **Declaring changes.** When the world moves on where play does not show it (off-screen, between visits, while the
  investigators are elsewhere), the GM records the change with a `world_change` action. A secret declaration stays
  Keeper-only. Declarations never appear in chat.
- **Improvisation mode.** The world setting and the Keeper's secrets are handed to the record once per version of the
  text, so the observer knows the places, groups and people from the start. Hidden truths the GM decides are declared
  as secrets too, so a human Keeper sees them in the web app.

Co-players never read the record. They know only what their characters witnessed and the public world setting. A
platform without the record (404) is noted once, and the table carries on with its own notes.

## How a turn runs

1. A real person posts a line in a window. After `pacing.debounce_ms` of quiet, one turn starts.
2. **The GM's move** (`src/director.mjs`). One model call with the GM context returns the Keeper's actions:

   | Action | What happens |
   |---|---|
   | `narrate` | posts narration |
   | `npc` | a line from a real NPC |
   | `world_change` | a change to the world the chat does not show, recorded by the platform's world record (`secret` keeps it Keeper-only) |
   | `truth` | improvisation mode: a hidden fact the GM just decided, kept for later turns and declared as a secret |
   | `text` | casual mode: a real NPC texts a player character's phone |
   | `planner_note` | a word for the story planner: what the players did that changed the plan, or that the beat is done |
   | `date` | casual mode: moves the story's calendar on (`advance_days`, the time of day) or to a later YYYY-MM-DD date; never backwards |
   | `bond` | records, changes or ends a relationship between two characters (`secret`: the investigators do not know it) |
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
5. At most `pacing.max_actions_per_turn` lines are posted per turn. Lines the client posted never start a turn by themselves.

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
  (`timelines.guard_turns`, `timelines.guard_ms`). Players' own moves are never deferred.
- **No history leaks.** Nobody is ever added to an existing window (its whole past would open to them). A player
  joining a thread whose window they are not in regroups the thread into a fresh window. A window is reused only for
  exactly the same people at the same place.
- **Bounded.** At most `timelines.max_active` threads at once; a new window for a player at most once per
  `timelines.pc_cooldown_ms`; at most `timelines.max_arrivals_per_hour` arrival turns; arrivals never start further
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
stage done, or the platform's own "New scenario?" reminder. The client refuses, with a Keeper-only note saying why,
unless:

- the turn is in the **Main Chat**, never in a split window;
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

**Costs.** Every player split creates a window with that player as a member; the platform then rebuilds that player
group's derived memory (journals, reminders) and web clients refresh. Every split or reunion also costs an arrival turn
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
  investigators would not know it), and writes how the next session should open. The Keeper gets a Keeper-only note;
  the first GM turn of the next session is told how many days passed, what happened off-screen and how to open. Ctrl-C
  on `run` waits for the review; a second Ctrl-C skips it.
- **It reviews itself.** One run is three calls in one conversation, so the big context is cached once: a draft; a
  critique by "a second Keeper, a harsh script editor who did not write this" (what is boring, implausible or contradicts
  the world and the truths, which threads are stale or should be merged, whether the beat is done, whether the verdict
  is honest); and a revision that must fix every fault. The critique is kept with the plan.
- **It dares.** In improvisation mode it invents original plots, weaves several into one situation and raises the
  stakes, within the world setting and the hidden truths; each invention is a secret twist the GM reveals through play.
- **Co-players get impulses.** Each co-player may get one private urge, written in character ("you want to see the
  docks tonight"), shown only to it as its own thought and dropped after `planner.impulse_lines` lines. An impulse that
  quotes a secret or a truth, or talks about the game itself, is discarded. The GM sees only who got one.
- **Module-led campaigns: pace only.** With a module, the planner invents nothing and judges only when to let an event
  go.
- **The Keeper sees it.** Every new plan version is announced once as a Keeper-only note in the Main Chat; `status`
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

Calendar features beyond the date and the routine are not part of this stage.

```bash
node src/cli.mjs date --days 2 --time morning
```

```bash
node src/cli.mjs date
```

**What is striking about people.** Characteristics are never shown as numbers. The extremes are turned into words
(`src/context/traits.mjs`): 80 and above is "extremely good-looking, striking" for APP or "extremely intelligent" for
INT. Near the bottom of the range is the opposite, such as "very plain" or "slow-witted": 25 for STR, CON, DEX, APP and
POW, and 45 for SIZ, INT and EDU, which start at 40. Luck is left out. At most three traits are given, the most extreme
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
- **`secrets.md`, the Keeper's hidden layer** (optional): what is really going on. Only the GM and the real NPCs read
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
  horror. A module-led campaign stays Call of Cthulhu as such.

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
- **First contact.** The GM may have an NPC text a player (a hook, news, an invitation), and a co-player may text a
  player instead of speaking in the scene.
- **Who knows what.** A text never starts a scene turn and never moves anyone between scenes. The GM reads every
  phone; a co-player knows only the messages it sent or received.
- **Privacy.** Phones are private only on an **isolated** channel with one player per group, so casual mode stays off
  anywhere else. Create the channel with knowledge mode *isolated* in the web app (with `setup --create --casual`, a
  new channel is made isolated).

`status` shows the phones and the texts still on their way.

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
and make the Keeper account its GM (channel members → role GM). Then:

```bash
node src/cli.mjs setup --channel <CHANNEL_ID> --coplayers 2
```

Without `--channel`, `setup` lists the channels the account is GM of and asks which one to keep (or, with none, says how
to create one). The client never creates a server, a channel or an invite code on its own. If you want it to anyway (for
scripts and tests), `setup --create` makes a new server and channel, prints an invite code for the players, and uses
`channel.server_name`, `channel.channel_name` and `--era`:

```bash
node src/cli.mjs setup --create --coplayers 3 --era 1920s
```

`setup` prints the channel id. Add the players to the channel in the web app, or with `POST /api/channels/{id}/members`.
Every setup first checks existing co-players on the
platform: it fills missing appearance prompts, basic information, characteristics and background fields while preserving
filled values (including current HP/SAN). Complete characters are skipped without a model call. It then creates only
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
| `account.username`, `account.display_name` | `--username`, `--display-name` | –, `AI Keeper` | the Keeper account the client signs in as (its password: `GM_PASSWORD`) |
| `account.register` | `--register` | `false` | register the account when sign-in fails |
| `channel.create` | `--create` | `false` | let `setup` create a new server and channel (and an invite code) instead of keeping one the account is GM of |
| `channel.server_id`, `channel.server_name`, `channel.channel_name`, `channel.era` | `--server`, `--server-name`, `--channel-name`, `--era` | | used only with `--create` |
| `table.coplayers` | `--coplayers` | `2` | number of co-players (0–8) |
| `table.coplayer_windows` | `--coplayer-windows` | Main Chat | window ids or names the co-players sit in |
| `table.language` | `--language` | server language | language of everything the client writes |
| `table.kickoff`, `table.verbose` | `--kickoff`, `--verbose` | `false` | open the session without waiting; log every post |
| `llm.provider` | `--llm-provider` | `anthropic` if `ANTHROPIC_API_KEY` is set, else `mock` | `anthropic`, `openai_compatible` (the OpenAI Responses API) or `mock` |
| `llm.model` | `--llm-model` | `claude-opus-5-5` for Claude | model id |
| `llm.api_base` | `--llm-api-base` | | the endpoint (`openai_compatible`); the key is `LLM_API_KEY` or `ANTHROPIC_API_KEY` |
| `llm.effort` | `--llm-effort` | `medium` | Claude effort (`low` … `max`) |
| `llm.fallbacks` | `--llm-fallbacks` | `true` | Claude: re-run a declined request on Anthropic's recommended fallback model |
| `llm.trace` | `--llm-trace` | – | append every model request and reply to this JSONL file, to audit what each role was shown |
| `llm.stream` | `--llm-stream` | `true` | OpenAI Responses: streaming replies; `false` only if the endpoint does not support it |
| `llm.timeout_ms` | `--llm-timeout-ms` | `600000` | client request deadline; this does not extend a gateway's own timeout |
| `llm.cache_ttl` | `--llm-cache-ttl` | `1h` | Anthropic prompt-cache lifetime: `1h`, `5m` or `off` |
| `planner.enabled` | `--planner` | `true` | the story planner (see "The story planner") |
| `planner.provider`, `planner.api_base`, `planner.model` | `--planner-provider`, `--planner-api-base`, `--planner-model` | the GM's | the planner's own model and endpoint (its key: `PLANNER_API_KEY`, else the provider's key) |
| `planner.effort` | `--planner-effort` | `high` | the planner's reasoning effort (ignored by `openai_compatible`) |
| `planner.interval_minutes`, `planner.min_lines` | | `30`, `40` | play time and lines since the last plan before an automatic one (`interval_minutes: 0`: only `plan now`) |
| `planner.cooldown_minutes`, `planner.max_runs_per_hour` | | `10`, `4` | least gap between runs; hourly cap |
| `planner.stall_turns` | | `6` | turns in the same place with no world change, truth, move or scenario change before the planner is asked |
| `planner.impulse_lines`, `planner.plan_tokens` | | `60`, `1500` | how long a co-player's impulse lives; budget of the GM's "Story plan" section |
| `planner.final_review`, `planner.final_review_min_lines`, `planner.final_review_max_days` | `--final-review`, `--final-review-min-lines`, `--final-review-max-days` | `true`, `10`, `30` | the review when a session of human play ends: on or off, how many player lines a session needs, how many story days it may move the calendar |
| `pacing.debounce_ms`, `pacing.post_delay_ms` | `--debounce-ms`, `--post-delay-ms` | `4000`, `1200` | quiet time before a turn; pause between posted lines |
| `pacing.max_actions_per_turn` | `--max-actions` | `6` | lines per turn |
| `context.gm_tokens`, `context.coplayer_tokens` | | `60000`, `24000` | context budget for the GM and for each co-player; older history is compacted into chapters |
| `context.page_lines`, `context.backfill_lines` | | `100`, `1000` | lines fetched per page when syncing the local copy of the chat; how far back the first sync goes |
| `context.daily_token_budget` | | `0` (off) | billable-equivalent tokens a day; once spent, no autonomous turns or plans until tomorrow |
| `autonomy.enabled` | `--autonomy` | `true` | side timelines and quiet windows move on the table's own clock |
| `autonomy.tick_ms` | | `30000` | how often the table looks for a window that should move |
| `autonomy.side_interval_ms` | | `90000` | pause between turns in a side window |
| `autonomy.quiet_ms`, `autonomy.quiet_turns` | | `180000`, `2` | silence before a shared window moves on, and how many such turns until a human posts again |
| `autonomy.max_turns_per_hour`, `autonomy.idle_minutes` | | `20`, `30` | hourly cap on autonomous turns; "away" once nobody has posted for this long |
| `autonomy.away_side_interval_ms` | | `21600000` (6 h) | while away, how often a co-players-only thread moves (0: never) |
| `timelines.auto` | `--timeline-auto` | `true` | the GM reports whereabouts and the table splits and reunites the party; `false`: model-led co-player splits |
| `timelines.guard_turns`, `timelines.guard_ms` | | `2`, `180000` | a co-player's move that undoes a recent change waits for two agreeing turns within this window |
| `timelines.max_active` | | `4` | at most this many threads at once (the main one included) |
| `timelines.pc_cooldown_ms` | | `300000` | a player gets a new window at most this often |
| `timelines.max_arrivals_per_hour` | | `12` | arrival turns (opening a new or changed scene) per hour |
| `scenarios.auto` | `--scenario-auto` | `true` | the GM opens the next scenario itself (from the Main Chat only) |
| `scenarios.min_minutes`, `scenarios.min_lines` | | `20`, `30` | the current scenario must be at least this old and this long before the GM changes it (lifted when the planner says move on) |
| `modes.improv` | `--improv` | unset | improvisation mode (with `setup` or `world`; then kept in the state file) |
| `modes.world_file`, `modes.secrets_file` | `--world`, `--secrets` | | your world setting and the Keeper's secrets, read by `setup` and `world` (relative to the file) |
| `modes.casual` | `--casual` | unset | casual mode, phones for the player characters (with `setup` or `casual on/off`; then kept in the state file) |
| `modes.casual_max_delay_minutes` | | `240` | longest delay before an NPC's or co-player's reply to a text |
| env `ACERCIAE_API_BASE` | `--api` | `http://localhost:8080` | backend address |
| env `CHANNEL_ID` | `--channel` | – | the channel to keep; without it `setup` lists the channels the account keeps and asks |
| env `STATE_DIR` | `--state-dir` | `./.state` | the state file, the SQLite store, the lock and the command inbox |
| env `GM_PASSWORD`, `ANTHROPIC_API_KEY`, `LLM_API_KEY`, `PLANNER_API_KEY` | | | secrets |
| env `GM_AGENT_CONFIG` | `--config` | | where `gm-agent.yml` is |

**Mock mode.** `llm.provider: mock` writes labelled placeholder text (`[mock Keeper] …`). It exercises every pipeline
without a provider. It is for tests and demos, not for play.

During setup, the CLI prints which co-player it is generating and reports elapsed time every 15 seconds while waiting
for the model. HTTP 504 means the model gateway timed out, even if the client's deadline has not expired. Streaming
can keep an idle-timeout gateway connection active once the model starts sending data, but cannot fix an unavailable
upstream or a gateway's absolute request deadline. After a failure, run setup again; it keeps previously saved co-players.

**Recovering a lost roster.** If the state file is lost, the roster is rebuilt from the channel's characters: PCs owned by
the Keeper account are co-players and every NPC is a real NPC (including ones the Keeper makes in the web app).
Co-players made by older versions are NPCs whose speaking style starts with `[co-player]`; they are still recognised,
because the platform cannot change a character's kind.

## Tests

```bash
npm test
```

The tests need no backend and no model. They cover:

- the co-player filter (Keeper notes, other characters' whispers, other windows and AI tips never reach a co-player);
- role-card checks;
- a whole turn against an in-memory platform, with the mock model recording every prompt;
- the request shape of the Claude and OpenAI Responses providers;
- the configuration file and its precedence;
- the story planner: triggers, the three-step review, the plan's place in the GM's context, impulses and their
  privacy, pace-only in module play, the lifted pace guard, no run while nobody is at the table, and the final review
  after a session;
- the calendar, the distinctive traits and the relationships, and which role reads which of them.

## Known limitations

- **Co-player lines count as Keeper lines.** They are posted by the Keeper account, so the platform records them with
  `actor_role = gm`. The platform's chronicler accepts GM-authored lines as grounds for `confirmed` facts, so a
  co-player's in-character guess may be recorded as established. Log Studio and the players' group memory count them
  as the investigator's lines (the character is a PC); the Keeper-side observers, reminders and script tracking still
  see a Keeper line.
- The story planner's impulses are planner text in a co-player's prompt: quoted, capped and filtered, but not provably
  inert. Its stall detector counts turns, so a long, talky scene can cost one extra advisory run. The GM may ignore the
  plan, and a plan can change every ten minutes: the "Story plan" section re-caches each time (parts A and B do not).
- The era check reads years from the channel's era text only. An era with no year in it ("Victorian") is not
  checked.
- The calendar is the campaign's: a long split shares one date, and each thread keeps only its own time of day.
  Traits come from the characteristics alone, so a background that says otherwise ("a plain face") is not reconciled.
- The final review on Ctrl-C makes three planner calls before `run` exits; with a slow model at high effort that can
  take minutes (a second Ctrl-C skips it). If the client was down when the players left, the review runs at the next
  start, unless a player writes first.
- Co-players start in the windows of `table.coplayer_windows` and move only through whereabouts (or `split` and `rejoin`). A
  private window the Keeper creates in the web app does not seat them automatically and is not part of any thread.
- Timelines live in the client's state file. The platform's own chronicler does not know about them, so a side
  thread's events reach the Keeper documents like any other lines.
- A split-off player stays a member of the Main Chat (as intended), so the platform keeps delivering the Main Chat's
  lines to them and its chronicler credits their character with them. A player who leaves a thread's window can still
  read it.
- Windows accumulate over a campaign: the platform has no way to rename, archive or delete one. Retired windows are
  reused only for the same people at the same place.
- One client process keeps one channel.
