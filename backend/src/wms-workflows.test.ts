import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { createPool } from './db.js';
import { applyVerifiedPayment } from './payments.js';

/**
 * WMS / Supplier Requests / Series / Festival-XOR workflows (sections A, D, G-K, P-R).
 * Covers acceptance scenarios Y1-3, Y12-22, Y23-35, Y36-41, Y46-57.
 */

const testDbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const baseConfig: Config = {
  NODE_ENV: 'test', PORT: 4051, DATABASE_URL: testDbUrl ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 2,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type App = Awaited<ReturnType<typeof buildApp>>;
type Pool = ReturnType<typeof createPool>;

async function createActors(app: App, pool: Pool, suffix: string) {
  const adminId = randomUUID();
  const supplierId = randomUUID();
  const supplier2Id = randomUUID();
  const passwordHash = await argon2.hash('StrongPass123456!');
  await pool.query(
    `INSERT INTO users(id, email, password_hash, display_name) VALUES
     ($1, $2, $3, 'مدیر'), ($4, $5, $3, 'تأمین‌کننده'), ($6, $7, $3, 'تأمین‌کننده دوم')`,
    [adminId, `wms-admin-${suffix}@kolbe.test`, passwordHash,
      supplierId, `wms-sup-${suffix}@kolbe.test`, supplier2Id, `wms-sup2-${suffix}@kolbe.test`]);
  await pool.query(
    `INSERT INTO user_roles(user_id, role_code) VALUES ($1,'admin'),($2,'supplier'),($3,'supplier')`,
    [adminId, supplierId, supplier2Id]);
  await pool.query(
    `INSERT INTO supplier_profiles(user_id, brand_name, legal_name, cooperation_status)
     VALUES ($1, 'برند تست', 'شرکت تست', 'approved'), ($2, 'برند تست دو', 'شرکت تست دو', 'approved')`,
    [supplierId, supplier2Id]);
  const loginAs = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password: 'StrongPass123456!' } });
    assert.equal(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().accessToken as string}` };
  };
  return {
    adminId, supplierId, supplier2Id,
    adminHeaders: await loginAs(`wms-admin-${suffix}@kolbe.test`),
    supplierHeaders: await loginAs(`wms-sup-${suffix}@kolbe.test`),
    supplier2Headers: await loginAs(`wms-sup2-${suffix}@kolbe.test`),
  };
}

async function createWarehouse(app: App, headers: Record<string, string>, code: string, name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers, payload: { code, name } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function balance(pool: Pool, variantId: string, warehouseId: string, domain: string) {
  const res = await pool.query(
    `SELECT on_hand, reserved, incoming, damaged FROM stock_balances
     WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
    [variantId, warehouseId, domain]);
  if (res.rows.length === 0) return { on_hand: 0, reserved: 0, incoming: 0, damaged: 0 };
  const row = res.rows[0];
  return { on_hand: Number(row.on_hand), reserved: Number(row.reserved), incoming: Number(row.incoming), damaged: Number(row.damaged) };
}

test('WMS core: receipts honor their domain + discrepancy, transfers enforce G1-G4/Q, reverse transfers H', { skip: !testDbUrl }, async () => {
  const app = await buildApp(baseConfig);
  const pool = createPool(baseConfig);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { adminHeaders, supplierHeaders } = await createActors(app, pool, suffix);
    const kolbeWh = await createWarehouse(app, adminHeaders, `KW${suffix.slice(0, 6).toUpperCase()}`, 'انبار مرکزی');

    // Supplier-owned product (owner_type = supplier).
    const supProduct = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders, payload: {
      brand: 'Sup', name: `کفش عمده ${suffix}`, category: 'کفش', cashPriceRial: '4000000', wholesalePriceRial: '2500000',
      variants: [{ size: '41', color: 'black' }, { size: '42', color: 'black' }],
    } });
    assert.equal(supProduct.statusCode, 201, supProduct.body);
    const supProductId = supProduct.json().id as string;
    const supVariant = (supProduct.json().variants as Array<{ id: string }>)[0]!;

    // --- Y1-3 + R: receipt created for WHOLESALE must receive into WHOLESALE (D1 fix) with discrepancy capture.
    const receipt = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts',
      headers: { ...adminHeaders, 'idempotency-key': `rc-${suffix}-1` },
      payload: { warehouseId: kolbeWh, variantId: supVariant.id, inventoryDomain: 'wholesale', quantity: 80 } });
    assert.equal(receipt.statusCode, 201, receipt.body);
    let wholesale = await balance(pool, supVariant.id, kolbeWh, 'wholesale');
    assert.equal(wholesale.incoming, 80, 'incoming goes to the wholesale domain');
    assert.equal(wholesale.on_hand, 0, 'J: on_hand untouched before receive');

    const receive = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receipt.json().id}/receive`,
      headers: adminHeaders, payload: { receivedQuantity: 78 } });
    assert.equal(receive.statusCode, 200, receive.body);
    assert.equal(receive.json().inventoryDomain, 'wholesale');
    assert.equal(receive.json().missingQuantity, 2, 'R: missing quantity recorded, not silently confirmed');
    wholesale = await balance(pool, supVariant.id, kolbeWh, 'wholesale');
    assert.equal(wholesale.on_hand, 78, 'wholesale on_hand gets exactly the received quantity');
    assert.equal(wholesale.incoming, 0);
    const retail = await balance(pool, supVariant.id, kolbeWh, 'retail');
    assert.equal(retail.on_hand, 0, 'D1: retail domain untouched by a wholesale receipt');
    const discrepancyEvent = await pool.query(
      `SELECT 1 FROM outbox_events WHERE event_type = 'inventory.receipt_discrepancy' AND aggregate_id = $1`, [receipt.json().id]);
    assert.equal(discrepancyEvent.rows.length, 1, 'discrepancy emits a first-class event');

    // --- G1: supplier-owned stock cannot enter retail without a REAL completed conversion.
    const blockedTransfer = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `tr-${suffix}-blocked` },
      payload: { variantId: supVariant.id, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: kolbeWh, destinationWarehouseId: kolbeWh, quantity: 10, reason: 'تست انتقال بدون تملک' } });
    assert.equal(blockedTransfer.statusCode, 403, blockedTransfer.body);

    // A conversion that is NOT completed must not unlock transfers.
    const draftConvId = randomUUID();
    await pool.query(
      `INSERT INTO ownership_conversions(id, reference, conversion_number, product_id, variant_id, from_owner_type, to_owner_type, conversion_type, quantity, status)
       VALUES ($1,$2,$2,$3,$4,'supplier','kolbe','purchase_acquisition',100,'draft')`,
      [draftConvId, `OWN-D-${suffix}`, supProductId, supVariant.id]);
    const stillBlocked = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `tr-${suffix}-draftconv` },
      payload: { variantId: supVariant.id, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: kolbeWh, destinationWarehouseId: kolbeWh, quantity: 10, reason: 'تست با سند پیش‌نویس',
        ownershipConversionId: draftConvId } });
    assert.equal(stillBlocked.statusCode, 403, 'G1: draft/stale conversion must not authorize transfer');

    // Real variant-scoped completed conversion with quantity 20.
    const conv = await app.inject({ method: 'POST', url: '/api/v1/inventory/ownership-conversions',
      headers: { ...adminHeaders, 'idempotency-key': `own-${suffix}-1` },
      payload: { productId: supProductId, variantId: supVariant.id, quantity: 20, conversionType: 'purchase_buyout', unitCostRial: 1500000 } });
    assert.equal(conv.statusCode, 201, conv.body);
    const convId = conv.json().id as string;

    // Capacity accounting: requesting more than the converted quantity is rejected.
    const overCapacity = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `tr-${suffix}-over` },
      payload: { variantId: supVariant.id, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: kolbeWh, destinationWarehouseId: kolbeWh, quantity: 25, reason: 'بیش از ظرفیت سند',
        ownershipConversionId: convId } });
    assert.equal(overCapacity.statusCode, 403, overCapacity.body);

    // --- G4: reserved stock blocks transfer beyond available.
    await pool.query(
      `UPDATE stock_balances SET reserved = 70 WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale'`,
      [supVariant.id, kolbeWh]); // available = 78-70 = 8
    const notAvailable = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `tr-${suffix}-resv` },
      payload: { variantId: supVariant.id, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: kolbeWh, destinationWarehouseId: kolbeWh, quantity: 10, reason: 'تست رزرو',
        ownershipConversionId: convId } });
    assert.equal(notAvailable.statusCode, 409, 'G4: reserved stock is not transferable');

    // --- G3: transferring 100% of available stock needs explicit confirmation.
    const fullNoConfirm = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `tr-${suffix}-full` },
      payload: { variantId: supVariant.id, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: kolbeWh, destinationWarehouseId: kolbeWh, quantity: 8, reason: 'انتقال کل موجودی',
        ownershipConversionId: convId } });
    assert.equal(fullNoConfirm.statusCode, 400, 'G3: full transfer without confirmFullStock rejected');

    // Partial transfer of 6 with batch reference works (G5 variant-level, G6 batch).
    const transfer = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `tr-${suffix}-ok` },
      payload: { variantId: supVariant.id, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: kolbeWh, destinationWarehouseId: kolbeWh, quantity: 6, reason: 'انتقال رسمی به خرده',
        ownershipConversionId: convId, batchReference: `BAG-${suffix}` } });
    assert.equal(transfer.statusCode, 201, transfer.body);
    const transferId = transfer.json().id as string;
    assert.match(transfer.json().transferNumber as string, /^TRF-\d+$/);
    const usedAfterCreate = await pool.query('SELECT used_quantity FROM ownership_conversions WHERE id = $1', [convId]);
    assert.equal(Number(usedAfterCreate.rows[0].used_quantity), 6, 'conversion capacity consumed at creation');

    // Approve (goods leave source), then complete (goods received at destination).
    const approve = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${transferId}/approve`, headers: adminHeaders });
    assert.equal(approve.statusCode, 200, approve.body);
    const complete = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${transferId}/complete`, headers: adminHeaders });
    assert.equal(complete.statusCode, 200, complete.body);

    const retailAfter = await balance(pool, supVariant.id, kolbeWh, 'retail');
    assert.equal(retailAfter.on_hand, 6);
    // Q: the transfer must NOT auto-publish / auto-enable retail sale.
    const productRow = await pool.query('SELECT retail_enabled, status FROM products WHERE id = $1', [supProductId]);
    assert.equal(productRow.rows[0].retail_enabled, false, 'Q: transfer does not enable retail sale');

    // H: completed transfers are immutable — direct cancel is rejected.
    const cancelCompleted = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${transferId}/cancel`, headers: adminHeaders });
    assert.equal(cancelCompleted.statusCode, 409, 'completed transfer cannot be cancelled/edited');

    // Simulate 2 retail units sold so only 4 remain free → reverse is capped.
    await pool.query(
      `UPDATE stock_balances SET on_hand = on_hand - 2 WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'retail'`,
      [supVariant.id, kolbeWh]);
    const reverseTooMuch = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${transferId}/reverse`,
      headers: { ...adminHeaders, 'idempotency-key': `rv-${suffix}-big` },
      payload: { quantity: 6, reason: 'برگشت کامل غیرمجاز' } });
    assert.equal(reverseTooMuch.statusCode, 409, 'H: sold stock cannot be reversed');

    const reverse = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${transferId}/reverse`,
      headers: { ...adminHeaders, 'idempotency-key': `rv-${suffix}-ok` },
      payload: { quantity: 3, reason: 'برگشت بخشی از انتقال' } });
    assert.equal(reverse.statusCode, 201, reverse.body);
    assert.match(reverse.json().transferNumber as string, /^RTRF-\d+$/, 'RTRF numbering mirrors the original');
    assert.equal(reverse.json().originalTransferId, transferId);

    const retailAfterReverse = await balance(pool, supVariant.id, kolbeWh, 'retail');
    assert.equal(retailAfterReverse.on_hand, 1, '4 free - 3 reversed = 1');
    const wholesaleAfterReverse = await balance(pool, supVariant.id, kolbeWh, 'wholesale');
    assert.equal(wholesaleAfterReverse.on_hand, 72 + 3, 'reversed stock returns to wholesale');
    const originalRow = await pool.query('SELECT reversed_quantity FROM stock_transfers WHERE id = $1', [transferId]);
    assert.equal(Number(originalRow.rows[0].reversed_quantity), 3);
    const usedAfterReverse = await pool.query('SELECT used_quantity FROM ownership_conversions WHERE id = $1', [convId]);
    assert.equal(Number(usedAfterReverse.rows[0].used_quantity), 3, 'reverse restores conversion capacity');

    // Remaining reversible is 3, but only 1 unit is free → capped again.
    const reverseRemainder = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${transferId}/reverse`,
      headers: { ...adminHeaders, 'idempotency-key': `rv-${suffix}-rest` },
      payload: { quantity: 2, reason: 'برگشت بیش از موجودی آزاد' } });
    assert.equal(reverseRemainder.statusCode, 409);

    // D3/O1: inventory listing exposes computed stock_status and searches by color.
    const inv = await app.inject({ method: 'GET', url: `/api/v1/inventory?search=black&inventoryDomain=retail`, headers: adminHeaders });
    assert.equal(inv.statusCode, 200, inv.body);
    const invRow = (inv.json().items as Array<Record<string, unknown>>).find((r) => r.variant_id === supVariant.id);
    assert.ok(invRow, 'search by color label finds the row');
    assert.ok(['low_stock', 'in_stock'].includes(invRow!.stock_status as string), 'stock_status is computed server-side');
  } finally {
    await app.close();
    await pool.end();
  }
});

test('Supplier requests: max 10 items, RBAC, review lifecycle, dispatch→incoming→receive (I/J/S)', { skip: !testDbUrl }, async () => {
  const app = await buildApp(baseConfig);
  const pool = createPool(baseConfig);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { adminHeaders, supplierHeaders, supplier2Headers, supplierId } = await createActors(app, pool, suffix);
    const kolbeWh = await createWarehouse(app, adminHeaders, `SQ${suffix.slice(0, 6).toUpperCase()}`, 'انبار عمده');

    const supProduct = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders, payload: {
      brand: 'Sup', name: `بوت تأمین ${suffix}`, category: 'کفش', cashPriceRial: '5000000', wholesalePriceRial: '3000000',
      variants: [{ size: '40', color: 'brown' }, { size: '41', color: 'brown' }],
    } });
    assert.equal(supProduct.statusCode, 201, supProduct.body);
    const variants = supProduct.json().variants as Array<{ id: string }>;

    // Y24: 11 items rejected server-side.
    const elevenItems = Array.from({ length: 11 }, (_, i) => ({
      itemType: 'new_product', proposedName: `محصول ${i}`, quantity: 5,
    }));
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/supplier-requests',
      headers: { ...supplierHeaders, 'idempotency-key': `sr-${suffix}-11` },
      payload: { items: elevenItems } });
    assert.equal(tooMany.statusCode, 400, 'max 10 items is server-enforced');

    // Y23: mixed request (replenishment + new product).
    const created = await app.inject({ method: 'POST', url: '/api/v1/supplier-requests',
      headers: { ...supplierHeaders, 'idempotency-key': `sr-${suffix}-ok` },
      payload: { note: 'سری جدید پاییزه', items: [
        { itemType: 'replenishment', variantId: variants[0]!.id, quantity: 30 },
        { itemType: 'replenishment', variantId: variants[1]!.id, quantity: 20 },
        { itemType: 'new_product', proposedName: 'بوت چرم جدید', proposedColor: 'مشکی', proposedSize: '42', quantity: 10 },
      ] } });
    assert.equal(created.statusCode, 201, created.body);
    const requestId = created.json().id as string;
    assert.match(created.json().requestNumber as string, /^SR-\d+$/);

    // RBAC: another supplier cannot see this request.
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/supplier-requests/${requestId}`, headers: supplier2Headers });
    assert.equal(foreign.statusCode, 403, 'supplier isolation on requests');

    // Y26: rejection without a detailed reason is refused.
    const rejectNoReason = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${requestId}/review`,
      headers: adminHeaders, payload: { decision: 'reject' } });
    assert.equal(rejectNoReason.statusCode, 400, 'detailed rejection reason is mandatory');

    // Y30: request revision → supplier revises → resubmitted with history preserved.
    const askRevision = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${requestId}/review`,
      headers: adminHeaders, payload: { decision: 'request_revision', reason: 'تعداد بوت چرم را کاهش دهید' } });
    assert.equal(askRevision.statusCode, 200, askRevision.body);

    const revised = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${requestId}/revise`,
      headers: supplierHeaders, payload: { note: 'نسخه اصلاح‌شده', items: [
        { itemType: 'replenishment', variantId: variants[0]!.id, quantity: 30 },
        { itemType: 'new_product', proposedName: 'بوت چرم جدید', proposedColor: 'مشکی', proposedSize: '42', quantity: 5 },
      ] } });
    assert.equal(revised.statusCode, 200, revised.body);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/supplier-requests/${requestId}`, headers: adminHeaders });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().status, 'submitted');
    assert.ok((detail.json().revisions as unknown[]).length >= 2, 'revision history preserved');

    // Y27/28: approval notifies the supplier and does NOT change stock.
    const approve = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${requestId}/review`,
      headers: adminHeaders, payload: { decision: 'approve' } });
    assert.equal(approve.statusCode, 200, approve.body);
    let bal = await balance(pool, variants[0]!.id, kolbeWh, 'wholesale');
    assert.equal(bal.on_hand + bal.incoming, 0, 'I: approval never increases stock');
    const supplierNotif = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE '%تأیید شد%'`, [supplierId]);
    assert.ok(supplierNotif.rows.length >= 1, 'S: supplier notified of approval');

    // Y31/32/J: dispatch creates wholesale INCOMING (not on_hand); new-product item stays pending.
    const dispatch = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${requestId}/dispatch`,
      headers: supplierHeaders, payload: { warehouseId: kolbeWh, batchReference: `CTN-${suffix}`, carrier: 'تیپاکس' } });
    assert.equal(dispatch.statusCode, 200, dispatch.body);
    assert.equal((dispatch.json().receipts as unknown[]).length, 1, 'only variant-backed items create receipts');
    bal = await balance(pool, variants[0]!.id, kolbeWh, 'wholesale');
    assert.equal(bal.incoming, 30, 'J: dispatched goods are incoming');
    assert.equal(bal.on_hand, 0, 'J: on_hand stays untouched until receive');

    // Y33: receive with discrepancy (28 of 30) → on_hand 28, missing 2 recorded, request marked received.
    const receiptId = (dispatch.json().receipts as Array<{ id: string }>)[0]!.id;
    const receive = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receiptId}/receive`,
      headers: adminHeaders, payload: { receivedQuantity: 28 } });
    assert.equal(receive.statusCode, 200, receive.body);
    bal = await balance(pool, variants[0]!.id, kolbeWh, 'wholesale');
    assert.equal(bal.on_hand, 28);
    assert.equal(bal.incoming, 0);
    const reqRow = await pool.query('SELECT status FROM supplier_requests WHERE id = $1', [requestId]);
    assert.equal(reqRow.rows[0].status, 'received');

    // Close after all receipts resolved.
    const close = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${requestId}/close`, headers: adminHeaders });
    assert.equal(close.statusCode, 200, close.body);

    // Y25: a fresh request rejected WITH reason is visible to the supplier.
    const second = await app.inject({ method: 'POST', url: '/api/v1/supplier-requests',
      headers: { ...supplierHeaders, 'idempotency-key': `sr-${suffix}-2` },
      payload: { items: [{ itemType: 'replenishment', variantId: variants[1]!.id, quantity: 10 }] } });
    assert.equal(second.statusCode, 201, second.body);
    const reject = await app.inject({ method: 'POST', url: `/api/v1/supplier-requests/${second.json().id}/review`,
      headers: adminHeaders, payload: { decision: 'reject', reason: 'کیفیت نمونه ارسالی قبلی مورد تأیید نبود' } });
    assert.equal(reject.statusCode, 200, reject.body);
    const rejectedDetail = await app.inject({ method: 'GET', url: `/api/v1/supplier-requests/${second.json().id}`, headers: supplierHeaders });
    assert.equal(rejectedDetail.json().status, 'rejected');
    assert.match(rejectedDetail.json().rejection_reason as string, /کیفیت نمونه/);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('Series: relational templates, availability from component stock, atomic series ordering (K)', { skip: !testDbUrl }, async () => {
  const app = await buildApp(baseConfig);
  const pool = createPool(baseConfig);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { adminHeaders } = await createActors(app, pool, suffix);
    const kolbeWh = await createWarehouse(app, adminHeaders, `SE${suffix.slice(0, 6).toUpperCase()}`, 'انبار سری');

    // VIP buyer with active membership.
    const vipId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [vipId, `series-vip-${suffix}@kolbe.test`, await argon2.hash('StrongPass123456!'), 'خریدار سری']);
    await pool.query(`INSERT INTO user_roles(user_id, role_code) VALUES ($1,'customer')`, [vipId]);
    const vipLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `series-vip-${suffix}@kolbe.test`, password: 'StrongPass123456!' } });
    const vipHeaders = { authorization: `Bearer ${vipLogin.json().accessToken as string}` };
    const plan = await app.inject({ method: 'POST', url: '/api/v1/plans', headers: adminHeaders, payload: {
      code: `series-${suffix}`, title: 'پلن سری', annualPriceRial: '10000000',
      limits: { sources: 'all', maxOrdersPerMonth: 50, maxOrderValueRial: '50000000000', maxSuppliersPerOrder: 10, discountPercent: 0, prioritySupport: false },
    } });
    assert.equal(plan.statusCode, 201, plan.body);
    const membership = await app.inject({ method: 'POST', url: '/api/v1/memberships',
      headers: { ...vipHeaders, 'idempotency-key': `series-mem-${suffix}` }, payload: { planId: plan.json().id } });
    assert.equal(membership.statusCode, 201, membership.body);
    await applyVerifiedPayment(pool, {
      provider: 'verified-test-adapter', providerEventId: `series-evt-${suffix}`, providerReference: `series-ref-${suffix}`,
      intentId: membership.json().paymentIntentId, amountRial: '10000000', paidAt: new Date(),
    });

    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders, payload: {
      brand: 'Kolbe', name: `کتانی سری ${suffix}`, category: 'کفش', cashPriceRial: '6000000', wholesalePriceRial: '3500000',
      variants: [{ size: '40', color: 'white' }, { size: '41', color: 'white' }, { size: '42', color: 'white' }],
    } });
    assert.equal(product.statusCode, 201, product.body);
    const productId = product.json().id as string;
    const variants = product.json().variants as Array<{ id: string; sku: string }>;
    await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: adminHeaders, payload: { status: 'published' } });

    // Wholesale stock: 40→10, 41→10, 42→3 (42 is the limiting component).
    for (const [i, qty] of [10, 10, 3].entries()) {
      await pool.query(
        `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain, on_hand) VALUES ($1,$2,'wholesale',$3)`,
        [variants[i]!.id, kolbeWh, qty]);
    }

    // K1: relational recipe 1-2-1.
    const template = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers: adminHeaders, payload: {
      productId, name: `سری استاندارد ${suffix}`,
      items: [
        { variantId: variants[0]!.id, quantityPerSeries: 1 },
        { variantId: variants[1]!.id, quantityPerSeries: 2 },
        { variantId: variants[2]!.id, quantityPerSeries: 1 },
      ],
    } });
    assert.equal(template.statusCode, 201, template.body);
    const templateId = template.json().id as string;

    // K2/K3: composition + available series = min(10/1, 10/2, 3/1) = 3.
    const compo = await app.inject({ method: 'GET', url: `/api/v1/series-templates/${templateId}`, headers: vipHeaders });
    assert.equal(compo.statusCode, 200, compo.body);
    assert.equal(compo.json().pairsPerSeries, 4);
    assert.equal(compo.json().availableSeries, 3, 'available series derives from component stock');

    // K4: ordering 4 series (needs 42×4 but only 3 available) fails atomically — nothing reserved.
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...vipHeaders, 'idempotency-key': `series-ord-fail-${suffix}` },
      payload: { orderType: 'wholesale', series: [{ seriesTemplateId: templateId, count: 4 }] } });
    assert.equal(tooMany.statusCode, 409, tooMany.body);
    for (const v of variants) {
      const bal = await balance(pool, v.id, kolbeWh, 'wholesale');
      assert.equal(bal.reserved, 0, 'K4: failed series order reserves nothing');
    }

    // Ordering 2 series succeeds and reserves exactly the recipe quantities.
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...vipHeaders, 'idempotency-key': `series-ord-ok-${suffix}` },
      payload: { orderType: 'wholesale', series: [{ seriesTemplateId: templateId, count: 2 }] } });
    assert.equal(order.statusCode, 201, order.body);
    const expected = [2, 4, 2];
    for (const [i, v] of variants.entries()) {
      const bal = await balance(pool, v.id, kolbeWh, 'wholesale');
      assert.equal(bal.reserved, expected[i], `component ${v.sku} reserved per recipe`);
    }
    // JSON only as snapshot: composition snapshot audited on the order.
    const snapshot = await pool.query(
      `SELECT 1 FROM outbox_events WHERE event_type = 'order.series_snapshot' AND aggregate_id = $1`, [order.json().orderId ?? order.json().id]);
    assert.ok(snapshot.rows.length >= 1, 'series composition snapshot stored with the order');

    // Availability after reservation: min((10-2)/1, (10-4)/2, (3-2)/1) = 1.
    const compoAfter = await app.inject({ method: 'GET', url: `/api/v1/series-templates/${templateId}`, headers: adminHeaders });
    assert.equal(compoAfter.json().availableSeries, 1);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('Festival XOR standalone discounts (A5/A6) + product delete guard (P)', { skip: !testDbUrl }, async () => {
  const app = await buildApp(baseConfig);
  const pool = createPool(baseConfig);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { adminHeaders } = await createActors(app, pool, suffix);

    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders, payload: {
      brand: 'Kolbe', name: `پیراهن جشنواره ${suffix}`, category: 'پیراهن', cashPriceRial: '1000000',
      variants: [{ size: 'M', color: 'blue' }],
    } });
    assert.equal(product.statusCode, 201, product.body);
    const productId = product.json().id as string;
    const variantId = (product.json().variants as Array<{ id: string }>)[0]!.id;
    await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: adminHeaders, payload: { status: 'published' } });

    // Standalone 10% rule → price 900,000.
    const standalone = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers: adminHeaders, payload: {
      targetType: 'product', productId, discountType: 'percent', discountValue: 10, name: 'تخفیف مستقل' } });
    assert.equal(standalone.statusCode, 201, standalone.body);
    const standaloneRuleId = standalone.json().id as string;

    let price = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${variantId}` });
    assert.equal(price.json().finalPrice, '900000');

    // Festival A (20%, exclusive): entering it suspends the standalone rule.
    const festivalA = await app.inject({ method: 'POST', url: '/api/v1/promotions', headers: adminHeaders, payload: {
      name: `جشنواره یلدا ${suffix}`, kind: 'festival', exclusivePolicy: 'festival_exclusive', channel: 'all' } });
    assert.equal(festivalA.statusCode, 201, festivalA.body);
    const festivalAId = festivalA.json().id as string;
    const festARule = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers: adminHeaders, payload: {
      promotionId: festivalAId, targetType: 'product', productId, discountType: 'percent', discountValue: 20, name: 'قانون یلدا' } });
    assert.equal(festARule.statusCode, 201, festARule.body);

    const suspended = await pool.query('SELECT suspended_by_promotion_id FROM promotion_rules WHERE id = $1', [standaloneRuleId]);
    assert.equal(suspended.rows[0].suspended_by_promotion_id, festivalAId, 'A5: standalone rule suspended, not deleted');

    // Server guarantee: price shows ONLY the festival discount (no stacking).
    price = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${variantId}` });
    assert.equal(price.json().finalPrice, '800000', 'festival price only — no stacking with standalone');
    assert.equal(price.json().source, 'festival');

    // A5: creating a NEW standalone discount while in an active festival is blocked.
    const blockedStandalone = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers: adminHeaders, payload: {
      targetType: 'product', productId, discountType: 'percent', discountValue: 15, name: 'تخفیف ممنوع' } });
    assert.equal(blockedStandalone.statusCode, 409, 'standalone discount is blocked during an active festival');

    // A6: second festival needs explicit move confirmation; then A's rule is deactivated.
    const festivalB = await app.inject({ method: 'POST', url: '/api/v1/promotions', headers: adminHeaders, payload: {
      name: `جشنواره نوروز ${suffix}`, kind: 'festival', exclusivePolicy: 'festival_exclusive', channel: 'all' } });
    const festivalBId = festivalB.json().id as string;
    const noConfirm = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers: adminHeaders, payload: {
      promotionId: festivalBId, targetType: 'product', productId, discountType: 'percent', discountValue: 30, name: 'قانون نوروز' } });
    assert.equal(noConfirm.statusCode, 409, 'A6: max one active festival per product without explicit transfer');

    const moved = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers: adminHeaders, payload: {
      promotionId: festivalBId, targetType: 'product', productId, discountType: 'percent', discountValue: 30, name: 'قانون نوروز',
      moveFromFestival: true } });
    assert.equal(moved.statusCode, 201, moved.body);
    price = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${variantId}` });
    assert.equal(price.json().finalPrice, '700000', 'product moved to festival B transactionally');

    // Product summary for the admin product-row UI.
    const summary = await app.inject({ method: 'GET', url: `/api/v1/promotions/product-summary?productId=${productId}`, headers: adminHeaders });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal((summary.json().activeFestival as { promotionId: string }).promotionId, festivalBId);
    assert.ok((summary.json().suspendedStandaloneRules as number) >= 1);

    // A6: leaving the festival restores still-valid standalone rules automatically.
    const deactivate = await app.inject({ method: 'PATCH', url: `/api/v1/promotions/${festivalBId}`, headers: adminHeaders, payload: { active: false } });
    assert.equal(deactivate.statusCode, 200, deactivate.body);
    // Festival A is also inactive for this product (its rule was deactivated on move)…
    price = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${variantId}` });
    // …but the ORIGINAL standalone rule was suspended by festival A which is still active.
    // Deactivate festival A too, then the standalone discount must come back.
    await app.inject({ method: 'PATCH', url: `/api/v1/promotions/${festivalAId}`, headers: adminHeaders, payload: { active: false } });
    price = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${variantId}` });
    assert.equal(price.json().finalPrice, '900000', 'A6: still-valid standalone rule restored after festival exit');

    // P: delete guard — product has promotion history → hard delete refused.
    const blockedDelete = await app.inject({ method: 'DELETE', url: `/api/v1/products/${productId}`, headers: adminHeaders });
    assert.equal(blockedDelete.statusCode, 409, 'P: product with history cannot be hard-deleted');

    // A clean product can be hard-deleted.
    const clean = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders, payload: {
      brand: 'Kolbe', name: `محصول تمیز ${suffix}`, category: 'پیراهن', cashPriceRial: '500000', variants: [{ size: 'S', color: 'red' }] } });
    const cleanDelete = await app.inject({ method: 'DELETE', url: `/api/v1/products/${clean.json().id}`, headers: adminHeaders });
    assert.equal(cleanDelete.statusCode, 200, cleanDelete.body);
  } finally {
    await app.close();
    await pool.end();
  }
});
