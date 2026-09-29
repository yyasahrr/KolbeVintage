-- =========================================================================
-- merged from 018_automation_tracking.sql when this branch's migrations moved to the 045-049 slot
-- =========================================================================
-- Requirements 85-94 + 121: the Automation Center (n8n and future platforms),
-- the automation event contract, HMAC-protected delivery with retry/backoff and
-- replay protection, and the shipment tracking center with import review.

-- The outbox is the single source of truth for domain events. These columns turn it
-- into a durable, retryable queue that external workflows can rely on (item 89).
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'domain';
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS outbox_events_pending_idx ON outbox_events(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS automation_subscriptions (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  event_patterns text[] NOT NULL DEFAULT '{}',
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  target_url text,
  enabled boolean NOT NULL DEFAULT true,
  hmac_enabled boolean NOT NULL DEFAULT true,
  timeout_ms integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 500 AND 30000),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  backoff_seconds integer NOT NULL DEFAULT 30 CHECK (backoff_seconds BETWEEN 1 AND 3600),
  max_events_per_minute integer NOT NULL DEFAULT 120,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE automation_subscriptions IS 'Outbound workflow endpoints (n8n webhooks and future platforms). Secrets stay in integrations.';

CREATE TABLE IF NOT EXISTS automation_deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failure', 'dead', 'skipped')),
  attempt integer NOT NULL DEFAULT 0,
  http_status integer,
  duration_ms integer,
  request_body jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  signature text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_deliveries_unique_idx ON automation_deliveries(event_id, subscription_id);
CREATE INDEX IF NOT EXISTS automation_deliveries_status_idx ON automation_deliveries(status, next_attempt_at);

-- Replay protection for inbound automation webhooks (item 88).
CREATE TABLE IF NOT EXISTS automation_webhook_receipts (
  id uuid PRIMARY KEY,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  signature_hash char(64) NOT NULL,
  payload_hash char(64) NOT NULL,
  timestamp_header text,
  is_replay boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, signature_hash)
);

/* ---------------------------- shipment tracking ---------------------------- */

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  buyer_id uuid REFERENCES users(id),
  carrier text,
  tracking_code text,
  status text NOT NULL DEFAULT 'created',
  origin text,
  destination text,
  contact_phone text,
  shipped_at timestamptz,
  last_location text,
  last_status_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipments_tracking_idx ON shipments(tracking_code);
CREATE INDEX IF NOT EXISTS shipments_order_idx ON shipments(order_id);
CREATE INDEX IF NOT EXISTS shipments_status_idx ON shipments(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS shipment_tracking_events (
  id uuid PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status text NOT NULL,
  location text,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('carrier_api', 'carrier_website', 'n8n', 'manual',
    'pdf', 'excel', 'csv', 'email', 'upload', 'webhook')),
  raw_reference text,
  confidence numeric(5, 4) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  review_status text NOT NULL DEFAULT 'confirmed' CHECK (review_status IN ('confirmed', 'needs_review', 'rejected')),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_tracking_events_shipment_idx ON shipment_tracking_events(shipment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS shipment_tracking_events_review_idx ON shipment_tracking_events(review_status);

CREATE TABLE IF NOT EXISTS tracking_imports (
  id uuid PRIMARY KEY,
  source text NOT NULL DEFAULT 'n8n',
  file_ref text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'partial', 'failed')),
  item_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  needs_review_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS tracking_import_items (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES tracking_imports(id) ON DELETE CASCADE,
  order_reference text,
  tracking_code text,
  carrier text,
  status_taken text,
  location text,
  occurred_at timestamptz,
  confidence numeric(5, 4) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('matched', 'needs_review', 'failed', 'rejected')),
  shipment_id uuid REFERENCES shipments(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  problem text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracking_import_items_import_idx ON tracking_import_items(import_id, status);

