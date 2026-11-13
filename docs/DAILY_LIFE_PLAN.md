# Daily life: unattended casual play and passive presence

Implementation plan. Status: designed, nothing built yet.

## 0. How to use this document

This plan is written for the engineer or coding agent who will implement it.

- **Section 2 is the design.** Its rules were decided with the project owner. Do not redesign them. If a rule turns out
  to be impossible, stop and report instead of choosing a different behaviour.
- **Section 5 lists details the owner has not explicitly confirmed.** Implement them as written unless the owner
  struck them out before handing this over.
- **Sections 6 to 8 are the work.** Each work package is usable on its own and should be one reviewable change with
  its tests. Build them in order.
- File and function names were checked against the repository when this was written. Line numbers drift: trust the
  names.

Read these first:

| File | Why |
|---|---|
| `gm-agent/README.md` | The GM agent's whole behaviour. Sections "Timelines and autonomy", "The story planner", "Time and people", "Casual mode: phones". |
| `gm-agent/src/table/scheduling.mjs` | `onMessage`, `schedule`, `tick`, `overBudget`, `startTicker`: where turns start. |
| `gm-agent/src/loop.mjs` | `Table`, and `turn()` with its inner `round()`: the order GM → co-players → GM follow-up. |
| `gm-agent/src/calendar.mjs` | The story date, the pace guard, the routine. |
| `gm-agent/src/timelines.mjs` | Threads; each has a free-text `narrativeTime`. |
| `gm-agent/src/coplayer.mjs`, `gm-agent/src/table/coplayers.mjs`, `gm-agent/src/context/coplayerContext.mjs` | How an AI player is given only what its character witnessed. The stand-in reuses this. |
| `gm-agent/src/director.mjs` | The GM's rules, actions and turn modes (`MODE_NOTES`, `AWAY_RULE`, the `RETURNING` note). |
| `gm-agent/src/casual.mjs`, `gm-agent/src/table/social.mjs` | Phones: `onPhoneLine`, `ensurePhones`. |
| `gm-agent/src/planner.mjs`, `gm-agent/src/table/planning.mjs` | The plan's threads, the final review, `moveCalendar`. |
| `gm-agent/src/config.mjs`, `gm-agent/src/host-schema.mjs`, `gm-agent/src/host-status.mjs` | Configuration keys, the web UI's settings form, the status page. |
| `backend/src/chat/Messages.cpp`, `backend/src/chat/ChatQueries.cpp` | Posting and recalling chat lines. |
| `docs/API.md`, `mobile/contracts/INTEGRATION.md` | The API contract and how mobile follows it. |

## 1. Goal and assumptions

**Goal.** A casual, daily-life roleplay that moves on slowly when nobody is at the table, or when some players are
absent, and still makes sense to a player who returns after hours or days.

**Assumptions the owner set.**

1. **Players are trustworthy.** Only friendly people sit together. Nothing here guards against players. Every guard
   is aimed at the AI side: the GM, the NPCs, the co-players and the stand-ins.
2. **The daily routine is the stage.** School and work are where the story happens, so "she is at work" is not an
   excuse for a character's absence. An absent player's character stays in the story.
3. **Casual games only.** Module-led games have complex plots and need everyone online. They are not changed.

## 2. The design

### 2.1 Words

| Word | Meaning |
|---|---|
| Scene line | A human player's line in a scene window. Not a phone text, not a line in the planner window. It is a line for which `isTrigger(m)` is true and `isTableWindow(m.chat_window_id)` is false. |
| Attended | A human wrote a scene line less than 2 real hours ago. |
| Unattended | No scene line for 2 real hours. The timetable drives the clock and sparks may happen. |
| Paused | No human message of any kind for 7 real days. Nothing moves. |
| Timetable | The map from real time to story time while unattended. |
| Spark | An AI character breaks the silence with a small daily-life topic. |
| Whistle | The replies to a spark: other characters answer and the GM narrates. |
| Passive presence | The state of a player character whose player is away: present, but doing nothing adventurous. |
| Stand-in | The separate model that writes a passive character's lines. A stand-in line is such a line. |
| `/away` rule | What a player allows and forbids for their character while passive. |
| Day turn | The moment the story date changes. |
| Open question | Something a passive character deferred ("let me think about it"). It waits for the player. |
| Thread owner | A player character a plot thread is about. |

### 2.2 Scope

- The feature is off unless `daily.enabled` is true. It works only when casual mode is on (`table.casualOn()`) and
  the game is improvised, with no module. Anywhere else it logs once and stays inactive.
- With the feature off, behaviour and every prompt must be exactly as today (see section 9, prompt cache).

### 2.3 The clock

1. **One date, a clock per thread.** The story keeps one date for the whole campaign, as today. Each thread keeps its
   own time of day. Today that time is free text; this plan adds a real clock (minutes since midnight) beside it.
2. **Attended: the GM moves time.** The GM moves the time of day freely, forward only. The GM may move the date by one
   day at a time, and only when the current story day has lasted at least 3 real hours (`daily.min_day_minutes`).
3. **The silence.** After the last scene line, story time stands still for 2 real hours (`daily.silence_minutes`).
4. **Unattended: the timetable moves time.** When the silence ends, the system builds a timetable that starts at the
   story time where play stopped and flows evenly: one story day per 17 real hours (`daily.day_hours`). 17 shares no
   factor with 24, so over time the story's morning falls on every real hour; a real week is about 10 story days.
5. **Lagging threads catch up.** If threads are at different times when the timetable starts, it starts from the
   latest one, and the others are brought forward ("class ends and everyone leaves for the next room").
6. **Nights are quiet.** Between `daily.night_start` and `daily.night_end` (story time) there are no sparks. Time
   still flows.
7. **Joining ends the night.** If a player writes a scene line during an unattended night, it becomes the morning
   (`daily.night_end`) at once. This is exempt from the 3-hour rule.
8. **Only a scene line is joining.** A phone text or a planner-window line does not end the night, does not stop
   sparks and does not end the silence.
9. **The pause.** After 7 real days (`daily.pause_days`) with no human message of any kind (phone and planner window
   included), sparks stop and the clock stops. The next human message starts it again from where it stopped.
10. **Time never runs backwards**, for the date or for any thread.

### 2.4 Sparks and whistles

1. **Only when unattended.** Sparks never happen while a human is taking part. The first spark comes when the 2-hour
   silence ends.
2. **Who sparks.** A random co-player in a random scene. A passive player character may spark only if the table
   setting `daily.pc_sparks` is on and that player's `/away` rule permits it.
3. **What a spark is.** Small daily-life talk that fits the story time, the place and the routine: gossip, a small
   plan, something noticed. A spark never advances a plot thread, reveals a secret, starts danger, changes a
   relationship, moves anyone to another scene or changes the scenario.
4. **The whistle.** Other AI characters in the scene may each reply once, and the GM narrates briefly as the world and
   the NPCs.
5. **The time check.** After each exchange the GM says whether the topic has ended.
   - Ended: the thread's clock moves to the time the timetable shows now.
   - Not ended: the clock stays, and the next spark in that scene may continue the topic.
6. **The urge.** When a thread has fallen more than `daily.max_lag_minutes` behind the timetable, the GM is told to
   finish the topic or carry it into the next part of the day ("class is over, they still gossip in the break").
   After that exchange the clock moves to the timetable's time in any case.
7. **How often.** `daily.sparks_per_day` is the number of sparks per real day. They are spread over the hours that are
   not story night, with some randomness.
8. **When the budget is tight.** Sparks are told to be concise and come less often. When the daily token budget is
   spent there are none. Answers to players are never cut.

### 2.5 Passive presence

1. **When.** A player character becomes passive when its player writes `/away`, or has written no scene line for
   30 minutes (`daily.passive_minutes`). Any scene line from that player ends it.
2. **Everyone can see it.** The platform shows a mark on a passive character.
3. **What a passive character is.** Present in the scene. Friends remember them, greet them, save them a seat and text
   them. Close relations persist.
4. **What it does.** It answers small things. It does nothing adventurous. When something matters, it defers
   ("let me think about it") and the question waits for the player.
5. **When it cannot defer**, it takes the least bad option, in this order: follow a trusted friend, do what the routine
   implies, stay where it is.
6. **Relations are frozen** in both directions: no confession, no breakup, no big quarrel, with anyone.
7. **Fixed limit.** A passive character never changes its relationship with another player's character, whatever its
   `/away` rule says.
8. **The AI side is considerate.** The GM, NPCs and co-players never aim a confession, a quarrel, an accusation, a
   secret or a plot twist at a passive character, never press it to decide, never let harm befall it and never make a
   scene wait on it.
9. **The GM still never speaks for a player character.** A passive character's lines come only from its stand-in.

### 2.6 Stand-in lines

1. **A separate model call**, given only what that character witnessed, its role card, its relationships, its phone,
   and its player's `/away` rule. It gets nothing from the GM's side.
2. **It speaks when spoken to.** It writes one short line when someone addresses the character, or when it sparks.
   It never rolls dice, never texts, never moves the character on its own.
3. **While its player is typing in that window, it holds back.**
4. **Every stand-in line is marked** on the platform, and the character's owner can take it back at any time.

### 2.7 The `/away` rule

1. The player writes it in their character's phone: `/away` followed by free text in their own words.
2. `/away` alone makes the character passive now and shows the current rule.
3. Three levels:

   | Level | Examples | Who decides |
   |---|---|---|
   | Always allowed | being present, small talk, the daily routine | fixed |
   | Allowed only if the rule says so | accepting invitations, going out with named friends, sharing certain information, starting small talk | the player's rule |
   | Never | serious harm, revealing the character's secrets, changing a relationship with another player's character | fixed |

4. What the rule forbids always wins.

### 2.8 Summaries and the return

1. **A summary per person, per story day**, from that character's own point of view, built only from what the
   character witnessed.
2. **Every private message to a player goes to their phone as a GM message**: day summaries, open questions, the
   answer to `/away`.
3. **On return** the GM welcomes the player in a sentence or two and hands them the scene. The phone already holds the
   story they missed and the questions waiting for them.

### 2.9 Thread owners

1. The story planner names each thread's owners: the player characters the thread is about.
2. A player joins or leaves a thread by saying so in the planner window.
3. A thread advances only when one of its owners is present (not passive).
4. The planner marks a thread's turning point and its ending as "owners must be present": those wait for every owner.
5. An owner who has been away 7 real days (`daily.pause_days`) no longer blocks: the present owners may go on.

### 2.10 Cost

1. Cost is set by sparks per real day and by the daily token budget.
2. Both are edited in the GM agent's web UI.

## 3. What exists today

| Need | What the code has | Gap |
|---|---|---|
| Know nobody is there | `table.lastHumanAt`; "away" after `autonomy.idle_minutes` (30) in `tick()` | Two new thresholds (2 hours, 7 days), kept across restarts |
| Move the world while away | Co-players-only threads move every `autonomy.away_side_interval_ms` (6 h) | Replaced by sparks when the feature is on |
| Story date | `calendar.mjs`: date, free-text time, pace guard (`calendar.min_minutes`, `min_lines`, `max_days`) | No real clock; no timetable |
| Time-change note | `sceneHandoff` in `continuity.mjs`, posted by `postHandoff` in `table/windows.mjs` | Reused as is |
| Absent characters | `AWAY_RULE` in `director.mjs`: stays in the scene, passive, GM never acts for it; `awayOf()` in `table/context.mjs` | No stand-in, no visible mark, no rule from the player |
| Welcome back | `RETURNING` note in `directTurn` (`director.mjs`), fed by `table.returning` set in `noteLine` (`table/recovery.mjs`) | The note has no content about what was missed |
| An AI player with limited knowledge | Co-players: `coplayerTurn`, `coplayerLog`, `visibleToCoplayer` | Reused for stand-ins |
| GM posts as a player's character | Allowed by the backend (`ChatService::postMessage`, `Messages.cpp`): the GM may use any `character_id` | The line looks like the player's own; only the author can recall it, within 120 s |
| Private channel to a player | Casual mode phones: one private window per player character (`casual.phones`) | Reused |
| Player commands | `/pause`, `/画` and `/draw` in the planner window (`pauseCommand`, `artCommand`) | `/away` in the phone |
| Between sessions | The final review moves the calendar and writes how the next session opens (`applyBetween`) | Must stop moving the date when the feature is on |
| Plot threads | Planner threads with `stakes`, `hooks`, `twist`, `ripeWhen` (`planner.mjs`) | No owners |
| Cost | `context.daily_token_budget` and `overBudget()`; usage per purpose in SQLite | Spark rate; a "tight" level |
| Who is online | Typing flags only (`typing.changed`), in memory | No passive status |

## 4. Configuration and state

### 4.1 New keys (section `daily` in `gm-agent.yml`)

| Key | Default | Meaning |
|---|---|---|
| `daily.enabled` | `false` | The whole feature. Needs casual mode and improvisation. |
| `daily.day_hours` | `17` | Real hours per story day while unattended (1 to 168). |
| `daily.min_day_minutes` | `180` | Attended: the least real time a story day lasts before the GM may end it. |
| `daily.silence_minutes` | `120` | Real time after the last scene line before the timetable and the first spark. |
| `daily.night_start`, `daily.night_end` | `"23:00"`, `"07:00"` | Story hours without sparks. |
| `daily.pause_days` | `7` | Real days without any human message before everything stops; also when an absent thread owner stops blocking. |
| `daily.sparks_per_day` | `8` | Sparks per real day (0: none; time still flows). |
| `daily.spark_max_lines` | `6` | Lines one spark exchange may post. |
| `daily.max_lag_minutes` | `120` | Story minutes a thread may fall behind the timetable before the GM is urged to close the topic. |
| `daily.pc_sparks` | `false` | Passive player characters may spark, if their own rule also permits it. |
| `daily.passive_minutes` | `30` | Real time without a scene line before a character becomes passive. |
| `daily.summaries` | `true` | Per-person day summaries in the phones. |
| `context.standin_tokens` | `12000` | Context budget of a stand-in call. |

When the feature is on, `calendar.min_minutes`, `calendar.min_lines` and `calendar.max_days` are not used: the pace is
`daily.min_day_minutes`, no line count, one day at a time. `autonomy.away_side_interval_ms` is treated as 0.

Each key needs: an entry in `SETTINGS` and a parsed value in `buildConfig` (`config.mjs`; add `"daily"` to
`SECTIONS`), a field in `FIELDS` and a group in `GROUPS` (`host-schema.mjs`; labels and help are in Chinese there, for
example group title "日常推进"), a line in `gm-agent.example.yml`, and a row in the README's configuration table.

### 4.2 New state

In the channel's JSON state file, saved like `calendar` and `casual` (one writer, compare-and-swap; see `state.mjs`):

```
calendar.clock            minutes since midnight of the main thread, or null
timelines.list[].clock    the same per thread, or null (= the calendar's)
daily: {
  lastSceneLineAt,        real ms of the last human scene line
  lastHumanAt,            real ms of the last human message of any kind
  lastSceneLineBy: {pcId: ms},
  anchor: {realAt, date, minute} | null,     the timetable; null when attended or paused
  frozen: {date, minute} | null,             where the clock stopped at the pause
  dayStartSeq,            the chat seq at the last day turn
  sparks: [ms],           spark start times, last 24 h
  nextSparkAt, lastSparker,
  topics: {timelineId: {open, title, sparks}},
  passive: {pcId: {since, declared}},
  passiveToday: [pcId],   passive at any time during the current story day
  rules: {pcId: {text, allow: [], forbid: [], maySpark, at}},
  questions: [{id, pc, askedBy, text, windowId, seq, date, at}],
  week: {0..6: text}      the routine per weekday, from the planner
}
```

In the channel's SQLite store (`store.mjs`): a table of day summaries `(character_id, date, text, from_seq, to_seq, at)`.

Both timestamps must be restored after a restart. The 2-hour and 7-day rules may not restart from zero because the
process restarted.

### 4.3 New model purposes

Add to `MODEL_FUNCTIONS` in `gm-agent/src/llm/routes.mjs`, so routing and the usage charts know them:

| Purpose | Function | Used for |
|---|---|---|
| `standin_turn` | `coplayers` | A passive character's line |
| `away_rule` | `readers` | Reading a player's `/away` text into allow / forbid / may spark |
| `day_summary` | `memory` | One character's summary of a story day, and the recap on return |

The GM's part of a spark is a `director` call with phase `spark`. A co-player's spark is a `coplayer_turn` call.

## 5. Details the owner has not explicitly confirmed

These came up while writing the plan. Each is the simplest choice that keeps the decided rules consistent. Strike any
of them before implementation if they are wrong.

1. **The stand-in speaks only when spoken to** (or when it sparks). It does not chat on its own.
2. **The least-bad order** in 2.5.5 and the examples in the three levels of 2.7.
3. **The owner can take a stand-in line back at any time**, with no time limit.
4. **A passive character follows its group when the scene moves.** It may be moved only together with companions from
   the same scene, never alone and never into a scene of its own.
5. **Short splits end at an unattended day turn.** Threads whose span is `short` rejoin the main thread when the
   timetable starts a new story day, so the day begins with everyone in their routine. `long` splits stay.
6. **The final review no longer moves the date** when the feature is on. It still records off-screen changes and how
   to open.
7. **The planner writes the routine per weekday**, so a new story day gets its routine without a model call.
8. **Summaries are written only for characters who were passive during that story day.**
9. **Open questions:** at most 5 per character, dropped after 14 story days.
10. **`/pause` also stops the clock.** While hosting is paused by `/pause`, the timetable does not run.
11. **Stand-in lines are recorded as player lines**, not GM lines, so the platform's chronicler never treats a
    stand-in's words as confirmed by the GM.
12. **Budget levels:** "tight" from 60% of the daily token budget spent (concise, half as often); none at 100%.
13. **Defaults** in 4.1 that were not discussed: `spark_max_lines` 6, `max_lag_minutes` 120.
14. **Chinese aliases** for the commands: `/离开` for `/away`, `/回来` for `/back`.

## 6. Work packages: GM agent

All new behaviour is gated on `daily.enabled` and on the mode being active (2.2). Suggested new files:
`gm-agent/src/daily.mjs` for pure, tested logic (clock maths, modes, spark scheduling, command parsing), and
`gm-agent/src/table/daily.mjs` for the parts that act on the table, in the style of the other `table/*.mjs` modules.

### WP1. The clock

**Goal.** Story time is a real clock. It stands still for 2 hours after play, then follows the timetable; nights and
the pause behave as in 2.3. No sparks yet.

**Changes.**

- `calendar.mjs`
  - Add `clock` to `calendarState`. Add helpers: parse `"HH:MM"` (accept the full-width colon), format, compare
    instants, and show the clock in `describeCalendar` when it is set ("1923-10-02 (Tuesday), 14:20").
  - `advanceCalendar` accepts `by: "timetable"`, which is not held to the pace or to a day limit, and resets
    `cal.since` like any date change.
- `timelines.mjs`: a `clock` per thread, set through `relocate`. In this mode `narrativeTime` holds the same time as
  text, starting with `HH:MM`.
- `gm-agent/src/daily.mjs` (pure)
  - `modeOf(state, now, cfg)` returns `attended`, `unattended` or `paused`.
  - `timetableAt(anchor, now, dayHours)` returns `{date, minute, daysPassed}`.
  - `isNight(minute, cfg)` and `nightEnd(instant, cfg)`.
- `table/daily.mjs`
  - Called from `noteLine` (`table/recovery.mjs`) for human lines: update `lastHumanAt`; for scene lines update
    `lastSceneLineAt` and `lastSceneLineBy`.
  - `clockTick()`, called from the always-on 10-second timer in `startTicker` (the one that calls `deliverDue`), so it
    does not depend on `autonomy.enabled`:
    1. When the silence ends, build the anchor: `realAt = lastSceneLineAt + silence`, story instant = the latest clock
       among active threads. Bring lagging threads forward and post the time-change note in a window whose clock
       jumped by an hour or more.
    2. While unattended, move the calendar to the timetable's instant. Each date crossed is a day turn (WP5 adds its
       work; here only the date moves).
    3. At 7 days, store `frozen` and drop the anchor.
  - On a human scene line while unattended or paused, before its turn is scheduled: apply the timetable up to that
    line, end the night if it is night (2.3.7), set every thread's clock, drop the anchor.
  - On any other human message while paused: build a new anchor from `frozen`.
  - After a restart, compute the mode from the saved timestamps and apply the timetable up to now. Nothing is played
    for the time the process was down.
- `table/context.mjs`: `calendarPaceCfg` returns `{minMinutes: daily.min_day_minutes, minLines: 0, maxDays: 1}` in this
  mode.
- `director.mjs`: in this mode the time rule tells the GM to write every time of day as `HH:MM` in the `time` and
  `narrative_time` fields of `date`, `time_skip`, `timeline`, `advance_scenario` and `whereabouts`, and that the date
  moves one day at a time when the Calendar section says it may.
- `table/actions.mjs`: read `HH:MM` from those fields into the thread's clock. Refuse a time earlier than the thread's
  clock on the same date, with a GM-only note (the existing refusal pattern, see `calendarHeld`). A time without
  `HH:MM` keeps the clock and gets a GM-only note asking for one.
- `table/planning.mjs`: `applyBetween` does not move the date or the time in this mode (5.6), and the final review's
  prompt says so. Drop a stored `planner.between` note once the timetable has moved the date since it was written.
- `table/scheduling.mjs`: in `tick()`, no side turns while away in this mode.
- `host-status.mjs`: a `daily` section with the mode, the story clock, the anchor and when the pause would begin.
- Configuration as in 4.1.

**Acceptance (tests with the injected clock, as `test/loop.test.mjs` does with `now: () => clock.t`).**

- 17 real hours after the anchor, the timetable shows the same time one day later. Over 24 story days the day's start
  lands on 24 different real hours.
- Story time does not move during the 2 hours after a scene line. A phone text does not restart the silence.
- A GM `date` action with `advance_days: 1` is refused before 180 minutes of the story day and accepted after; two
  days at once are cut to one.
- A scene line during an unattended night makes it `night_end`, on the right date, even if the day lasted under
  3 hours. A phone text at night changes nothing.
- After 7 days without any human message the clock stops. A phone text restarts it from the same instant.
- A restart in the middle of the silence, of unattended time and of the pause gives the same clock as no restart.
- The final review moves no date in this mode.
- With `daily.enabled` false, `test/fixtures/prompts.coc7e.json` still matches and no existing test changes.

### WP2. Sparks

**Goal.** While unattended and not at night, AI characters start small topics, at the configured rate, and story time
follows the timetable through the time check.

**Changes.**

- `daily.mjs` (pure)
  - `sparkDue(state, now, cfg, pressure)`: unattended, not night, fewer than `sparks_per_day` in the last 24 real
    hours, and `now >= nextSparkAt`.
  - `nextSparkAt`: now plus the interval, times a random factor between 0.75 and 1.25, doubled when the budget is
    tight. The interval is the non-night share of 24 hours divided by `sparks_per_day`.
  - `pickSpark(candidates, lastSparker, random)`: a random scene and sparker, not the same sparker twice running.
- `Table` takes an injectable `random` (as it takes `now`), so tests are deterministic.
- `table/scheduling.mjs`: `overBudget` stays; add `budgetPressure()` returning `none`, `tight` or `spent` from the same
  numbers.
- `loop.mjs`, `turn()`: a new mode `spark` with `extra.sparker`. Extend `turn()` instead of copying it, so the
  bookkeeping (line budget, recall checkpoints, whereabouts guard) stays in one place. The order in this mode:
  1. No opening GM round.
  2. The sparker acts: `coplayerAct` with a `spark` flag (or the stand-in, WP4).
  3. Every other co-player in the scene gets one turn and may pass.
  4. One GM round, `round("spark")`.
  5. Stop at `spark_max_lines` (half of it when tight, at least 2).
- `coplayer.mjs`: with `spark`, the uncached part of the prompt says that nobody has spoken for a while and asks for
  something small from everyday life at this hour; if the scene has an open topic, to continue it or let it end.
- `director.mjs`
  - `MODE_NOTES.spark`: nobody human is here; answer briefly as the world and the NPCs; daily life only; the limits of
    2.4.3; passive characters are present and are never decided for.
  - In this mode the reply also carries `"topic": {"state": "open" | "ended", "title": "<a few words>"}`.
  - Only `narrate`, `npc`, `note` and `text` are accepted. `text` lets an NPC text an absent player's phone, which is
    how friends remember them. Whereabouts are ignored; illustrations are not offered.
- `table/daily.mjs`
  - After a spark turn, the time check of 2.4.5. When the clock jumps by an hour or more, post the time-change note
    (`postHandoff`); when the budget is tight, post only its heading and make no model call.
  - The urge of 2.4.6: add its sentence to the next spark's GM round in that scene, then move the clock in any case.
  - At the start of a night, close every topic without a model call.
  - A human scene line during a spark turn: finish the model call in flight, post nothing more from that spark, and
    let the human's turn run next.

**Acceptance.**

- No spark in the first 2 hours after a scene line, one at the 2-hour mark, none at story night, none after the
  pause, none during `/pause`, none when the budget is spent.
- Never more than `sparks_per_day` in any 24 real hours.
- A spark turn posts in the order sparker, replies, GM, and never more than `spark_max_lines`.
- A GM reply in spark mode that contains `bond`, `world_change`, `date`, `new_npc` or a scenario change has those
  actions dropped.
- Topic ended: the thread's clock equals the timetable's. Topic open: it stays. Past `max_lag_minutes`: the next GM
  round carries the urge and the clock moves afterwards.
- When tight: the prompts carry the concise instruction and the interval doubles.
- A human scene line between two rounds of a spark stops the rest of it.

### WP4. Passive presence, stand-ins and `/away`

Do WP3 (platform, section 7) first: this package needs the stand-in mark and the passive status.

**Goal.** Rules 2.5, 2.6 and 2.7.

**Changes.**

- `daily.mjs` (pure): parse `/away`, `/away <text>`, `/away clear`, `/back` and their aliases.
- `table/social.mjs`, `onPhoneLine`: handle these commands first, before the `m.kind === "ooc"` return and before
  `@` parsing, only from the phone's owner.
  - `/away <text>`: store the text (at most 1000 characters), read it with one `away_rule` call into
    `{allow, forbid, maySpark}`, make the character passive, and answer in the phone as a GM line with how the rule
    was understood.
  - `/away`: passive now; answer with the current rule.
  - `/away clear`: remove the rule. `/back`: no longer declared away.
  - If the model call fails, keep the text, treat everything in the second level as not allowed, and say so.
- `table/daily.mjs`
  - `isPassive(pcId)`: declared, or no scene line for `passive_minutes`. Replace the use of `awayOf` in this mode.
  - When a character becomes passive or stops being passive: update `daily.passive` and `passiveToday`, and set the
    platform status (WP3). Reconcile every player character at start; clear every mark on a clean stop.
  - `standinAct(windowId, pcId, {spark})`:
    1. Skip if the player is typing in this window (`table.typing`), if the stand-in wrote this character's last line
       with nobody speaking since, or if this character had 12 stand-in lines in the last hour.
    2. Build the witnessed log: lines in windows the player can read, with `window` visibility or whispered to this
       character, respecting the thread the character was in at each line (as `coplayerAct` does with
       `timelines.timelineAt`). Never `gm_only`, never other whispers, never a platform AI tip. Keep the newest lines
       within `context.standin_tokens`; add lexical recall as co-players have.
    3. Call the model (`gm-agent/src/standin.mjs`): the rules of 2.5 and 2.7, the character's card, persona and
       speaking style, bonds (`renderBondsFor`), the phone thread, today's date and routine, the `/away` rule, and
       this character's open questions.
    4. Reply shape: `{"action": "speak", "text": "...", "defer": {"question": "...", "asked_by": "..."} | null}` or
       `{"action": "pass"}`. Anything else is a pass.
    5. Post with `character_id` of the player character and `stand_in: true`. If the answer does not come back with
       `stand_in: true` (an older platform), recall the line, log once and post no more stand-in lines.
    6. Store a deferred question in `daily.questions`.
  - When a stand-in gets a turn:
    - in a human, follow-up or quiet turn: the GM's `spotlight` names the character, or a line of this turn from
      someone else contains its name or first name;
    - in a spark turn: it is the sparker (needs `daily.pc_sparks` and `maySpark`), or the spark or a reply names it.
  - A stand-in line that its owner recalls: remove it from every context as recalls already do, drop its open
    question, post a GM-only note that it was taken back, and start no rollback.
- `director.mjs`
  - In this mode replace `AWAY_RULE` with a passive rule that states 2.5.3, 2.5.8 and 2.5.9.
  - The `spotlight` field may name passive player characters.
  - The existing guard that drops a GM-written line for a player character stays.
- `context/gmContext.mjs`: show passive characters as "(passive, player away 2 h)", tag stand-in lines, and add a short
  section "Waiting for a player's answer" with the open questions. Put what changes every turn in the uncached part.
- `coplayer.mjs`: when someone in the scene is passive, one line in the uncached part: they are here; be warm and
  include them; do not press them to decide; do not start or end anything important with them.
- `table/planning.mjs`, `recordBond` and `adoptPlan`: a bond that would be created, changed or ended for a passive
  player character is refused, with a GM-only note for the GM's own action.
- `loop.mjs`, where `mayMove` is computed in `round()`: a passive player character may be moved only as in 5.4.
- A new GM action `question_done {id}` in this mode, to clear an open question that was answered or no longer matters.

**Acceptance.**

- The stand-in's prompt never contains a GM-only line, another character's whisper, another window's line, a hidden
  truth or the story plan (same style as the co-player filter tests in `test/coplayerContext.test.mjs`).
- A stand-in line is posted with `stand_in: true` as the player's character. A stand-in never posts a roll or a text.
- No stand-in line while the player is typing; none for a character that is not passive.
- A deferral creates an open question; `question_done` removes it; the sixth question drops the oldest.
- `/away` works only from the owner in their own phone, in any message kind, and is never delivered as a text.
- A scene line from the player ends passive and clears the platform mark; a phone text does not.
- The GM's `bond` action touching a passive character is refused with a note; a line the GM writes for a passive
  character is still dropped.
- A passive character is not moved alone by whereabouts.

### WP5. Day turns, summaries and the return

**Goal.** Rules 2.8, and the day-turn work that WP1 left out.

**Changes.**

- `table/daily.mjs`, `dayTurn(endedDate)`, run for every date change (the timetable, the GM's `date` action, the end
  of a night on joining, the operator's `date` command):
  1. For each player character in `passiveToday` that witnessed at least one line since `dayStartSeq`, or gained an
     open question: one `day_summary` call. It is given only that character's witnessed lines of the day, its phone
     texts of the day and which of its lines were stand-in lines. It never gets the GM's context. It returns 2 to 5
     sentences in the second person, in the table's language.
  2. Post to that character's phone as a GM line: a heading with the date, the summary, then the open questions as a
     numbered list written by the code, not by the model. Save the summary in the store.
  3. Set the routine for the new date from `daily.week` when it has that weekday.
  4. If the day turned by the timetable: rejoin `short` threads into the main thread through the existing rejoin
     path, with no arrival turn (5.5).
  5. Drop open questions older than 14 story days. Reset `passiveToday`, `topics` and `dayStartSeq`.
- `planner.mjs`: the plan's `calendar` may carry `week` (a routine line per weekday). Apply it with the same secret
  check as `applyRoutine`.
- The return, when a passive player's scene line arrives:
  - If no day summary covers the time since they left and something happened (a stand-in line, an open question, or
    20 or more witnessed lines), write one recap now with the same call and post it to the phone.
  - Fill the `RETURNING` note in `directTurn` with: how long the player was away in real time and in story days,
    their summaries since then (the newest three), their open questions and how many lines their stand-in spoke. The
    instruction becomes: welcome them in one or two sentences, do not recap at length because their phone has it,
    hand them the scene, raise at most one open question if it comes up naturally.

**Acceptance.**

- A day turn posts one GM line in the phone of each character that was passive that day and witnessed something, and
  nothing for the others.
- The summary prompt contains only lines that character could read.
- The open questions under the summary are exactly those in the state.
- Returning after 3 story days gives the GM a `RETURNING` note with the summaries and questions; returning after
  10 minutes gives the existing behaviour.
- A timetable day turn merges `short` threads and keeps `long` ones.

### WP6. Thread owners

**Goal.** Rules 2.9.

**Changes.**

- `planner.mjs`
  - Each thread gains `owners` (player character names; empty means the thread belongs to the world) and
    `needs` (`"one"` or `"all"`; `"all"` when the thread's next step is its turning point or its ending).
  - The planner's prompt is told who is passive and for how long, to plan the next beats around the characters whose
    players are present, never to place a turning point or an ending while an owner is away, and that a player's
    request in the planner window to join or leave a thread changes its owners.
  - `renderStoryPlan` shows the owners, and a mark computed by the client each turn: `may advance` or
    `WAITS for <names>`. An owner away for `daily.pause_days` real days is not waited for.
- `director.mjs`: one more sentence in the planner rule for this mode: a thread marked WAITS does not advance; it may
  stay visible (a mention, a look, a reminder) but nothing in it develops, is revealed or is resolved.
- In spark mode every thread is shown as not advancing.

**Acceptance.**

- A thread whose only owner is passive is rendered as WAITS; with one of two owners present and `needs: "one"` it may
  advance; with `needs: "all"` it waits; after 7 real days of absence it no longer waits.
- With the feature off, the plan section renders exactly as today.

## 7. Work package: platform (WP3)

**Goal.** A stand-in line is visibly marked and its character's owner can take it back; a passive character is
visibly marked.

**Backend.**

- Migration `backend/migrations/0065_passive_presence.sql` (0064 is the latest):
  - `ALTER TABLE messages ADD COLUMN stand_in BOOLEAN NOT NULL DEFAULT false;`
  - `ALTER TABLE characters ADD COLUMN passive_since TIMESTAMPTZ;`
- `ChatService::postMessage` (`backend/src/chat/Messages.cpp`)
  - Read `stand_in` from the body. Accept `true` only when the caller is the GM, `character_id` names a `pc`, that
    character belongs to another user, the kind is `ic` or `ooc` and the visibility is `window`. Otherwise answer 400.
  - Add the column to the INSERT.
  - For such a line the event's `actorRole` is `"player"` (5.11). `author_id` stays the GM's account.
  - Reads need no change: `MSG_SELECT` (`ChatQueries.cpp`) selects `m.*`, so `stand_in` appears in REST answers and in
    `message.posted`.
- `ChatService::recallMessage`: besides the author within 120 seconds, the owner of the line's character may recall a
  line with `stand_in = true` at any time. The other refusals stay.
- Passive status
  - `PUT /api/channels/{c}/characters/{cid}/presence` with `{"passive": true | false}`. GM only; the character must be
    a `pc`. It sets `passive_since` to now (kept if already set) or to null, and sends the existing
    `character.updated` event.
  - `ChatService::listCharacters` (`chat/CharacterProfiles.cpp`) returns `c.*`, so `passive_since` is already in the
    list.
- Log Studio: carry the flag into the log event's `metadata` in `LogStudioService::syncFromChannel` and into the
  per-line object of `nativeExport`, as `stand_in: true`.
- `docs/API.md`: the new body field, the recall rule, the endpoint, the two new fields.

**Web (the desktop app uses the same UI).**

- `frontend/src/types/index.ts`: `stand_in` on the message type, `passive_since` on `Character`.
- `frontend/src/components/MessageList.tsx`, `MessageRow`: a pill "stand-in" on such lines and no "(GM)" suffix on
  the name. The Recall button is shown to the character's owner on a stand-in line with no time limit; decide it from
  `stand_in` and the character's `user_id`, not from `recall_seconds_left`.
- `frontend/src/components/CharacterStatus.tsx` and `CharacterRow` in `ChannelSidebar.tsx`: a mark for a passive
  character beside the typing mark, with a tooltip ("Player away: passively present").
- `frontend/src/i18n/catalog.json`: every new string with its 10 translations; `frontend/tests/i18n.test.cjs` fails
  otherwise.

**Mobile (may follow as its own change).**

- Android: `core/Models.kt`, `MessageBubble` and `CharacterRow` in `MainActivity.kt`.
- iOS: `AcerciaeCore/Models.swift`, `MessageBubble` and `CharacterStatusLines` in `App/RootView.swift`.
- Strings in `mobile/contracts/localization/mobile.tsv`, then `python3 mobile/scripts/sync-localizations.py`.
- A fixture in `mobile/contracts/fixtures/` and a dated section in `mobile/contracts/INTEGRATION.md`. On an older
  server the fields are absent and nothing is shown.

**Acceptance.**

- `tests/integration/`: a new test in the style of `recall.test.mjs` and `gm-cast-pc.test.mjs`:
  - the GM posts as a player's character with `stand_in: true`; the row and the `message.posted` frame carry it;
  - a player sending `stand_in: true`, or the GM using it for an NPC or for its own cast character, gets 400;
  - the owner recalls the line after more than 120 seconds; another player cannot;
  - the event of a stand-in line has `actor_role` `player`;
  - the presence endpoint: GM only, `pc` only, `character.updated` is sent, the list shows `passive_since`.
- Frontend tests for the pill, the owner's Recall button and the passive mark.
- `scripts/test.sh` passes.

## 8. Order and deployment

| Step | Package | Depends on |
|---|---|---|
| 1 | WP1 clock | – |
| 2 | WP2 sparks | WP1 |
| 3 | WP3 platform (backend, web) | – |
| 4 | WP4 passive presence, stand-ins, `/away` | WP1, WP2, WP3 |
| 5 | WP5 day turns, summaries, return | WP4 |
| 6 | WP6 thread owners | WP4 |
| 7 | WP3 mobile | WP3 backend |

Each package updates `gm-agent/README.md` (a new section "Daily life" beside "Fragmented play", the configuration
table, the tests list, known limitations) and `gm-agent.example.yml`.

Deployment keeps the existing rule: the GM agent is deployed by hand and is never updated by a platform deployment.
Deploy the backend with migration 0065 first, then the web UI, then the agent.

## 9. Constraints from the codebase

1. **Prompt cache.** `gm-agent/test/fixtures/prompts.coc7e.json` holds a table's prompts byte for byte. With the
   feature off no prompt may change. With it on, put text that changes from turn to turn (who is passive, the clock,
   open questions, the urge) in the uncached last part, as the README's "Prompt caching" section describes.
2. **One writer of the state file.** Change state through the table and `table.save()`; CLI commands go through the
   inbox.
3. **The GM model never writes a player character's line.** The stand-in is a separate call with its own context.
   Do not pass it `ctx.text` or anything built by `gmContext.mjs`.
4. **Model calls only where this plan names them.** The clock, the modes, spark scheduling, command parsing and the
   lists under a summary are plain code.
5. **Budget.** Every new autonomous call checks `overBudget()` first, as `tick()` does. Answers to players do not.
6. **Tests need no backend and no model** in `gm-agent` (`npm test`): use the in-memory platform and the mock model of
   `test/loop.test.mjs`, the injected `now`, and the new injected `random`.
7. **Languages.** Text the agent posts follows `table.language` as existing posts do. The host web UI's labels are
   Chinese. The web app has 11 languages.
8. **Old platform.** The agent must run against a platform without WP3: no stand-in lines, a single log line about the
   missing status endpoint, everything else working.
9. **No new dependencies.**

## 10. Known limits after this plan

- Co-player lines are still recorded by the platform as GM lines (an existing limitation in the README). Sparks make
  more of them. Changing that for all co-player lines affects reminders, inspiration and the players' group observer,
  so it is left as a separate decision.
- The stand-in has no long-term memory of its own: it reads the newest witnessed lines and lexical recall. That is
  enough for small talk and deferring.
- A stand-in's understanding of "matters" and of a free-text rule is a model's judgement. The marks, the take-back and
  the small size of what a passive character may do are what keep a mistake cheap.
- If the agent stops without a clean shutdown, passive marks stay on the platform until it starts again.
- An agent that was down misses its sparks for that time; the clock still catches up.
