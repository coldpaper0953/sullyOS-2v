CREATE TABLE IF NOT EXISTS external_tool_connections (
  id text PRIMARY KEY,
  label text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  endpoint text NOT NULL DEFAULT '',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_ciphertext text,
  last_health_status text NOT NULL DEFAULT 'unknown',
  last_health_error text,
  last_health_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phone_peek_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  heartbeat_run_id uuid REFERENCES wake_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploaded', 'analyzed', 'failed', 'expired')),
  goal text NOT NULL DEFAULT '',
  image_mime_type text,
  image_bytes bytea,
  analysis text,
  error_message text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  uploaded_at timestamptz,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phone_peek_pending_idx
  ON phone_peek_requests (status, expires_at, created_at DESC);
