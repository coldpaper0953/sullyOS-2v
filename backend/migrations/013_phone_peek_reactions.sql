ALTER TABLE phone_peek_requests
  ADD COLUMN IF NOT EXISTS reaction jsonb,
  ADD COLUMN IF NOT EXISTS message_event_id uuid REFERENCES conversation_events(id) ON DELETE SET NULL;

