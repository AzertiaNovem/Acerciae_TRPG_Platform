ALTER TABLE characters ADD COLUMN inventory_version bigint NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN inventory_guarded boolean NOT NULL DEFAULT false;
CREATE TABLE inventory_operations (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id, actor_id, request_id)
);
CREATE INDEX inventory_operations_created ON inventory_operations(created_at);
CREATE TABLE agent_message_receipts (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id text NOT NULL, fingerprint text,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  cancelled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id, actor_id, request_id)
);
CREATE INDEX agent_message_receipts_created ON agent_message_receipts(created_at);
