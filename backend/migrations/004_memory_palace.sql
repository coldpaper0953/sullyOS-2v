CREATE TABLE IF NOT EXISTS memory_event_boxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  summary_node_external_id text,
  live_memory_external_ids text[] NOT NULL DEFAULT '{}',
  archived_memory_external_ids text[] NOT NULL DEFAULT '{}',
  compression_count integer NOT NULL DEFAULT 0,
  sealed boolean NOT NULL DEFAULT false,
  predecessor_box_external_id text,
  client_created_at timestamptz,
  client_updated_at timestamptz,
  last_compressed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id)
);

CREATE TABLE IF NOT EXISTS memory_room_plates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  room text NOT NULL CHECK (room IN ('user_room', 'self_room', 'bedroom', 'study')),
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 0,
  client_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id),
  UNIQUE (agent_id, room)
);

CREATE TABLE IF NOT EXISTS memory_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  source_memory_external_id text NOT NULL,
  target_memory_external_id text NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('temporal', 'emotional', 'causal', 'person', 'metaphor')),
  strength double precision NOT NULL CHECK (strength BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id)
);

CREATE INDEX IF NOT EXISTS memory_links_agent_source_idx
  ON memory_links (agent_id, source_memory_external_id);
CREATE INDEX IF NOT EXISTS memory_links_agent_target_idx
  ON memory_links (agent_id, target_memory_external_id);

CREATE TABLE IF NOT EXISTS memory_anticipations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'anchor', 'fulfilled', 'disappointed')),
  client_created_at timestamptz,
  anchored_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id)
);

CREATE TABLE IF NOT EXISTS memory_digest_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('auto', 'manual')),
  examined jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  plate_submissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  plate_updated text[] NOT NULL DEFAULT '{}',
  client_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id)
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  memory_external_id text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 65536),
  model text,
  vector_data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, memory_external_id)
);

-- These two stores are no longer part of the active recall algorithm, but old
-- installations can still contain them. Keep them as structured migration
-- records so a move to the backend is lossless and remains auditable.
CREATE TABLE IF NOT EXISTS memory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  event_box_external_id text,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'error')),
  nodes_created integer NOT NULL DEFAULT 0,
  error_message text,
  client_created_at timestamptz,
  client_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id)
);

CREATE TABLE IF NOT EXISTS memory_topic_boxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  message_ids bigint[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('open', 'sealed')),
  topic text NOT NULL DEFAULT '',
  events text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  client_created_at timestamptz,
  client_sealed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_id)
);

CREATE TABLE IF NOT EXISTS memory_palace_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES sync_clients(client_id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  event_box_count integer NOT NULL DEFAULT 0,
  room_plate_count integer NOT NULL DEFAULT 0,
  link_count integer NOT NULL DEFAULT 0,
  anticipation_count integer NOT NULL DEFAULT 0,
  digest_report_count integer NOT NULL DEFAULT 0,
  vector_count integer NOT NULL DEFAULT 0,
  batch_count integer NOT NULL DEFAULT 0,
  topic_box_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
