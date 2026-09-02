ALTER TABLE agents RENAME TO characters;
ALTER TABLE events RENAME TO conversation_events;
ALTER TABLE heartbeat_runs RENAME TO wake_runs;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS system_prompt text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS worldview text,
  ADD COLUMN IF NOT EXISTS writer_persona text,
  ADD COLUMN IF NOT EXISTS legacy_memories jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS refined_memories jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS profile_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS heartbeat_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_updated_at timestamptz;

UPDATE characters
SET external_id = '__demo__'
WHERE id = '00000000-0000-4000-8000-000000000002'
  AND external_id IS NULL;

UPDATE characters
SET external_id = id::text
WHERE external_id IS NULL;

ALTER TABLE characters
  ALTER COLUMN external_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS characters_owner_external_id_idx
  ON characters (owner_user_id, external_id);

UPDATE characters
SET heartbeat_enabled = true
WHERE id = '00000000-0000-4000-8000-000000000002';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS external_id text;

UPDATE conversations
SET external_id = 'private:__demo__'
WHERE id = '00000000-0000-4000-8000-000000000003'
  AND external_id IS NULL;

UPDATE conversations
SET external_id = id::text
WHERE external_id IS NULL;

ALTER TABLE conversations
  ALTER COLUMN external_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_owner_external_id_idx
  ON conversations (owner_user_id, external_id);

ALTER TABLE conversation_events
  ADD COLUMN IF NOT EXISTS source_message_id bigint,
  ADD COLUMN IF NOT EXISTS source_device_id text,
  ADD COLUMN IF NOT EXISTS source_message_type text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_events_source_message_idx
  ON conversation_events (conversation_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

ALTER TABLE conversation_events
  DROP CONSTRAINT IF EXISTS events_event_type_check;
ALTER TABLE conversation_events
  DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE conversation_events
  ADD CONSTRAINT conversation_events_event_type_check CHECK (event_type IN (
    'user_message',
    'assistant_message',
    'proactive_message',
    'diary_entry',
    'autonomous_activity',
    'mcp_activity',
    'activity_summary',
    'tool_activity',
    'memory_update',
    'scheduled_wake',
    'system_event'
  ));

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS room text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mood text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS valence double precision,
  ADD COLUMN IF NOT EXISTS arousal double precision,
  ADD COLUMN IF NOT EXISTS embedded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz,
  ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_memory_id text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS event_box_id text,
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_box_summary boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_updated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_agent_external_id_idx
  ON memory_items (agent_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_diaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  event_id uuid UNIQUE REFERENCES conversation_events(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  content text NOT NULL,
  mood text,
  visibility text NOT NULL DEFAULT 'user_visible'
    CHECK (visibility IN ('private', 'user_visible')),
  diary_date date NOT NULL DEFAULT CURRENT_DATE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_diaries_agent_date_idx
  ON agent_diaries (agent_id, diary_date DESC);

CREATE TABLE IF NOT EXISTS scheduled_wakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  event_id uuid REFERENCES conversation_events(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL CHECK (created_by IN ('user', 'assistant', 'system')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
  dedupe_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (agent_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS scheduled_wakes_due_idx
  ON scheduled_wakes (status, due_at)
  WHERE status = 'pending';

ALTER TABLE wake_runs
  ADD COLUMN IF NOT EXISTS scheduled_wake_id uuid
    REFERENCES scheduled_wakes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS sync_clients (
  client_id text PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  client_name text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES sync_clients(client_id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  message_count integer NOT NULL DEFAULT 0,
  memory_count integer NOT NULL DEFAULT 0,
  deleted_message_count integer NOT NULL DEFAULT 0,
  deleted_memory_count integer NOT NULL DEFAULT 0,
  context_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_runs_client_time_idx
  ON sync_runs (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  client_id text REFERENCES sync_clients(client_id) ON DELETE SET NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  expiration_time timestamptz,
  user_agent text,
  enabled boolean NOT NULL DEFAULT true,
  failure_count integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, endpoint)
);
