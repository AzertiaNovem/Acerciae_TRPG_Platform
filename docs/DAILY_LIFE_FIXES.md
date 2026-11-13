# Daily life: fixes for two bugs

Fix plan for two bugs found while reviewing the daily-life implementation (`docs/DAILY_LIFE_PLAN.md`) on `main` at
`6adfc154`. Both are in the GM agent only. Line numbers are as of that commit.

Two related findings are design questions still open with the owner and are **not** part of this plan:
non-player names as thread owners, and day summaries written when nothing was witnessed.

Do the two fixes as two separate commits, each with its tests. Run `npm test` in `gm-agent` after each.

## Fix 1. A player's line can go unanswered

### What happens

With daily life on, `onMessage` (`gm-agent/src/table/scheduling.mjs:68-82`) drops any human message that is already
in the local chat copy:

```js
if (m.seq && table.history.lines(m.chat_window_id, { after: m.seq - 1, upTo: m.seq }).some(line => line.id === m.id)) return;
```

The local copy is filled from more places than this handler. Every GM context build calls `history.sync(windowId)`
(`gm-agent/src/context/gmContext.mjs:93`), which fetches the window's newest page from the platform and stores it. When
a player's line is fetched by such a sync before its `message.posted` event is handled, the event is dropped:

- the line is never dispatched, so no turn answers it;
- `beforeDailyMessage` never runs for it, so a night is not ended, the timetable is not stopped and the character's
  passive status is not cleared.

Nothing depends on the check: with it removed, all 373 tests still pass, and the platform does not replay chat events
after a reconnect (`gm-agent/src/cli.mjs`, the `subscribed` handler only resyncs history). It is a guard against a
duplicate event, implemented with the wrong source of truth.

A second weakness sits on the same path: the line is dispatched with `ready.then(() => dispatchMessage(table, m))`
(`scheduling.mjs:81`). If `beforeDailyMessage` throws, `ready` rejects and the line is never dispatched either.

### Change

In `gm-agent/src/table/scheduling.mjs`, daily branch of `onMessage`:

1. Replace the history lookup with a record of events this handler has already accepted:
   - a `Set` of message ids on the table (`table.handledMessages`, created in the `Table` constructor in
     `gm-agent/src/loop.mjs` next to `botMessageIds`);
   - at the top of the daily branch: if the id is in the set, return; otherwise add it;
   - keep it bounded the way `botMessageIds` is (`gm-agent/src/table/actions.mjs:276`: drop the oldest entry beyond
     2000).
   It is in memory only. After a restart the table does not see old events again, so nothing needs to be persisted.
2. Dispatch the line even when the daily bookkeeping fails:

   ```js
   const ready = table.queue.then(() => table.beforeDailyMessage(m));
   table.queue = ready.catch(e => table.log(`daily message: ${e.message}`));
   return table.queue.then(() => dispatchMessage(table, m));
   ```

   The error is logged once (by the `catch` that is already there), and the line goes on to `dispatchMessage`.

Leave the non-daily path of `onMessage` unchanged.

### Tests

Add to `gm-agent/test/daily-loop.test.mjs`, using its `setup()`:

1. **A line the GM context already synced is answered.** Advance the clock an hour and call `t.reconcilePassive()`,
   so Alice is passive. Add her line to the platform, put it in the local copy with `t.history.add(m)`, then
   `await t.onMessage(m)`. A `director` call follows, and the daily bookkeeping ran: Alice is no longer passive.
2. **The same event twice is handled once.** Call `t.onMessage(m)` twice with the same message. There is one
   `director` call, and `t.calendar.since.lines` grows by one.
3. **A failure in the daily bookkeeping does not lose the line.** Replace `t.beforeDailyMessage` with a function that
   throws. The line is still answered, and the log contains `daily message:`.

Test 1 fails on `main` today; tests 2 and 3 guard the change.

## Fix 2. A stand-in line can take back a phone text and turn stand-ins off

### What happens

`standinAct` (`gm-agent/src/table/daily.mjs:288-331`) posts the stand-in line with `table.post(...)` and then reads
`table.lastPosted` to check that the platform marked it `stand_in: true`:

```js
const n = await table.post(windowId, { character_id: id, content: reply.text, kind: 'ic', stand_in: true });
if (!n) return 0;
const posted = table.lastPosted;
if (posted?.stand_in !== true) { table.standinOff = true; /* recall posted.id */ ... }
```

`post` (`gm-agent/src/table/actions.mjs:267-289`) sets `lastPosted` and then waits `pacing.post_delay_ms` (1.2 s by
default) before returning. Phone texts are delivered by `deliverDue` on the 10-second timer in `startTicker`, outside
the table's queue. When a text is delivered during that pause, `lastPosted` is the phone text. `standinAct` then:

- takes the phone text back from the player's phone;
- turns stand-ins off until the agent restarts (`table.standinOff`);
- returns 0 and loses the deferred question, although the stand-in line was posted and correctly marked.

`writeDaySummary` (`daily.mjs:368-373`) and the deferred-question note in `standinAct` (`daily.mjs:326-327`) read
`lastPosted` the same way. Those posts use `count: false`, so there is no pause and the window is far smaller. But if
their own post fails while another line is posted, they record a summary against someone else's message, and
`store.forgetStandin` may later hide that message from every model's context.

### Change

1. In `gm-agent/src/table/actions.mjs`, split `post` in two:
   - `sendLine(table, windowId, body, { allowPaused })`: everything `post` does today except the pause. Returns the
     platform's message, or `null` when nothing was posted (paused, spark limit reached, PbtA dice text, or the request
     failed). It still sets `table.lastPosted`, because existing code (the phone relay in `table/social.mjs:143-145`)
     reads it.
   - `post(table, windowId, body, { count, allowPaused })`: calls `sendLine`; if a message came back and `count` is
     true, waits `pacing.post_delay_ms`; returns 1 or 0 exactly as now.
   Expose `sendLine` on `Table` in `gm-agent/src/loop.mjs` next to `post`. Every existing caller of `post` keeps
   working unchanged.
2. In `standinAct`:
   - post with `const posted = await table.sendLine(windowId, { ... stand_in: true })`; if it is `null`, return 0;
   - check `posted.stand_in` on that message; when the platform did not mark it, recall `posted.id` (the stand-in line
     itself) and turn stand-ins off, as now;
   - after the check, wait `pacing.post_delay_ms` (`table.sleep(table.cfg.postDelayMs)`) to keep the pacing between
     lines;
   - for the deferred-question note in the phone, use the message `sendLine` returns, and record the derived line only
     when one came back;
   - return 1 when the stand-in line was posted.
3. In `writeDaySummary`: post with `sendLine`; when it returns `null`, return `null`; otherwise save the summary and
   record that message's id with `addDailyDerivedLine`. Remove the `before` / `lastPosted` comparison.
4. Do not change the phone relay's use of `lastPosted` in this fix. It posts with `count: false` and so has no pause.

### Tests

Add to `gm-agent/test/daily-loop.test.mjs`:

1. **A phone text during the pause after a stand-in line is left alone.** Make Alice passive, have the mock stand-in
   speak and defer a question, and replace `t.sleep` with a function that posts one phone text to Alice's phone the
   first time it is called (this is what `deliverDue` does in production). Then:
   - `standinAct` returns 1;
   - the phone text is not recalled (`api.recalled` does not contain its id);
   - `t.standinOff` is not set;
   - the deferred question is in `t.daily.questions`.
2. **An older platform still disables stand-ins correctly.** The existing test "older platforms: status failure is
   logged once and no unmarked stand-in is attempted" must still pass. Add one case where the platform accepts the post
   but returns no `stand_in` flag: the recalled message is the stand-in line, and `t.standinOff` is set.
3. **A failed summary post records nothing.** Make the platform refuse posts to Alice's phone, and post another line
   elsewhere during the summary call. `writeDaySummary` returns `null`, and no summary or derived line is stored.

Test 1 fails on `main` today.

## Done when

- `npm test` passes in `gm-agent`, with the new tests.
- `test/fixtures/prompts.coc7e.json` is unchanged, so no prompt changed.
- `gm-agent/README.md` needs no change: neither fix changes documented behaviour.
