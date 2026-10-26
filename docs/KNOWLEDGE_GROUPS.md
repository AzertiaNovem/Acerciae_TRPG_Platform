# Independent KP and player-group knowledge

The application still uses React/TypeScript, C++20/Drogon, PostgreSQL/libpqxx, HTTP and WebSocket. This change replaces
shared fact visibility with independent memory partitions; it does not replace the existing chat or Log Studio architecture.

## Data and AI flow

KP has six private document categories: Current Scene, Clue Journal, Relationship Journal, Open Threads, Timeline and
Module Progress. GM Workshop exposes them with sections, status/search filters, original sources, revisions and corrections.
The KP observer may use module information and KP scene metadata. KP memory is never a player retrieval source.

Each player group has its own facts, entities, relations, five journals and revisions. `player_group_id IS NULL` identifies
KP memory; a non-null group ID identifies player memory. Players share the union of chat perspectives granted to members
of that group, including addressed whispers. This expands reading only; posting and character control still require the
caller's own permissions. GM-only messages are excluded.

The group observer reads `player_group_chat_events`, its own earlier documents and authorized retrieval results. It receives
no KP module graph, scene description, character sheet, journal text or entity registry. AI-produced operations must cite
readable source chat from the authorized batch; a summary cannot import a KP fact ID or another group's fact. Source status
is still distinguished: a player's claim does not become a confirmed fact merely by being summarized.

The server scopes HTTP reads, source viewers, tool calls, consistency/inspiration, revision history and WebSocket delivery.
PostgreSQL constraints reject cross-partition document/entity/relation links. Every group has a generation number; commits
lock and check it so an in-flight AI response cannot restore knowledge after a membership change.

## Group management and migration

KP manages groups per channel in GM Workshop or channel settings. Existing public channels migrate to one player group;
existing isolated channels create one group per player. New invitations follow the same default. The KP can create an
empty group and move members to merge or split perspectives. Changing the default mode does not regroup existing players.

Migrations 0013–0015 preserve old facts and documents as KP-only records, retain historical visibility metadata without
using it to authorize reads, and create fresh independent player journals. They retire direct KP knowledge sharing.
Membership and window-access changes clear affected derived player memory, increment generations and rebuild it from
currently readable chat on the next observer pass. Raw chat, canonical logs and KP records are retained. Document IDs
and revisions in rebuilt player partitions change deliberately; clients must discard stale caches on `knowledge.reset`.

PDF appendix jobs bind to the originating memory partition and generation. Public exports cannot include private memory
appendices, and such PDFs cannot be published through sharing links. Legacy exports with memory appendices become KP-only;
existing publication links for those exports are revoked. This does not revoke ordinary canonical-log publications.
Run the usual numbered migration runner after taking a database backup; do not reset the production schema.

## Referencing chat

A player can choose “Quote message” in chat or from a journal's source viewer. The composer holds up to five references,
which can be removed before sending. The sent message stores original message IDs. “View chat reference” fetches the
original under the reader's current permissions, and “Go to original message” checks permission again before navigation.
No private excerpt is copied into a publicly readable message by the reference mechanism. Another group may see the link
but cannot open an unauthorized original. Manually typed message text remains ordinary user-authored chat.

## Validation and limits

The database suite records actual mock-provider requests and attempts hostile module/entity/scene tool retrieval to check
that KP markers and other groups' markers never enter player prompts. It also exercises provenance checks, stale commits,
merge/split/revocation and quote access. `tests/integration/knowledge-groups.test.mjs` checks the HTTP and WebSocket paths;
the scenario suite covers observer behavior and the Log Studio suite covers real rendering of three PDF templates.
The browser acceptance screenshots are in `docs/screenshots/kp-knowledge-groups.png` and `chat-references.png`.

Mock extraction is deliberately labeled and uses English heuristics. Live AI quality and costs require the configured
provider; these boundary tests do not claim to validate a real provider's narrative quality. Incremental player summaries
update existing journals; low-frequency consolidation currently applies only to KP memory. Multi-instance WebSocket
fan-out still needs a shared broker, while generation checks and polling reconcile missed notifications.
