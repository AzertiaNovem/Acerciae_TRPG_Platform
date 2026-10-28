-- Server policy, set by the server's maintainers:
--   join_policy          open: listed in the server directory, anyone may join
--                        invite: joining needs an invite code from a maintainer (the default)
--                        closed: only maintainers add members
--   channel_creation     who may create channels: every member, or maintainers only
--   guest_invites        channel GMs may invite people from outside the server as guests; a guest sees only the
--                        channels they were invited to and leaves the server with their last channel
--   main_chat_spectators members who were not invited to a channel may read its Main Chat (read-only, public lines)
-- Maintainers can always add members directly.
ALTER TABLE server_members DROP CONSTRAINT server_members_role_check;
ALTER TABLE server_members ADD CONSTRAINT server_members_role_check CHECK (role IN ('owner', 'admin', 'member', 'guest'));

ALTER TABLE server_settings
    ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite' CHECK (join_policy IN ('open', 'invite', 'closed')),
    ADD COLUMN channel_creation TEXT NOT NULL DEFAULT 'members' CHECK (channel_creation IN ('members', 'maintainers')),
    ADD COLUMN guest_invites BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN main_chat_spectators BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX server_settings_open_idx ON server_settings(server_id) WHERE join_policy = 'open';

CREATE TABLE server_invites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    code        TEXT NOT NULL UNIQUE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    max_uses    INT NOT NULL DEFAULT 0 CHECK (max_uses >= 0),       -- 0 = unlimited
    uses        INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,                                          -- NULL = never
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX server_invites_server_idx ON server_invites(server_id, created_at DESC);
