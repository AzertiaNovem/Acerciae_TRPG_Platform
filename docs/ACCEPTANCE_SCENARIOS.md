# Acceptance scenarios

Automated: `tests/integration/scenarios.test.mjs` (Node ≥ 20, against a running backend) plus
`backend/tests/integration/db_tests.cpp` (validation core) and `backend/tests/unit/unit_tests.cpp` (rules, mock, schema).
Run everything with `scripts/test.sh`. The seeded demo campaign (“The Lantern of Blackwater Cove”, users
keeper/alice/bob/carol) reproduces the same situations by hand.

| # | Scenario | Automated check | Manual reproduction (demo campaign) |
|---|---|---|---|
| 1 | Split-party investigation | PL1+PL2 window gets an archive clue, PL3 window gets a harbour clue; `GET documents/clue_journal` as PL3 lacks the archive clue and vice versa; Tool API search as PL3 returns nothing; PL3 is 403 on the other window | Sign in as **carol**: Clue Journal shows only the docks badge and the letter, never the Gazette ledger that **alice/bob** see |
| 2 | Scheduled AI document updates | Six messages posted within one interval; the scheduler (not a manual trigger) produces **one** `observe` job with `event_count ≥ 6` and ≤ 2 LLM calls; `document.updated` arrives on `/ws/context`; `recent_changes ≥ 1` on the bubble | Post several lines quickly in Main Chat; within ~5 s the bubbles pulse and show a change badge; GM workspace → AI observer lists one job for the batch |
| 3 | Return of historical foreshadowing | After PL3 mentions the badge in Session 3, an `association` highlight is bound to the Session-1 badge entry in the Clue Journal, cites the triggering event, is pushed over `/ws/context`, and the Relationship Journal links the character to the item | As **carol**, open Clue Journal: the Session-1 badge entry glows; hover for the reason, “jump to original event” |
| 4 | Consistency conflict | Draft “I take out the key that the Sheriff gave me…” → `score < 70`, a conflict mentioning the promise, traceable evidence with source events, user-scoped highlights; a neutral draft → `Insufficient Evidence`; the draft is never posted; a GM-only secret never appears in the result | Type the same draft, click **Consistency check** |
| 5 | Inspiration | Draft returned `editable: true, auto_sent: false`, message count unchanged, regeneration differs, drafting as someone else's character is 403, draft never uses facts the character cannot know | Click **Inspiration**, then *Insert into input* |
| 6 | Module deviation | Demo PDF uploaded → `ready`, nodes with page citations and edges; players enter a quarry not in the module → scene `off_module`, the clue found there is recorded, `module_hints` are `potential`, Module Progress entries are `ai_inferred`, players get 403 on the module layer | GM workspace → Module tab (import), Overview tab (potential associations) |
| 7 | GM error correction | GM sets a confirmed clue to `attempted` → new `gm` revision, previous snapshot keeps the old status, fact and Tool API report `attempted`, players get 403, rollback creates another revision | Open a document as **keeper**, hover an entry → *correct*; *history* shows versions and *Roll back* |

Additional automated checks: chat WebSocket audience isolation; Mode B knowledge-sharing suggestion stays pending until the
GM accepts it; AI facts without sources rejected; AI cannot confirm without a GM source; contradictions of confirmed
records become pending proposals; stale `expected_version` is refused (409); highlights expire via the cleanup loop.
