# Platform administration

Servers are run by their maintainers and channels by their GMs; the deployment as a whole is run by its **platform
administrators**. They see what the deployment holds and who uses it, and they can suspend a server or an account whose
content breaks the deployment's policies or that abuses image storage. Suspension is the only lever: it is reversible,
nothing is deleted, and every action is written to an audit log with its reason.

Finding what to act on (scanning content, flagging storage abuse automatically) is not part of this: the panel shows the
numbers, a person decides.

## Who is an administrator

- **`PLATFORM_ADMINS`** (environment): comma-separated usernames, e.g. `PLATFORM_ADMINS=operator,sofia`. These accounts
  are administrators as long as they are listed. They cannot be suspended or demoted from the panel, so a deployment
  always keeps at least one administrator it can rely on; change the variable and restart to change them.
- **Granted administrators**: an administrator can make another account an administrator (`users.is_admin`) from the
  Users tab, and revoke it again. Granting and revoking are logged. An administrator cannot revoke their own role.

The profile (`GET /api/auth/me`) carries `is_admin`; the web client shows the 🛡 entry in the server rail to
administrators only. Without `PLATFORM_ADMINS` and without any granted administrator, nobody can open the panel.

## The panel

Web client → 🛡 in the server rail (administrators only). Four tabs:

- **Overview**: accounts (total, new in 30 days, suspended, signed in during the last 7 days, active sessions), servers
  and channels (with message counts), stored media in total and by kind (images, audio, PDFs, visual-novel bundles,
  other; the object store in use), the PostgreSQL database size with its largest tables, AI use over 30 days (tokens,
  images, servers that used AI), who the administrators are, and the latest actions.
- **Servers**: every server with its owner, members, channels, messages, images, stored bytes, AI images in 30 days and
  last activity; search by server or owner name; sort by storage, images, members, messages, age or name. Opening a
  server lists its channels (each with its own storage and activity), its members and the actions taken on it.
  **Suspend** / **Reinstate** sit on each row.
- **Users**: every account with when it joined and was last seen, how many servers it is in (and owns), messages,
  images and stored bytes attributed to it (the media it uploaded or generated); search and sort likewise. Opening an
  account lists its servers and the actions taken on it. **Suspend** / **Reinstate** and **Make admin** / **Revoke
  admin** sit on each row (not on your own account, not on accounts named in `PLATFORM_ADMINS`).
- **Audit log**: every suspension, reinstatement and administrator change, with who did it, the target and the reason.

Suspending asks for a reason (up to 500 characters). It is stored, shown in the audit log, shown to a suspended
account when it tries to sign in, and shown to a suspended server's members in the channel sidebar.

## What a suspension does

**Server** (`servers.suspended_at`):

- Every request into the server or its channels answers `403 server_suspended`: channel lists, messages, characters,
  documents, the Log Studio, server settings, joining by invite or from the directory, spectating.
- Members still sign in and still see the server in their list, marked suspended with the reason; the web client shows
  the notice instead of the channel list.
- Open WebSocket subscriptions to its channels are dropped at once, and new ones are refused. Its published log links
  (`/api/published/…`) answer 404 while it is suspended.
- Background AI work on its channels keeps its state; nothing is deleted. Reinstating restores everything as it was.

**Account** (`users.suspended_at`):

- Every session ends at once: its tokens are deleted and its WebSockets closed; requests answer 401.
- Signing in answers `403 account_suspended` with the reason in the message.
- Its characters, messages and media stay where they are. Reinstating lets the account sign in again.

## Storage accounting

Bytes are counted from the database's records of stored objects, not by listing the object store: every version of a
media asset (`asset_versions`, the current version included; `media_assets.bytes` stands in for an asset without
versions), speech clips (`tts_audio_assets`), rendered PDFs and visual-novel bundles that still have an object. Avatars
are counted, not sized. A user's bytes are the objects they made (`created_by` / `requested_by`); a server's bytes are
its channels' objects. The storage cleanup (`--clean-storage`) removes objects nothing references, so these numbers
follow what is really kept.

The database size is `pg_database_size(current_database())`; the table sizes include indexes and TOAST.

## API

All routes need an administrator's session; others answer `403 admin_required`. Paged lists return
`{rows, total, limit, offset}` (`limit` ≤ 200).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/overview` | `{users{total, suspended, admins, new_7d, new_30d, active_sessions, signed_in_7d, listed_admins[]}, servers{total, suspended, new_30d, channels, messages, messages_7d}, storage{bytes, objects, image_bytes, images, audio_bytes, audio, pdf_bytes, pdfs, bundle_bytes, bundles, other_bytes, other, store, avatars, images_7d}, database{bytes, tables[{name, bytes, rows}]}, ai{tokens_30d, images_30d, servers_30d}, recent_actions[]}` |
| GET | `/api/admin/servers?q&sort&limit&offset` | rows `{id, name, created_at, suspended, suspended_reason, owner_id, owner_username, owner_name, member_count, channel_count, message_count, last_message_at, bytes, objects, images, image_bytes, ai_images_30d, ai_tokens_30d}`; `sort`: storage (default), images, members, messages, created, name, suspended; `q` matches the server or owner name |
| GET | `/api/admin/servers/{id}` | the row plus `suspended_at`, `suspended_by_name`, `channels[{id, name, rule_system, created_at, story_status, bytes, objects, images, member_count, message_count, last_message_at}]`, `members[{id, username, display_name, role, joined_at, suspended}]`, `actions[]` |
| PUT | `/api/admin/servers/{id}/suspension` | `{suspended: bool, reason?}`; suspending needs a reason. Returns the row. |
| GET | `/api/admin/users?q&sort&limit&offset` | rows `{id, username, display_name, created_at, is_admin, listed_admin, suspended, suspended_reason, last_seen_at, server_count, owned_count, message_count, bytes, objects, images, image_bytes}`; `sort`: created (default), storage, images, last_seen, servers, name, suspended |
| GET | `/api/admin/users/{id}` | the row plus `suspended_at`, `suspended_by_name`, `sessions`, `character_count`, `servers[{id, name, role, joined_at, suspended, channel_count}]`, `actions[]` |
| PUT | `/api/admin/users/{id}/suspension` | `{suspended: bool, reason?}`; not your own account, not a `PLATFORM_ADMINS` account. Ends every session of the account. |
| PUT | `/api/admin/users/{id}/admin` | `{admin: bool, reason?}`; not your own role, not a `PLATFORM_ADMINS` account. |
| GET | `/api/admin/actions?limit&offset` | `{id, admin_id, admin_name, action, target_type, target_id, target_name, reason, created_at}`; `action` ∈ suspend_user, unsuspend_user, suspend_server, unsuspend_server, grant_admin, revoke_admin |

Clients other than the web app (mobile, the GM agent) need no change: a suspended account's requests fail with 401 and
its sign-in with `403 account_suspended`; a suspended server's requests fail with `403 server_suspended`, and
`GET /api/servers` marks it `suspended: true` with `suspended_reason`.

## Operating notes

- Set `PLATFORM_ADMINS` before exposing a deployment; the accounts need not exist yet (they become administrators when
  they register with that username).
- The tests start the backend with `PLATFORM_ADMINS=platform_admin` (`scripts/test.sh`).
- Migration `0043_platform_admin.sql` adds the columns and the `admin_actions` table; nothing changes for existing
  accounts and servers.
