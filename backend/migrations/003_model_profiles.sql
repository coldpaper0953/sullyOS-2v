CREATE TABLE IF NOT EXISTS model_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  label text NOT NULL,
  base_url text NOT NULL,
  api_key_encrypted text NOT NULL,
  model_name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  health_status text NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_profiles_owner_priority_idx
  ON model_profiles (owner_user_id, enabled, priority, created_at);

CREATE TABLE IF NOT EXISTS model_routing_settings (
  owner_user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'fixed')),
  active_profile_ref text,
  last_used_profile_ref text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_routing_settings (owner_user_id, mode, active_profile_ref)
VALUES ('00000000-0000-4000-8000-000000000001', 'auto', 'env-primary')
ON CONFLICT (owner_user_id) DO NOTHING;
