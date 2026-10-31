-- 0036_object_storage: user avatars move from PostgreSQL into the object store, and a ledger of media copied from the
-- local directory into object storage (so each object is uploaded once, not checked again on every start).

-- avatar_key names the object; avatar_data (the old inline data URI) is emptied once the avatar has been moved.
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN avatar_mime TEXT;

CREATE TABLE object_migrations (
    object_key  TEXT NOT NULL,
    target      TEXT NOT NULL,            -- backend kind the object was copied to (r2, s3, r2public)
    migrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (object_key, target)
);
