-- Reference snapshots are shared within a channel. Keep only pointers in job JSON.
CREATE VIEW image_reference_objects AS
SELECT DISTINCT j.channel_id, r.value->>'object_key' AS object_key,
       r.value->>'mime' AS mime, (r.value->>'bytes')::bigint AS bytes,
       r.value->>'content_hash' AS content_hash
FROM asset_generation_jobs j
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.params->'request'->'reference_images')='array'
    THEN j.params->'request'->'reference_images' ELSE '[]'::jsonb END) r
WHERE r.value ? 'object_key';

-- Physical objects are independent of ephemeral jobs. A copy in another bucket has its own row.
CREATE TABLE stored_objects (
    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    bytes BIGINT NOT NULL CHECK (bytes >= 0),
    mime TEXT NOT NULL DEFAULT '',
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('channel','user','unclaimed')),
    owner_id TEXT,
    provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    protected_until TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(bucket, object_key)
);
CREATE INDEX stored_objects_owner_idx ON stored_objects(owner_kind, owner_id);

CREATE VIEW stored_object_claims AS
SELECT m.object_key, 'media_asset'::text AS kind, m.id::text AS id, m.channel_id::text AS channel_id, m.created_by::text AS user_id FROM media_assets m
UNION SELECT v.object_key, 'asset_version', v.asset_id::text || '@' || v.version::text, m.channel_id::text, m.created_by::text FROM asset_versions v JOIN media_assets m ON m.id=v.asset_id
UNION SELECT object_key, 'tts_audio', id::text, channel_id::text, created_by::text FROM tts_audio_assets
UNION SELECT object_key, 'pdf', id::text, channel_id::text, created_by::text FROM pdf_render_jobs WHERE object_key IS NOT NULL
UNION SELECT object_key, 'vn_bundle', id::text, channel_id::text, requested_by::text FROM vn_bundle_jobs WHERE object_key IS NOT NULL
UNION SELECT raw_object_key, 'log_import', id::text, channel_id::text, NULL::text FROM log_imports WHERE raw_object_key IS NOT NULL
UNION SELECT avatar_key, 'avatar', id::text, NULL::text, id::text FROM users WHERE avatar_key IS NOT NULL
UNION SELECT f.value->>'object_key', 'published_image', p.id::text, p.channel_id::text, p.published_by::text
FROM published_logs p CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p.frozen_content->'assets')='object'
    THEN p.frozen_content->'assets' ELSE '{}'::jsonb END) f WHERE NOT p.revoked AND f.value ? 'object_key'
UNION SELECT f.value->>'object_key', 'published_audio', p.id::text, p.channel_id::text, p.published_by::text
FROM published_logs p CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p.frozen_content->'audio')='object'
    THEN p.frozen_content->'audio' ELSE '{}'::jsonb END) f WHERE NOT p.revoked AND f.value ? 'object_key'
UNION SELECT r.value->>'object_key', 'image_job', j.id::text, j.channel_id::text, j.created_by::text FROM asset_generation_jobs j
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.params->'request'->'reference_images')='array'
    THEN j.params->'request'->'reference_images' ELSE '[]'::jsonb END) r WHERE r.value ? 'object_key';
