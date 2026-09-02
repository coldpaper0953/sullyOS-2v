ALTER TABLE agent_diaries
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS author_type text NOT NULL DEFAULT 'assistant',
  ADD COLUMN IF NOT EXISTS paper_style text NOT NULL DEFAULT 'plain';

ALTER TABLE agent_diaries
  DROP CONSTRAINT IF EXISTS agent_diaries_author_type_check;
ALTER TABLE agent_diaries
  ADD CONSTRAINT agent_diaries_author_type_check
  CHECK (author_type IN ('user', 'assistant'));

CREATE UNIQUE INDEX IF NOT EXISTS agent_diaries_agent_external_id_idx
  ON agent_diaries (agent_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS diary_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diary_id uuid NOT NULL REFERENCES agent_diaries(id) ON DELETE CASCADE,
  external_id text,
  author_type text NOT NULL CHECK (author_type IN ('user', 'assistant')),
  content text NOT NULL,
  reply_to_id uuid REFERENCES diary_comments(id) ON DELETE SET NULL,
  event_id uuid UNIQUE REFERENCES conversation_events(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS diary_comments_diary_external_id_idx
  ON diary_comments (diary_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS diary_comments_diary_time_idx
  ON diary_comments (diary_id, created_at);

ALTER TABLE conversation_events
  DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE conversation_events
  ADD CONSTRAINT conversation_events_event_type_check CHECK (event_type IN (
    'user_message',
    'assistant_message',
    'proactive_message',
    'diary_entry',
    'diary_comment',
    'autonomous_activity',
    'mcp_activity',
    'activity_summary',
    'tool_activity',
    'memory_update',
    'scheduled_wake',
    'system_event'
  ));
