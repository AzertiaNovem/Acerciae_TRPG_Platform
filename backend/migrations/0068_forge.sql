ALTER TABLE chat_windows ADD COLUMN purpose text NOT NULL DEFAULT 'story' CHECK (purpose IN ('story','forge'));
CREATE TABLE agent_receipts (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL, request_id text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(channel_id,actor_id,operation,request_id)
);
CREATE TABLE character_owner_changes (
  id bigserial PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id), previous_user_id uuid REFERENCES users(id),
  user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
