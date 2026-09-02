ALTER TABLE agent_state
  ADD COLUMN IF NOT EXISTS last_autonomous_activity_at timestamptz;

UPDATE characters
SET autonomy_policy = jsonb_build_object(
  'idleThresholdMinutes', 30,
  'cooldownMinutes', 60,
  'probabilityLevel', 'mid',
  'activityWindow', jsonb_build_object(
    'enabled', false,
    'start', '08:00',
    'end', '23:30'
  )
) || autonomy_policy;
