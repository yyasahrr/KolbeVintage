-- CRM relationship operations: human follow-up layer over canonical customer/supplier data.
-- Core commerce domains remain source-of-truth; CRM stores only relationship-owned state.

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'active'
  CHECK (lifecycle_stage IN ('lead','prospect','active','loyal','at_risk','dormant','churned','partner'));
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS next_followup_at timestamptz;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS last_interaction_at timestamptz;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS lead_name text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS lead_phone text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS lead_email text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS organization text;

CREATE INDEX IF NOT EXISTS crm_contacts_owner_followup_idx
  ON crm_contacts(owner_user_id, next_followup_at) WHERE next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_contacts_lifecycle_idx ON crm_contacts(lifecycle_stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_tasks (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at timestamptz,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_tasks_queue_idx ON crm_tasks(status, due_at, priority);
CREATE INDEX IF NOT EXISTS crm_tasks_contact_idx ON crm_tasks(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_tasks_assignee_idx ON crm_tasks(assigned_to, status, due_at);

CREATE TABLE IF NOT EXISTS crm_interactions (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('call','sms','whatsapp','email','meeting','other')),
  outcome text NOT NULL CHECK (outcome IN ('successful','no_answer','follow_up','closed','neutral')),
  subject text NOT NULL,
  body text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  next_followup_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_interactions_contact_idx ON crm_interactions(contact_id, occurred_at DESC);

COMMENT ON COLUMN crm_contacts.segment IS 'LEGACY: read compatibility only. Canonical segmentation is crm_segments/crm_segment_members.';
COMMENT ON COLUMN crm_contacts.tags IS 'LEGACY: read compatibility only. Canonical tagging is crm_labels/crm_contact_labels.';
COMMENT ON TABLE crm_notes IS 'Canonical internal human notes. Do not create new crm_activities rows with type=note.';
