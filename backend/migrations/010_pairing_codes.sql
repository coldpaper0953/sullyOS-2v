CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pairing_codes_expires_idx
  ON pairing_codes (expires_at)
  WHERE used_at IS NULL;
