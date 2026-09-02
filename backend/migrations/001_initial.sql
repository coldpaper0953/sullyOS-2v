CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  heartbeat_interval_minutes integer NOT NULL DEFAULT 5
    CHECK (heartbeat_interval_minutes BETWEEN 1 AND 1440),
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '主对话',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'assistant', 'system', 'tool')),
  event_type text NOT NULL CHECK (event_type IN (
    'user_message',
    'assistant_message',
    'proactive_message',
    'diary_entry',
    'activity_summary',
    'tool_activity',
    'memory_update',
    'scheduled_wake',
    'system_event'
  )),
  content text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_conversation_sequence_idx
  ON events (conversation_id, sequence_id);
CREATE INDEX IF NOT EXISTS events_occurred_at_idx
  ON events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fact', 'preference', 'episode', 'summary')),
  content text NOT NULL,
  importance smallint NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  source_event_ids uuid[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS memory_items_agent_kind_idx
  ON memory_items (agent_id, kind, archived_at);

CREATE TABLE IF NOT EXISTS device_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  activity_type text NOT NULL,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_activity_user_time_idx
  ON device_activity (owner_user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS agent_state (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  last_user_activity_at timestamptz,
  last_agent_activity_at timestamptz,
  last_heartbeat_at timestamptz,
  next_wake_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz,
  context_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_state_next_wake_idx
  ON agent_state (next_wake_at);

CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  action text CHECK (action IN ('none', 'message', 'diary', 'explore')),
  reason_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS heartbeat_runs_agent_time_idx
  ON heartbeat_runs (agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  delivery_type text NOT NULL CHECK (delivery_type IN ('in_app', 'web_push')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (status, available_at)
  WHERE status IN ('pending', 'failed');

INSERT INTO app_users (id, display_name)
VALUES ('00000000-0000-4000-8000-000000000001', '本机用户')
ON CONFLICT (id) DO NOTHING;

INSERT INTO agents (id, owner_user_id, name, timezone)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'Sully',
  'Pacific/Auckland'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversations (id, owner_user_id, agent_id, title)
VALUES (
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '主对话'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_state (agent_id, next_wake_at)
VALUES ('00000000-0000-4000-8000-000000000002', now())
ON CONFLICT (agent_id) DO NOTHING;
