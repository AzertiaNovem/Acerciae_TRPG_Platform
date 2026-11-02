-- Content hashes (SHA-256 of the stored bytes) for every stored picture and clip, so clients cache by content: the
-- same bytes are one cache entry whatever asset or version names them, and a cached copy is replaced only when the
-- hash changes. New objects are hashed as they are written; an existing object is hashed the first time it is served.
ALTER TABLE asset_versions ADD COLUMN content_hash TEXT;
ALTER TABLE media_assets ADD COLUMN content_hash TEXT;      -- the current version's hash (asset_versions holds every version's)
ALTER TABLE users ADD COLUMN avatar_hash TEXT;
