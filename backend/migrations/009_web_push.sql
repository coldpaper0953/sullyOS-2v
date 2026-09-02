CREATE UNIQUE INDEX IF NOT EXISTS outbox_event_delivery_idx
  ON outbox (event_id, delivery_type);

CREATE INDEX IF NOT EXISTS push_subscriptions_enabled_idx
  ON push_subscriptions (owner_user_id, enabled, updated_at DESC)
  WHERE enabled = true;
