-- Recover follow-ups saved as contact hints before crm_tasks became canonical.
-- Keep legacy data; create a task only when the contact has no dated open task.
INSERT INTO crm_tasks(id,contact_id,title,assigned_to,due_at,priority)
SELECT gen_random_uuid(),c.id,'پیگیری ثبت‌شده قبلی',c.owner_user_id,c.next_followup_at,c.priority
FROM crm_contacts c
WHERE c.next_followup_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.contact_id=c.id AND t.status='open' AND t.due_at IS NOT NULL);

UPDATE crm_contacts c SET next_followup_at=(
  SELECT min(t.due_at) FROM crm_tasks t WHERE t.contact_id=c.id AND t.status='open');
