# Data flow

## The vertical flow

```
player types → POST /windows/{w}/messages
   │  ChatService.postMessage (one transaction)
   ├─ INSERT messages (visibility, whisper_to, scene_id = window's active scene)
   ├─ INSERT events (kind=message.posted, audience = characters present / whispered to, seq++)
   └─ Notifier.messagePosted → /ws/chat to window participants (+GM)

every AI_OBSERVER_INTERVAL_MS (5 s)                         ObserverScheduler.observeTick
   │  for each channel with ai_enabled
   ├─ groups = events with seq > cursor(channel, 'observe', window:scene)   ← no groups ⇒ no LLM call
   └─ for each group (lock: in-process + ai_jobs partial unique index)
        ├─ batch = next ≤ AI_OBSERVER_MAX_BATCH events of the group
        ├─ context = scene (prior log, participants) + batch + compact document snapshots
        │           + related_history (rule-based FTS over older facts for the batch's distinctive terms)
        │           + module_nodes touched (name match + FTS over node text) + characters
        ├─ LlmGateway.runStructured(task=observer_extract, tools=Tool API, schema)
        │     ↳ tool calls executed by ContextRetrievalService under system scope; ≤4 rounds; schema repair round
        ├─ for each proposal → DocumentService.commit (validation below) → /ws/context document.updated
        ├─ highlights → HighlightService.create (scope = cited fact's own scope) → highlight.created
        ├─ module_hints → module_hints (GM) + Module Progress highlight; scene_update → scenes
        ├─ knowledge-sharing suggestions (Mode B) → document_proposals(needs_gm_review) → proposal.pending (GM)
        └─ ai_jobs.succeeded, cursor = last seq of the batch

frontend (context stream)
   ├─ document.updated → bubble pulses, change badge increments, open viewer refetches (composer untouched)
   ├─ highlight.created → highlight store only → HighlightedText fades the entry in (no document re-render)
   └─ highlight.expired → removed from the store
```

## Proposal validation (DocumentService.commit)

Input: `{channel, document_type|document_id, expected_version?, ops[], source_event_ids[], evidence[], actor}`.

1. Lock the document row (`FOR UPDATE`); if `expected_version` is given and differs → **409**.
2. Record the proposal (`document_proposals`, pending).
3. For each op, independently (a bad op never blocks the rest; every decision is logged):
   * `add_entry`
     * AI ops need ≥1 source event; all cited events must belong to the channel.
     * `confirmed` from the AI requires a GM- or system-authored source; otherwise downgraded to `attempted`.
     * Dedupe: same kind + identical summary already in the document ⇒ becomes an `update_entry`.
     * **Scope** = intersection of the cited events' audiences (`public` in Mode A for window messages,
       per-character in Mode B, whisper recipients, GM-only). The AI may narrow, never widen. `gm_secret` ⇒ GM scope.
       Module Progress is always GM scope.
     * Insert fact + visibility rows + entity links + index rows (`clues`, `narrative_threads`, `entity_relations`) +
       document entry (`content_md` from the AI or rendered from the fact).
   * `update_entry` / `set_status`
     * AI needs a source; confirming needs a GM source.
     * Changing/weakening a `confirmed` record, or altering a GM-authored entry ⇒ **`needs_gm_review`** proposal, nothing applied.
   * `append_text`, `remove_entry` (AI may not remove confirmed records → review), `add_relation`, `link_facts`.
4. If anything applied: `documents.version++`, write `document_revisions` (ops + full entry snapshot), mark proposal
   committed; else mark rejected with the log.
5. Notify: `document.updated {document_id, doc_type, version, change_count, entry_ids, gm_only}`; `proposal.pending` to GMs.

GM corrections go through the same path with `actor=gm` (no source requirement, may set any status/visibility) and
additionally emit a `document.corrected` event so later analysis sees the correction. Rollback restores a snapshot as a
*new* revision (`document.rolled_back` event); nothing is ever deleted from history.

## Retrieval (sharded context)

The observer never receives the whole channel log. It gets the current scene's prior log (bounded), the new batch, and
compact snapshots of the six documents. Anything else is fetched on demand through the Tool API:

| Tool | Returns |
|---|---|
| `get_current_scene`, `get_scene_by_id` | scene metadata, participants, viewer-visible log and facts |
| `search_scene_history` | FTS/trigram over facts (optionally within/excluding a scene) + matching events (+ semantic if enabled) |
| `search_events` | FTS over raw events |
| `get_entity`, `get_relationships` | entity card with facts and relation graph edges |
| `get_clue`, `get_open_threads` | typed shards |
| `get_knowledge_scope` | what a character knows |
| `get_module_excerpt` (GM) | module nodes + `ts_headline` page excerpts |
| `get_shard` | `scene/…`, `entity/…`, `clue/…`, `relationship/…`, `thread/…`, `timeline/…`, `module/…`, `knowledge/…` |

Shard ids are `<kind>/<uuid>`; every shard carries structured data, a Markdown projection (document entry), version,
source event ids, knowledge scope, timestamps and links (entities, related facts).

## Consistency check

`POST /consistency {draft, chat_window_id, character_id}` →
1. Rule layer: keywords of the draft → FTS/trigram over facts visible to *that character* (+ all their clues/relationships);
   recent visible scene log; scene metadata; rule hints.
2. LLM (or mock rules): possession/promise, unknown-name, location, outcome-declaration checks → `{score|null,
   insufficient_evidence, rationale, conflicts[{description, severity, evidence_fact_ids}], supporting/recommended ids}`.
3. Post-filter: any cited id not in the visible evidence set is dropped (defence against leaks); evidence is resolved to
   entry/document/scene/source events; result persisted (`consistency_checks`); user-scoped 5-minute highlights created on
   the cited entries. The draft is returned unchanged and can still be sent.

## Inspiration

`POST /inspiration` builds {character (style, sheet), scene, recent visible messages, up to 30 facts the character knows}
→ LLM/mock → `{draft, used_fact_ids}`; used ids are filtered to visible facts; persisted; `editable: true, auto_sent: false`.

## Module import

PDF upload (`%PDF-` magic, size limit) → poppler per-page text → `module_pages` → chunks of ~12k chars → structuring
prompt (or mock heuristics) → nodes with `{page, excerpt}` citations and edges keyed by stable slugs → `ready`.
During play the observer matches batch text to node names and node text (FTS); matches become `module_progress` entries
(`ai_inferred`) and **potential-association hints**; a scene whose location matches no module location is flagged
`off_module` and produces an off-module hint. Nothing in the module layer is ever written into player-visible facts by the AI.
