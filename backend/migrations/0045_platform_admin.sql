-- Platform administration: operators of the deployment (PLATFORM_ADMINS, or users.is_admin granted from the admin panel)
-- can inspect storage, database and account use across every server, and suspend accounts and servers whose content or
-- storage use breaks the deployment's policies. A suspension is reversible; nothing is deleted.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN suspended_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN suspended_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE servers ADD COLUMN suspended_at TIMESTAMPTZ;
ALTER TABLE servers ADD COLUMN suspended_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE servers ADD COLUMN suspended_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- What administrators did, for accountability: the actor, the action, the target (kept by id and name so the row
-- outlives a deleted target) and the reason they gave.
CREATE TABLE admin_actions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    admin_name  TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL CHECK (action IN ('suspend_user','unsuspend_user','suspend_server','unsuspend_server','grant_admin','revoke_admin')),
    target_type TEXT NOT NULL CHECK (target_type IN ('user','server')),
    target_id   UUID NOT NULL,
    target_name TEXT NOT NULL DEFAULT '',
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_created_idx ON admin_actions(created_at DESC);
CREATE INDEX admin_actions_target_idx ON admin_actions(target_type, target_id);

-- The admin panel's storage and activity columns.
CREATE INDEX IF NOT EXISTS media_assets_created_by_idx ON media_assets(created_by);
CREATE INDEX IF NOT EXISTS auth_tokens_user_created_idx ON auth_tokens(user_id, created_at DESC);
