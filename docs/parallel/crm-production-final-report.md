# CRM Production Final — Relationship Layer

Branch: `arena/crm-production-final`  
Base: `arena/01a10817-kolbevintage`

## Scope

This change finalizes the CRM/Backoffice relationship layer only. It does **not** redesign or replace Product Lifecycle, Pricing, Wholesale OMS, WMS, Supplier Fulfillment, Inbound/QC, Shipment or Discount/Festival core workflows.

Core domains remain source-of-truth. CRM consumes their read models and provides relationship-owned state only.

## Canonical CRM IA

1. **نمای کلی**
   - Relationship KPIs
   - Global CRM search
   - Create lead
   - Action queue
2. **مخاطبان**
   - Retail customers
   - VIP buyers
   - Suppliers
3. **پیگیری‌ها**
   - Open / overdue / today / upcoming / unassigned
4. **بازاریابی**
   - Labels
   - Rules
   - Dynamic segments
   - Targeted campaigns
   - Upcoming events

## Relationship ownership

CRM owns:
- relationship owner
- lifecycle stage
- relationship priority
- next follow-up
- CRM tasks
- CRM interactions
- internal CRM notes
- labels
- segments
- marketing consent/audience
- standalone leads

CRM does not own:
- order state
- membership lifecycle/payment/refund
- inventory
- supplier capacity
- inbound/QC
- settlements
- finance ledger
- pricing/promotion truth

## New schema

Migration: `071_crm_relationship_operations.sql`

Added to `crm_contacts`:
- `owner_user_id`
- `lifecycle_stage`
- `priority`
- `next_followup_at`
- `last_interaction_at`
- standalone lead identity fields

New tables:
- `crm_tasks`
- `crm_interactions`

Canonical legacy policy:
- `crm_contacts.tags` is read-compat only; use `crm_labels/crm_contact_labels`
- `crm_contacts.segment` is read-compat only; use `crm_segments/crm_segment_members`
- `crm_notes` is the canonical note store
- do not create new `crm_activities(type='note')`
- Automation Center is the canonical automation surface; legacy CRM automation rows are not a second UI

## Lead lifecycle

Standalone leads can be created without a platform user.

When the person registers:
- CRM can link the lead to a canonical user.
- If that user already has a CRM contact, the lead is merged into it.
- Notes, tasks, interactions, legacy activities and labels are retained.
- The old lead contact is removed after migration.
- The merge is audited.

Duplicate lead creation by matching phone/email is rejected.

## Follow-up semantics

The canonical operational queue is `crm_tasks`.

An interaction with a next-follow-up date automatically creates a task so the action cannot disappear from the Action Center.

Completing/rescheduling a task updates the denormalized next-follow-up hint on the CRM contact.

## Supplier CRM boundary

The Supplier CRM 360 surface is now relationship-only.

It may show read-only summaries from:
- Orders
- WMS
- QC
- Finance
- Support

It no longer exposes those domains' mutation workflows from CRM.

The previous “supplier journey from application to settlement” navigation strip was removed from CRM.

## VIP CRM boundary

VIP CRM keeps membership status/history as read-only context.

Removed from CRM:
- plan changes
- suspension/reactivation
- membership refund

Those actions remain in the canonical membership domain.

## Marketing UX hardening

- Rule fields are displayed in Persian.
- Operators are displayed in Persian.
- Raw segment UUIDs are hidden.
- Campaign audience selector uses segment title + member count.
- Segment member action opens a real member workspace.
- Member workspace shows only fields actually returned by the backend.
- Internal codes remain backend values, not operator-facing text.

## Retail fix

The list column that displayed `created_at` is now correctly titled **تاریخ عضویت** instead of **عضویت**.

## Search

Global CRM search covers:
- all canonical platform users
- suppliers
- wholesale buyers
- CRM standalone leads

A GET search never mutates state. A CRM contact is created lazily only when the operator opens relationship data for a canonical user that does not yet have one.

## Auditability

Mutations added by the relationship layer are written to `audit_logs`.

Interactions for linked users are also projected into `customer_timeline`.

## Test coverage

Added:
- `backend/src/crm-relationship.test.ts`

Covers:
- lead creation
- duplicate prevention
- global search
- task creation
- interaction + automatic follow-up task
- note on standalone lead
- relationship dossier
- conversion/merge into canonical user
- action-center persistence

The test is included in the backend `test` command.

## Deployment gate

Before merging/deploying, execute from a clean checkout:

```bash
npm ci
npm run build
cd backend
npm ci
npm run build
npm test
npm run test:contract
npm run test:browser
```

Then apply migrations in staging and smoke-test:
1. Admin → CRM → نمای کلی
2. Create standalone lead
3. Assign owner and create follow-up
4. Record interaction with next follow-up
5. Search canonical customer and open relationship dossier
6. Open Retail 360
7. Open VIP 360 and verify membership operations are read-only
8. Open Supplier CRM 360 and verify operational WMS/QC/Finance mutations are absent
9. Open a segment and inspect members
10. Preview a campaign and verify consent/frequency-cap breakdown

## Current verification status

Repository changes are complete on the branch, but a local build/test run could not be executed from the current tool environment because outbound DNS access to GitHub was unavailable. Therefore this branch must not be described as **verified production-ready** until the deployment gate above passes in a normal development/CI environment.
