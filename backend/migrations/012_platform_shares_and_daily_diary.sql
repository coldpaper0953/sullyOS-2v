ALTER TABLE agent_diaries
  ADD COLUMN IF NOT EXISTS daily_slot text;

-- Older synced diaries intentionally keep a NULL slot so historical duplicates
-- are preserved. New autonomous/manual assistant diaries claim YYYY-MM-DD here.
CREATE UNIQUE INDEX IF NOT EXISTS agent_diaries_assistant_daily_slot_idx
  ON agent_diaries (agent_id, daily_slot)
  WHERE author_type='assistant' AND daily_slot IS NOT NULL;

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
    'platform_share',
    'memory_update',
    'scheduled_wake',
    'system_event'
  ));
