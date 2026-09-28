CREATE TABLE sms_deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(id),
  user_id uuid NOT NULL REFERENCES users(id),
  phone text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','unknown')),
  provider_reference text,
  attempted_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_deliveries_queued_idx ON sms_deliveries(created_at) WHERE status = 'queued';
