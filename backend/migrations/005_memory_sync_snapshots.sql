-- A complete Memory Palace can contain hundreds of thousands of links.  Mark
-- every uploaded row with a small snapshot id so final reconciliation never
-- needs one giant array of ids in the HTTP request.
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS frontend_sync_snapshot_id text;

ALTER TABLE memory_event_boxes
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_room_plates
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_links
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_anticipations
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_digest_reports
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_vectors
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_batches
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;
ALTER TABLE memory_topic_boxes
  ADD COLUMN IF NOT EXISTS sync_snapshot_id text;

ALTER TABLE memory_palace_sync_runs
  ADD COLUMN IF NOT EXISTS snapshot_id text;

CREATE INDEX IF NOT EXISTS memory_items_agent_frontend_snapshot_idx
  ON memory_items (agent_id, frontend_sync_snapshot_id)
  WHERE external_id IS NOT NULL AND metadata->>'source' = 'frontend_sync';
CREATE INDEX IF NOT EXISTS memory_links_agent_snapshot_idx
  ON memory_links (agent_id, sync_snapshot_id);
