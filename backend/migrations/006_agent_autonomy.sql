ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS autonomy_policy jsonb NOT NULL DEFAULT jsonb_build_object(
    'allowedCapabilityIds', jsonb_build_array('memory.reflect'),
    'approvalMode', 'read_only_auto',
    'maxToolStepsPerWake', 4,
    'dailyToolBudget', 20
  );

CREATE INDEX IF NOT EXISTS characters_heartbeat_enabled_idx
  ON characters (heartbeat_enabled)
  WHERE heartbeat_enabled = true;
