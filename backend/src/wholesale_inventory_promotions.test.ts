import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { createPool } from './db.js';
import { applyVerifiedPayment } from './payments.js';

const testDbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test(
  'Requirements 1-10: Wholesale Inbound-to-Kolbe, Supplier Privacy, Inventory Domains & Ownership Transfers, and Multi-Level Promotions',
  { skip: !testDbUrl },
  async (t) => {
    const config: Config = {
      NODE_ENV: 'test',
      PORT: 4002,
      DATABASE_URL: testDbUrl!,
      REDIS_URL: undefined,
      JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters',
      PG_POOL_MAX: 2,
      PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      PAYMENT_WEBHOOK_SECRET: undefined,
      COOKIE_SECURE: 'false',
    };

    const app = await buildApp(config);
    const pool = createPool(config);

    try {
      const suffix = randomUUID().slice(0, 8);

      // 1. Setup actors: Admin, Supplier 1, Supplier 2, VIP Buyer, Regular Retail Customer
      const adminId = randomUUID();
      const supplier1Id = randomUUID();
      const supplier2Id = randomUUID();
      const vipBuyerId = randomUUID();
      const retailBuyerId = randomUUID();
      const passwordHash = await argon2.hash('StrongPass123456!');

      await pool.query(
        `INSERT INTO users(id, email, phone, password_hash, display_name) VALUES
         ($1, $2, $3, $4, 'مدیر کلبه'),
         ($5, $6, $7, $4, 'تأمین‌کننده اول'),
         ($8, $9, $10, $4, 'تأمین‌کننده دوم'),
         ($11, $12, $13, $4, 'خریدار عمده VIP'),
         ($14, $15, $16, $4, 'خریدار خرده‌فروشی')`,
        [
          adminId, `admin-${suffix}@kolbe.test`, `09121${Math.floor(100000 + Math.random() * 899999)}`, passwordHash,
          supplier1Id, `sup1-${suffix}@private-supplier.test`, `09122${Math.floor(100000 + Math.random() * 899999)}`,
          supplier2Id, `sup2-${suffix}@private-supplier.test`, `09123${Math.floor(100000 + Math.random() * 899999)}`,
          vipBuyerId, `vip-${suffix}@buyer.test`, `09124${Math.floor(100000 + Math.random() * 899999)}`,
          retailBuyerId, `retail-${suffix}@buyer.test`, `09125${Math.floor(100000 + Math.random() * 899999)}`,
        ],
      );

      await pool.query(
        `INSERT INTO user_roles(user_id, role_code) VALUES
         ($1, 'admin'),
         ($2, 'supplier'),
         ($3, 'supplier'),
         ($4, 'customer'),
         ($5, 'customer')`,
        [adminId, supplier1Id, supplier2Id, vipBuyerId, retailBuyerId],
      );

      // Create approved supplier profiles with sensitive private data (Requirement 2 test fixture)
      await pool.query(
        `INSERT INTO supplier_profiles(user_id, brand_name, legal_name, national_id, economic_code, business_phone, bank_iban, cooperation_status)
         VALUES
         ($1, 'آتلیه آریا', 'شرکت آریا بافت ثبت‌شده', '10109988771', '411998877665', '02188990011', 'IR120120000000009988776655', 'approved'),
         ($2, 'کارگاه سرو', 'شرکت سرو جامه پارس', '10105544332', '411554433221', '02177665544', 'IR990190000000001122334455', 'approved')`,
        [supplier1Id, supplier2Id],
      );

      const loginAs = async (email: string) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { identity: email, password: 'StrongPass123456!' },
        });
        assert.equal(res.statusCode, 200, res.body);
        return { authorization: `Bearer ${res.json().accessToken as string}` };
      };

      const adminHeaders = await loginAs(`admin-${suffix}@kolbe.test`);
      const sup1Headers = await loginAs(`sup1-${suffix}@private-supplier.test`);
      const sup2Headers = await loginAs(`sup2-${suffix}@private-supplier.test`);
      const vipHeaders = await loginAs(`vip-${suffix}@buyer.test`);
      const retailHeaders = await loginAs(`retail-${suffix}@buyer.test`);

      // Activate VIP membership for vipBuyerId
      const planRes = await app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        headers: adminHeaders,
        payload: {
          code: `vip-all-${suffix}`,
          title: 'پلن الماس عمده',
          annualPriceRial: '100000000',
          limits: {
            sources: 'all',
            maxOrdersPerMonth: 50,
            maxOrderValueRial: '50000000000',
            maxSuppliersPerOrder: 10,
            discountPercent: 0,
            prioritySupport: true,
          },
        },
      });
      assert.equal(planRes.statusCode, 201, planRes.body);

      const membershipRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memberships',
        headers: { ...vipHeaders, 'idempotency-key': `vip-mem-${suffix}` },
        payload: { planId: planRes.json().id },
      });
      assert.equal(membershipRes.statusCode, 201, membershipRes.body);
      await applyVerifiedPayment(pool, {
        provider: 'verified-test-adapter',
        providerEventId: `mem-evt-${suffix}`,
        providerReference: `mem-ref-${suffix}`,
        intentId: membershipRes.json().paymentIntentId,
        amountRial: '100000000',
        paidAt: new Date(),
      });

      // Create Warehouses: Kolbe Central Warehouse, Supplier 1 Warehouse, Supplier 2 Warehouse
      const kolbeWhRes = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouses',
        headers: adminHeaders,
        payload: { code: `KOLBE-${suffix.toUpperCase()}`, name: 'انبار مرکزی کلبه' },
      });
      assert.equal(kolbeWhRes.statusCode, 201, kolbeWhRes.body);
      const kolbeWhId = kolbeWhRes.json().id as string;

      const sup1WhRes = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouses',
        headers: sup1Headers,
        payload: { code: `SUP1-${suffix.toUpperCase()}`, name: 'انبار اختصاصی تأمین‌کننده اول' },
      });
      assert.equal(sup1WhRes.statusCode, 201, sup1WhRes.body);
      const sup1WhId = sup1WhRes.json().id as string;

      const sup2WhRes = await app.inject({
        method: 'POST',
        url: '/api/v1/warehouses',
        headers: sup2Headers,
        payload: { code: `SUP2-${suffix.toUpperCase()}`, name: 'انبار اختصاصی تأمین‌کننده دوم' },
      });
      assert.equal(sup2WhRes.statusCode, 201, sup2WhRes.body);
      const sup2WhId = sup2WhRes.json().id as string;

      // Create Products:
      // 1) Kolbe-owned Product with multiple colors & sizes
      const kolbeProductRes = await app.inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: adminHeaders,
        payload: {
          brand: 'Kolbe Archive',
          name: 'پالتو پشمی کلبه',
          category: 'کت',
          cashPriceRial: '10000000',
          installmentPriceRial: '11000000',
          wholesalePriceRial: '7000000',
          variants: [
            { size: 'M', color: 'black' },
            { size: 'L', color: 'black' },
            { size: 'XL', color: 'black' },
            { size: 'M', color: 'olive' },
            { size: 'XL', color: 'olive' },
            { size: 'XL', color: 'cream' },
          ],
        },
      });
      assert.equal(kolbeProductRes.statusCode, 201, kolbeProductRes.body);
      const kolbeProductId = kolbeProductRes.json().id as string;
      const kolbeVariants = kolbeProductRes.json().variants as Array<{ id: string; sku: string; size: string; color: string }>;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/products/${kolbeProductId}/status`,
        headers: adminHeaders,
        payload: { status: 'published' },
      });

      // 2) Supplier 1 Product (owner_type = 'supplier')
      const sup1ProductRes = await app.inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: sup1Headers,
        payload: {
          brand: 'برند داخلی آریا',
          name: 'کت جین دست‌دوز آریا',
          category: 'کت',
          cashPriceRial: '9000000',
          wholesalePriceRial: '6000000',
          saleTerms: { moq: 2, leadTimeDays: 4 },
          variants: [
            { size: 'M', color: 'black' },
            { size: 'L', color: 'black' },
          ],
        },
      });
      assert.equal(sup1ProductRes.statusCode, 201, sup1ProductRes.body);
      const sup1ProductId = sup1ProductRes.json().id as string;
      assert.equal(sup1ProductRes.json().ownerType, 'supplier');
      const sup1Variants = sup1ProductRes.json().variants as Array<{ id: string; sku: string; size: string; color: string }>;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/products/${sup1ProductId}/status`,
        headers: adminHeaders,
        payload: { status: 'published' },
      });

      // 3) Supplier 2 Product (owner_type = 'supplier')
      const sup2ProductRes = await app.inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: sup2Headers,
        payload: {
          brand: 'برند سرو',
          name: 'شلوار کتان سرو',
          category: 'شلوار',
          cashPriceRial: '5000000',
          wholesalePriceRial: '3500000',
          variants: [{ size: 'L', color: 'cream' }],
        },
      });
      assert.equal(sup2ProductRes.statusCode, 201, sup2ProductRes.body);
      const sup2ProductId = sup2ProductRes.json().id as string;
      const sup2VariantId = sup2ProductRes.json().variants[0].id as string;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/products/${sup2ProductId}/status`,
        headers: adminHeaders,
        payload: { status: 'published' },
      });

      // ======================================================================
      // SECTION C: Inventory Domain Separation & Ownership-Aware Stock Transfer
      // (Scenarios 10, 11, 12, 13, 14, 15)
      // ======================================================================
      await t.test('Scenarios 10-12: Wholesale & Retail inventory domains are strictly isolated per Variant', async () => {
        const blackMVariantId = kolbeVariants.find((v) => v.color === 'black' && v.size === 'M')!.id;

        // Add 120 units to Wholesale domain and 8 units to Retail domain on the SAME variant
        const adjWholesale = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/adjustments',
          headers: { ...adminHeaders, 'idempotency-key': `adj-wh-${suffix}` },
          payload: {
            variantId: blackMVariantId,
            warehouseId: kolbeWhId,
            inventoryDomain: 'wholesale',
            delta: 120,
            reason: 'شارژ اولیه موجودی عمده کلبه',
            reference: `OPEN-WH-${suffix}`,
          },
        });
        assert.equal(adjWholesale.statusCode, 201, adjWholesale.body);
        assert.equal(adjWholesale.json().inventoryDomain, 'wholesale');

        const adjRetail = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/adjustments',
          headers: { ...adminHeaders, 'idempotency-key': `adj-rt-${suffix}` },
          payload: {
            variantId: blackMVariantId,
            warehouseId: kolbeWhId,
            inventoryDomain: 'retail',
            delta: 8,
            reason: 'شارژ اولیه موجودی خرده کلبه',
            reference: `OPEN-RT-${suffix}`,
          },
        });
        assert.equal(adjRetail.statusCode, 201, adjRetail.body);
        assert.equal(adjRetail.json().inventoryDomain, 'retail');

        // Scenario 10: Verify independent balances on the same variant
        const invBefore = await app.inject({
          method: 'GET',
          url: `/api/v1/inventory/variants/${blackMVariantId}`,
          headers: adminHeaders,
        });
        assert.equal(invBefore.statusCode, 200, invBefore.body);
        assert.deepEqual(invBefore.json().wholesale, { on_hand: 120, reserved: 0, incoming: 0, damaged: 0, available: 120 });
        assert.deepEqual(invBefore.json().retail, { on_hand: 8, reserved: 0, incoming: 0, damaged: 0, available: 8 });

        // Scenario 11: Retail order reserves ONLY from 'retail' domain and cannot touch 'wholesale'
        // First, try ordering 10 retail units (more than retail available=8, even though wholesale has 120) -> MUST FAIL 409!
        const retailOversell = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...retailHeaders, 'idempotency-key': `rt-oversell-${suffix}` },
          payload: {
            orderType: 'retail',
            paymentMode: 'cash',
            items: [{ variantId: blackMVariantId, quantity: 10 }],
          },
        });
        assert.equal(retailOversell.statusCode, 409, retailOversell.body);

        // Now place a valid Retail order of 2 units
        const retailOrder = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...retailHeaders, 'idempotency-key': `rt-order-${suffix}` },
          payload: {
            orderType: 'retail',
            paymentMode: 'cash',
            items: [{ variantId: blackMVariantId, quantity: 2 }],
          },
        });
        assert.equal(retailOrder.statusCode, 201, retailOrder.body);
        assert.equal(retailOrder.json().inventoryDomain, 'retail');

        // Scenario 12: Wholesale order of 20 units reserves ONLY from 'wholesale' domain and does NOT affect 'retail'
        const wholesaleOrder = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...vipHeaders, 'idempotency-key': `wh-order-kolbe-${suffix}` },
          payload: {
            orderType: 'wholesale',
            paymentMode: 'cash',
            items: [{ variantId: blackMVariantId, quantity: 20 }],
          },
        });
        assert.equal(wholesaleOrder.statusCode, 201, wholesaleOrder.body);
        assert.equal(wholesaleOrder.json().inventoryDomain, 'wholesale');

        // Verify exact match with prompt example:
        // Wholesale: on_hand = 120, reserved = 20, available = 100
        // Retail: on_hand = 8, reserved = 2, available = 6
        const invAfter = await app.inject({
          method: 'GET',
          url: `/api/v1/inventory/variants/${blackMVariantId}`,
          headers: adminHeaders,
        });
        assert.equal(invAfter.statusCode, 200, invAfter.body);
        assert.deepEqual(invAfter.json().wholesale, { on_hand: 120, reserved: 20, incoming: 0, damaged: 0, available: 100 });
        assert.deepEqual(invAfter.json().retail, { on_hand: 8, reserved: 2, incoming: 0, damaged: 0, available: 6 });
      });

      await t.test('Scenario 13: Official Wholesale -> Retail Stock Transfer for Kolbe-owned item records movements on both domains', async () => {
        const blackMVariantId = kolbeVariants.find((v) => v.color === 'black' && v.size === 'M')!.id;

        // Direct transfer attempt via /api/v1/inventory/adjustments must be rejected
        const illegalDirectAdjust = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/adjustments',
          headers: { ...adminHeaders, 'idempotency-key': `illegal-adj-${suffix}` },
          payload: {
            variantId: blackMVariantId,
            warehouseId: kolbeWhId,
            sourceDomain: 'wholesale',
            destinationDomain: 'retail',
            delta: 10,
            reason: 'تلاش برای انتقال مستقیم بدون حواله',
            reference: 'ILLEGAL',
          },
        });
        assert.equal(illegalDirectAdjust.statusCode, 400);

        // Step 1: Create official Stock Transfer (draft -> reserves 15 units in wholesale)
        const createTransfer = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/transfers',
          headers: { ...adminHeaders, 'idempotency-key': `tr-create-${suffix}` },
          payload: {
            variantId: blackMVariantId,
            sourceDomain: 'wholesale',
            destinationDomain: 'retail',
            sourceWarehouseId: kolbeWhId,
            destinationWarehouseId: kolbeWhId,
            quantity: 15,
            reason: 'شارژ موجودی تک‌فروشی از موجودی عمده کلبه',
          },
        });
        assert.equal(createTransfer.statusCode, 201, createTransfer.body);
        const transferId = createTransfer.json().id as string;
        assert.equal(createTransfer.json().status, 'draft');

        // Step 2: Approve / Dispatch transfer (in_transit -> deducts wholesale on_hand+reserved, adds retail incoming)
        const approveTransfer = await app.inject({
          method: 'POST',
          url: `/api/v1/inventory/transfers/${transferId}/approve`,
          headers: { ...adminHeaders, 'idempotency-key': `tr-approve-${suffix}` },
        });
        assert.equal(approveTransfer.statusCode, 200, approveTransfer.body);
        assert.equal(approveTransfer.json().status, 'in_transit');

        // Step 3: Complete transfer in destination (completed -> deducts retail incoming, adds retail on_hand)
        const completeTransfer = await app.inject({
          method: 'POST',
          url: `/api/v1/inventory/transfers/${transferId}/complete`,
          headers: { ...adminHeaders, 'idempotency-key': `tr-complete-${suffix}` },
        });
        assert.equal(completeTransfer.statusCode, 200, completeTransfer.body);
        assert.equal(completeTransfer.json().status, 'completed');

        // Verify updated balances: wholesale on_hand: 120 -> 105 (available: 85), retail on_hand: 8 -> 23 (available: 21)
        const invAfterTransfer = await app.inject({
          method: 'GET',
          url: `/api/v1/inventory/variants/${blackMVariantId}`,
          headers: adminHeaders,
        });
        assert.deepEqual(invAfterTransfer.json().wholesale, { on_hand: 105, reserved: 20, incoming: 0, damaged: 0, available: 85 });
        assert.deepEqual(invAfterTransfer.json().retail, { on_hand: 23, reserved: 2, incoming: 0, damaged: 0, available: 21 });

        // Verify append-only stock movements recorded for both wholesale and retail domains
        const transferDetails = await app.inject({
          method: 'GET',
          url: `/api/v1/inventory/transfers/${transferId}`,
          headers: adminHeaders,
        });
        assert.equal(transferDetails.statusCode, 200);
        const movements = transferDetails.json().movements as Array<{ inventory_domain: string; on_hand_delta: number }>;
        assert.equal(movements.length, 4);
        assert.ok(movements.some((m) => m.inventory_domain === 'wholesale' && m.on_hand_delta === -15));
        assert.ok(movements.some((m) => m.inventory_domain === 'retail' && m.on_hand_delta === 15));
      });

      await t.test('Scenarios 14 & 15: Supplier-owned stock cannot be transferred to Retail without Ownership Conversion, and succeeds after completion', async () => {
        const sup1VariantM = sup1Variants.find((v) => v.size === 'M')!.id;

        // Supplier 1 stocks 50 units in their wholesale inventory
        const supStock = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/adjustments',
          headers: { ...sup1Headers, 'idempotency-key': `sup1-stock-${suffix}` },
          payload: {
            variantId: sup1VariantM,
            warehouseId: sup1WhId,
            inventoryDomain: 'wholesale',
            delta: 50,
            reason: 'موجودی عمده تأمین‌کننده اول',
            reference: `SUP1-OPEN-${suffix}`,
          },
        });
        assert.equal(supStock.statusCode, 201, supStock.body);

        // Scenario 14a: Supplier or Admin trying to directly adjust 'retail' stock for supplier-owned product is forbidden
        const forbiddenRetailAdjust = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/adjustments',
          headers: { ...adminHeaders, 'idempotency-key': `sup1-illegal-rt-${suffix}` },
          payload: {
            variantId: sup1VariantM,
            warehouseId: kolbeWhId,
            inventoryDomain: 'retail',
            delta: 10,
            reason: 'تلاش ادمین برای افزودن مستقیم کالای تأمین‌کننده به خرده',
            reference: `ILLEGAL-RT-${suffix}`,
          },
        });
        assert.equal(forbiddenRetailAdjust.statusCode, 403, forbiddenRetailAdjust.body);

        // Scenario 14b: Admin trying to create a Stock Transfer from wholesale -> retail for supplier-owned product without Ownership Conversion is rejected (403)
        const forbiddenTransfer = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/transfers',
          headers: { ...adminHeaders, 'idempotency-key': `sup1-tr-blocked-${suffix}` },
          payload: {
            variantId: sup1VariantM,
            sourceDomain: 'wholesale',
            destinationDomain: 'retail',
            sourceWarehouseId: sup1WhId,
            destinationWarehouseId: kolbeWhId,
            quantity: 10,
            reason: 'تلاش برای انتقال بدون خرید یا انتقال مالکیت',
          },
        });
        assert.equal(forbiddenTransfer.statusCode, 403, forbiddenTransfer.body);

        // Scenario 15: Create & Complete Official Ownership Conversion (Purchase / Acquisition by Kolbe), then transfer succeeds
        const createConversion = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/ownership-conversions',
          headers: { ...adminHeaders, 'idempotency-key': `oc-create-${suffix}` },
          payload: {
            productId: sup1ProductId,
            variantId: sup1VariantM,
            conversionType: 'purchase_acquisition',
            quantity: 10,
            unitCostRial: '5500000',
            note: 'خرید قطعی ۱۰ عدد توسط کلبه طبق قرارداد تملک',
          },
        });
        assert.equal(createConversion.statusCode, 201, createConversion.body);
        const conversionId = createConversion.json().id as string;

        const completeConversion = await app.inject({
          method: 'POST',
          url: `/api/v1/inventory/ownership-conversions/${conversionId}/complete`,
          headers: { ...adminHeaders, 'idempotency-key': `oc-complete-${suffix}` },
        });
        assert.equal(completeConversion.statusCode, 200, completeConversion.body);
        assert.equal(completeConversion.json().status, 'completed');

        // Now Stock Transfer of 10 units to retail succeeds!
        const allowedTransfer = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/transfers',
          headers: { ...adminHeaders, 'idempotency-key': `sup1-tr-allowed-${suffix}` },
          payload: {
            variantId: sup1VariantM,
            sourceDomain: 'wholesale',
            destinationDomain: 'retail',
            sourceWarehouseId: sup1WhId,
            destinationWarehouseId: kolbeWhId,
            quantity: 10,
            reason: 'انتقال پس از تکمیل قرارداد خرید کلبه',
            ownershipConversionId: conversionId,
          },
        });
        assert.equal(allowedTransfer.statusCode, 201, allowedTransfer.body);
        const supTransferId = allowedTransfer.json().id as string;

        await app.inject({
          method: 'POST',
          url: `/api/v1/inventory/transfers/${supTransferId}/approve`,
          headers: { ...adminHeaders, 'idempotency-key': `sup1-tr-app-${suffix}` },
        });
        const completedSupTransfer = await app.inject({
          method: 'POST',
          url: `/api/v1/inventory/transfers/${supTransferId}/complete`,
          headers: { ...adminHeaders, 'idempotency-key': `sup1-tr-cmp-${suffix}` },
        });
        assert.equal(completedSupTransfer.statusCode, 200);
      });

      // ======================================================================
      // SECTION A & B: Wholesale Inbound-to-Kolbe Workflow & Supplier Privacy
      // (Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 9)
      // ======================================================================
      await t.test('Scenarios 7, 8, 9: Supplier Privacy — VIP Buyer cannot see private supplier identity/contact/bank/tax info or access Supplier endpoints (IDOR)', async () => {
        // Stock Supplier 2 wholesale inventory as well
        const sup2Stock = await app.inject({
          method: 'POST',
          url: '/api/v1/inventory/adjustments',
          headers: { ...sup2Headers, 'idempotency-key': `sup2-stock-${suffix}` },
          payload: {
            variantId: sup2VariantId,
            warehouseId: sup2WhId,
            inventoryDomain: 'wholesale',
            delta: 40,
            reason: 'موجودی عمده تأمین‌کننده دوم',
            reference: `SUP2-OPEN-${suffix}`,
          },
        });
        assert.equal(sup2Stock.statusCode, 201, sup2Stock.body);

        // Scenario 7: Wholesale catalog response for VIP buyer contains ZERO private supplier fields
        const catalogRes = await app.inject({
          method: 'GET',
          url: '/api/v1/wholesale/products',
          headers: vipHeaders,
        });
        assert.equal(catalogRes.statusCode, 200, catalogRes.body);
        const catalogRawText = catalogRes.body;
        const catalogItems = catalogRes.json().items as Array<Record<string, unknown>>;
        assert.ok(catalogItems.length >= 2);

        // Ensure public commercial display fields ARE present
        const sup1Item = catalogItems.find((i) => i.id === sup1ProductId);
        assert.ok(sup1Item);
        assert.equal(sup1Item.brandDisplayName, 'آتلیه آریا');
        assert.equal((sup1Item.saleTerms as Record<string, unknown>).fulfillmentChannel, 'kolbe_warehouse');

        // Ensure NO sensitive supplier data appears anywhere in the serialized payload
        const forbiddenSubstrings = [
          supplier1Id,
          supplier2Id,
          'supplier_id',
          'supplierId',
          'شرکت آریا بافت ثبت‌شده',
          'شرکت سرو جامه پارس',
          '10109988771',
          '411998877665',
          '02188990011',
          'IR120120000000009988776655',
          'IR990190000000001122334455',
          'private-supplier.test',
          'legal_name',
          'national_id',
          'economic_code',
          'business_phone',
          'bank_iban',
        ];
        for (const secret of forbiddenSubstrings) {
          assert.equal(
            catalogRawText.includes(secret),
            false,
            `Wholesale catalog leaked sensitive supplier field/value: ${secret}`,
          );
        }

        // Scenario 9: IDOR & RBAC checks — VIP buyer cannot access supplier profiles, supplier list, or inventory endpoints
        const idorSupplierProfile = await app.inject({
          method: 'GET',
          url: `/api/v1/suppliers/${supplier1Id}`,
          headers: vipHeaders,
        });
        assert.equal(idorSupplierProfile.statusCode, 403);

        const idorSupplierList = await app.inject({
          method: 'GET',
          url: '/api/v1/suppliers',
          headers: vipHeaders,
        });
        assert.equal(idorSupplierList.statusCode, 403);

        const idorInventory = await app.inject({
          method: 'GET',
          url: `/api/v1/inventory?warehouseId=${sup1WhId}`,
          headers: vipHeaders,
        });
        assert.equal(idorInventory.statusCode, 403);

        const idorFulfillments = await app.inject({
          method: 'GET',
          url: '/api/v1/wholesale/fulfillments',
          headers: vipHeaders,
        });
        assert.equal(idorFulfillments.statusCode, 403);
      });

      await t.test('Scenarios 1, 2, 3, 4, 5, 6, 8: Multi-Supplier Wholesale Order Inbound-to-Kolbe, QC Inspection, Consolidation & VIP Dispatch', async () => {
        const sup1VariantM = sup1Variants.find((v) => v.size === 'M')!.id;

        // Place a Multi-Supplier Wholesale Order (Supplier 1 + Supplier 2)
        const createOrderRes = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...vipHeaders, 'idempotency-key': `wh-multi-${suffix}` },
          payload: {
            orderType: 'wholesale',
            paymentMode: 'cash',
            items: [
              { variantId: sup1VariantM, quantity: 10 },
              { variantId: sup2VariantId, quantity: 6 },
            ],
          },
        });
        assert.equal(createOrderRes.statusCode, 201, createOrderRes.body);
        const orderId = createOrderRes.json().id as string;
        assert.equal(createOrderRes.json().wholesaleFulfillmentStatus, 'awaiting_supplier');

        // Scenario 8: Check VIP Order Detail Read Model — zero supplier private info leaked!
        const vipOrderDetail = await app.inject({
          method: 'GET',
          url: `/api/v1/orders/${orderId}`,
          headers: vipHeaders,
        });
        assert.equal(vipOrderDetail.statusCode, 200, vipOrderDetail.body);
        assert.equal(vipOrderDetail.json().fulfillment_via, 'kolbe_warehouse');
        assert.equal(vipOrderDetail.body.includes(supplier1Id), false);
        assert.equal(vipOrderDetail.body.includes(supplier2Id), false);
        assert.equal(vipOrderDetail.body.includes('supplier_id'), false);
        assert.equal(vipOrderDetail.body.includes('IR120120000000009988776655'), false);

        // Mark order as paid -> processing
        await app.inject({
          method: 'POST',
          url: `/api/v1/orders/${orderId}/transitions`,
          headers: adminHeaders,
          payload: { status: 'paid', note: 'پرداخت عمده تایید شد' },
        });
        await app.inject({
          method: 'POST',
          url: `/api/v1/orders/${orderId}/transitions`,
          headers: adminHeaders,
          payload: { status: 'processing', note: 'در حال پردازش در سیستم کلبه' },
        });

        // Scenario 1: Attempting to transition wholesale order to ready_to_ship / in_transit / shipped BEFORE Kolbe warehouse receipt & QC MUST FAIL!
        for (const prematureStatus of ['ready_to_ship', 'in_transit', 'shipped'] as const) {
          const blockedShip = await app.inject({
            method: 'POST',
            url: `/api/v1/orders/${orderId}/transitions`,
            headers: adminHeaders,
            payload: { status: prematureStatus, note: 'تلاش برای ارسال قبل از ورود به انبار کلبه' },
          });
          assert.equal(blockedShip.statusCode, 409, `Expected 409 for premature ${prematureStatus}, got ${blockedShip.body}`);
        }

        // Fetch supplier fulfillments for Supplier 1 and Supplier 2
        const sup1Fulfillments = await app.inject({
          method: 'GET',
          url: '/api/v1/wholesale/fulfillments',
          headers: sup1Headers,
        });
        assert.equal(sup1Fulfillments.statusCode, 200);
        const f1 = (sup1Fulfillments.json().items as Array<{ id: string; order_id: string }> ).find((f) => f.order_id === orderId)!;
        assert.ok(f1);

        const sup2Fulfillments = await app.inject({
          method: 'GET',
          url: '/api/v1/wholesale/fulfillments',
          headers: sup2Headers,
        });
        const f2 = (sup2Fulfillments.json().items as Array<{ id: string; order_id: string }> ).find((f) => f.order_id === orderId)!;
        assert.ok(f2);

        // Supplier 1 marks preparing
        const prep1 = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/fulfillments/${f1.id}/prepare`,
          headers: sup1Headers,
          payload: { note: 'در حال بسته‌بندی برای ارسال به انبار مرکزی کلبه' },
        });
        assert.equal(prep1.statusCode, 200);
        assert.equal(prep1.json().status, 'supplier_preparing');

        // Scenario 2: Supplier cannot create a shipment directly to VIP / customer address or non-Kolbe warehouse
        const directToVipAttempt = await app.inject({
          method: 'POST',
          url: '/api/v1/wholesale/inbound-shipments',
          headers: { ...sup1Headers, 'idempotency-key': `direct-vip-${suffix}` },
          payload: {
            fulfillmentId: f1.id,
            destinationType: 'vip',
            customerAddress: 'تهران، زعفرانیه، پلاک ۱',
            trackingCode: 'ILLEGAL-VIP-123',
          },
        });
        assert.equal(directToVipAttempt.statusCode, 403, directToVipAttempt.body);

        const nonKolbeWhAttempt = await app.inject({
          method: 'POST',
          url: '/api/v1/wholesale/inbound-shipments',
          headers: { ...sup1Headers, 'idempotency-key': `non-kolbe-wh-${suffix}` },
          payload: {
            fulfillmentId: f1.id,
            destinationWarehouseId: sup1WhId, // Supplier's own warehouse instead of Kolbe Central
            trackingCode: 'ILLEGAL-WH-123',
          },
        });
        assert.equal(nonKolbeWhAttempt.statusCode, 403, nonKolbeWhAttempt.body);

        // Scenario 3: Supplier 1 dispatches Inbound Shipment exclusively to Kolbe Central Warehouse
        const ship1Res = await app.inject({
          method: 'POST',
          url: '/api/v1/wholesale/inbound-shipments',
          headers: { ...sup1Headers, 'idempotency-key': `inb-s1-${suffix}` },
          payload: {
            fulfillmentId: f1.id,
            destinationWarehouseId: kolbeWhId,
            carrier: 'باربری ویژه کلبه',
            trackingCode: `TRK-S1-${suffix}`,
          },
        });
        assert.equal(ship1Res.statusCode, 201, ship1Res.body);
        assert.equal(ship1Res.json().destinationType, 'kolbe_warehouse');
        assert.equal(ship1Res.json().status, 'supplier_dispatched');
        const shipment1Id = ship1Res.json().id as string;
        const shipment1LineId = ship1Res.json().lines[0].id as string;

        // Kolbe Warehouse marks shipment 1 arrived_at_kolbe -> under_inspection
        const recv1 = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/inbound-shipments/${shipment1Id}/receive`,
          headers: adminHeaders,
          payload: { stage: 'under_inspection' },
        });
        assert.equal(recv1.statusCode, 200);
        assert.equal(recv1.json().status, 'under_inspection');

        // Scenario 4: Kolbe QC inspects Shipment 1 (all 10 accepted)
        const qc1Res = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/inbound-shipments/${shipment1Id}/inspect`,
          headers: { ...adminHeaders, 'idempotency-key': `qc-s1-${suffix}` },
          payload: {
            inspectorNote: 'هر ۱۰ عدد کت جین آریا سالم و مطابق استاندارد کلبه تایید شد',
            lines: [
              {
                shipmentLineId: shipment1LineId,
                receivedQuantity: 10,
                acceptedQuantity: 10,
                rejectedQuantity: 0,
                damagedQuantity: 0,
                missingQuantity: 0,
                inspectionNote: 'دوخت و بسته‌بندی عالی',
              },
            ],
          },
        });
        assert.equal(qc1Res.statusCode, 201, qc1Res.body);
        assert.equal(qc1Res.json().status, 'accepted');
        assert.ok((qc1Res.json().receiptNumber as string).startsWith('GRN-'));

        // Scenario 5: Multi-supplier order STILL cannot be consolidated or dispatched to VIP because Supplier 2 hasn't been received/accepted yet!
        const prematureConsolidate = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/orders/${orderId}/consolidate`,
          headers: { ...adminHeaders, 'idempotency-key': `premature-cons-${suffix}` },
        });
        assert.equal(prematureConsolidate.statusCode, 409, prematureConsolidate.body);

        const prematureVipDispatch = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/orders/${orderId}/dispatch-vip`,
          headers: { ...adminHeaders, 'idempotency-key': `premature-disp-${suffix}` },
        });
        assert.equal(prematureVipDispatch.statusCode, 409, prematureVipDispatch.body);

        // Scenario 6: Test QC with damaged/missing/rejected items on a separate order first to verify QC prevents bad shipment
        const defectiveOrderRes = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...vipHeaders, 'idempotency-key': `wh-defect-${suffix}` },
          payload: {
            orderType: 'wholesale',
            paymentMode: 'cash',
            items: [{ variantId: sup2VariantId, quantity: 5 }],
          },
        });
        assert.equal(defectiveOrderRes.statusCode, 201);
        const defectiveOrderId = defectiveOrderRes.json().id as string;
        const allSup2Fulfillments = await app.inject({
          method: 'GET',
          url: '/api/v1/wholesale/fulfillments',
          headers: sup2Headers,
        });
        const fDefect = (allSup2Fulfillments.json().items as Array<{ id: string; order_id: string }>).find((f) => f.order_id === defectiveOrderId)!;
        const shipDefect = await app.inject({
          method: 'POST',
          url: '/api/v1/wholesale/inbound-shipments',
          headers: { ...sup2Headers, 'idempotency-key': `inb-def-${suffix}` },
          payload: {
            fulfillmentId: fDefect.id,
            destinationWarehouseId: kolbeWhId,
            trackingCode: `TRK-DEF-${suffix}`,
          },
        });
        assert.equal(shipDefect.statusCode, 201);
        // QC finds 3 accepted, 1 damaged, 1 missing (out of 5 expected) -> partially_accepted
        const qcDefect = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/inbound-shipments/${shipDefect.json().id}/inspect`,
          headers: { ...adminHeaders, 'idempotency-key': `qc-def-${suffix}` },
          payload: {
            inspectorNote: '۱ عدد پارگی داشت و ۱ عدد کسری بار',
            lines: [
              {
                shipmentLineId: shipDefect.json().lines[0].id,
                receivedQuantity: 4,
                acceptedQuantity: 3,
                rejectedQuantity: 0,
                damagedQuantity: 1,
                missingQuantity: 1,
                inspectionNote: 'کسری و آسیب‌دیدگی ثبت شد',
              },
            ],
          },
        });
        assert.equal(qcDefect.statusCode, 201, qcDefect.body);
        assert.equal(qcDefect.json().status, 'partially_accepted');
        assert.equal(qcDefect.json().orderWholesaleFulfillmentStatus, 'partially_accepted');

        // Attempting to consolidate or ship this partially_accepted order to VIP MUST BE BLOCKED!
        const blockedDefectConsolidate = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/orders/${defectiveOrderId}/consolidate`,
          headers: { ...adminHeaders, 'idempotency-key': `cons-def-${suffix}` },
        });
        assert.equal(blockedDefectConsolidate.statusCode, 409);

        // Now complete Supplier 2's shipment for the main multi-supplier order (6 units all accepted)
        const ship2Res = await app.inject({
          method: 'POST',
          url: '/api/v1/wholesale/inbound-shipments',
          headers: { ...sup2Headers, 'idempotency-key': `inb-s2-${suffix}` },
          payload: {
            fulfillmentId: f2.id,
            destinationWarehouseId: kolbeWhId,
            trackingCode: `TRK-S2-${suffix}`,
          },
        });
        assert.equal(ship2Res.statusCode, 201);
        const qc2Res = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/inbound-shipments/${ship2Res.json().id}/inspect`,
          headers: { ...adminHeaders, 'idempotency-key': `qc-s2-${suffix}` },
          payload: {
            inspectorNote: 'هر ۶ عدد شلوار کتان سرو تایید کیفی شد',
            lines: [
              {
                shipmentLineId: ship2Res.json().lines[0].id,
                receivedQuantity: 6,
                acceptedQuantity: 6,
                rejectedQuantity: 0,
                damagedQuantity: 0,
                missingQuantity: 0,
              },
            ],
          },
        });
        assert.equal(qc2Res.statusCode, 201);
        assert.equal(qc2Res.json().orderWholesaleFulfillmentStatus, 'awaiting_consolidation');

        // Consolidate multi-supplier order at Kolbe Warehouse -> ready_for_vip
        const consolidateRes = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/orders/${orderId}/consolidate`,
          headers: { ...adminHeaders, 'idempotency-key': `cons-ok-${suffix}` },
        });
        assert.equal(consolidateRes.statusCode, 200, consolidateRes.body);
        assert.equal(consolidateRes.json().wholesaleFulfillmentStatus, 'ready_for_vip');

        // Dispatch consolidated order from Kolbe Warehouse to VIP Buyer -> shipped / vip_dispatched
        const dispatchVipRes = await app.inject({
          method: 'POST',
          url: `/api/v1/wholesale/orders/${orderId}/dispatch-vip`,
          headers: { ...adminHeaders, 'idempotency-key': `disp-vip-${suffix}` },
          payload: {
            trackingCode: `KOLBE-VIP-${suffix}`,
            reason: 'ارسال پک تجمیع‌شده از انبار مرکزی کلبه به مشتری VIP',
          },
        });
        assert.equal(dispatchVipRes.statusCode, 200, dispatchVipRes.body);
        assert.equal(dispatchVipRes.json().status, 'shipped');
        assert.equal(dispatchVipRes.json().wholesaleFulfillmentStatus, 'vip_dispatched');
        assert.equal(dispatchVipRes.json().dispatchedFrom, 'kolbe_warehouse');
      });

      // ======================================================================
      // SECTION D: Promotion Targeting (Variant, Color, Size, Product) & Precedence
      // (Scenarios 16, 17, 18, 19, 20)
      // ======================================================================
      await t.test('Scenarios 16, 17, 18, 19, 20: Multi-Level Promotion Engine (Variant, Color, Size, Product) & Deterministic Precedence across PDP and Checkout', async () => {
        const vBlackM = kolbeVariants.find((v) => v.color === 'black' && v.size === 'M')!;
        const vBlackL = kolbeVariants.find((v) => v.color === 'black' && v.size === 'L')!;
        const vBlackXL = kolbeVariants.find((v) => v.color === 'black' && v.size === 'XL')!;
        const vOliveM = kolbeVariants.find((v) => v.color === 'olive' && v.size === 'M')!;
        const vOliveXL = kolbeVariants.find((v) => v.color === 'olive' && v.size === 'XL')!;
        const vCreamXL = kolbeVariants.find((v) => v.color === 'cream' && v.size === 'XL')!;

        // Stock all variants in retail domain so we can also verify Checkout server-side pricing
        for (const v of kolbeVariants) {
          await app.inject({
            method: 'POST',
            url: '/api/v1/inventory/adjustments',
            headers: { ...adminHeaders, 'idempotency-key': `promo-stock-${v.id}` },
            payload: {
              variantId: v.id,
              warehouseId: kolbeWhId,
              inventoryDomain: 'retail',
              delta: 20,
              reason: 'موجودی تست تخفیف‌ها',
              reference: `PROMO-STK-${suffix}`,
            },
          });
        }

        // --------------------------------------------------------------------
        // Scenario 16: Exact Variant Discount (Black / XL -> 25% off)
        // Base price = 10,000,000 Rial -> Discount = 2,500,000 -> Final = 7,500,000
        // --------------------------------------------------------------------
        const variantRuleRes = await app.inject({
          method: 'POST',
          url: '/api/v1/promotions/rules',
          headers: { ...adminHeaders, 'idempotency-key': `rule-var-${suffix}` },
          payload: {
            name: 'تخفیف ۲۵٪ فقط برای مشکی سایز XL',
            targetType: 'variant',
            variantId: vBlackXL.id,
            discountType: 'percent',
            discountValue: 25,
          },
        });
        assert.equal(variantRuleRes.statusCode, 201, variantRuleRes.body);
        const variantRuleId = variantRuleRes.json().id as string;

        const priceBlackXL = await app.inject({
          method: 'GET',
          url: `/api/v1/pricing/variants/${vBlackXL.id}`,
        });
        assert.equal(priceBlackXL.statusCode, 200);
        assert.equal(priceBlackXL.json().basePrice, '10000000');
        assert.equal(priceBlackXL.json().discountAmount, '2500000');
        assert.equal(priceBlackXL.json().finalPrice, '7500000');
        assert.equal(priceBlackXL.json().matchedRule.targetType, 'variant');

        // Black / M and Olive / XL must remain untouched (0 discount)
        const priceBlackM_1 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vBlackM.id}` });
        assert.equal(priceBlackM_1.json().finalPrice, '10000000');
        assert.equal(priceBlackM_1.json().matchedRule, null);

        const priceOliveXL_1 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vOliveXL.id}` });
        assert.equal(priceOliveXL_1.json().finalPrice, '10000000');
        assert.equal(priceOliveXL_1.json().matchedRule, null);

        // --------------------------------------------------------------------
        // Scenario 17: Color-level Discount (Product = kolbeProductId, Color = 'black' -> 15% off)
        // Must apply to Black/M and Black/L (15%), while Black/XL keeps 25% (higher specificity),
        // and Olive/M stays 0%, and Supplier 1's Black/M product stays 0%!
        // Also adding a new size (2XL) for color 'black' automatically inherits the 15% color discount!
        // --------------------------------------------------------------------
        const colorRuleRes = await app.inject({
          method: 'POST',
          url: '/api/v1/promotions/rules',
          headers: { ...adminHeaders, 'idempotency-key': `rule-col-${suffix}` },
          payload: {
            name: 'تخفیف ۱۵٪ رنگ مشکی پالتو کلبه',
            targetType: 'color',
            productId: kolbeProductId,
            colorId: 'black',
            discountType: 'percent',
            discountValue: 15,
          },
        });
        assert.equal(colorRuleRes.statusCode, 201, colorRuleRes.body);

        const priceBlackM_2 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vBlackM.id}` });
        assert.equal(priceBlackM_2.json().discountAmount, '1500000');
        assert.equal(priceBlackM_2.json().finalPrice, '8500000');
        assert.equal(priceBlackM_2.json().matchedRule.targetType, 'color');

        const priceBlackL_2 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vBlackL.id}` });
        assert.equal(priceBlackL_2.json().finalPrice, '8500000');

        // Olive / M on same product is NOT discounted
        const priceOliveM_2 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vOliveM.id}` });
        assert.equal(priceOliveM_2.json().finalPrice, '10000000');

        // Other product with color 'black' (sup1Variants[0]) is NOT affected
        const priceOtherProductBlack = await app.inject({
          method: 'GET',
          url: `/api/v1/pricing/variants/${sup1Variants[0]!.id}`,
        });
        assert.equal(priceOtherProductBlack.json().discountAmount, '0');
        assert.equal(priceOtherProductBlack.json().finalPrice, '9000000');

        // Add a brand new size '2XL' for color 'black' on kolbeProductId -> automatically inherits 15% Color discount!
        const addVariantRes = await app.inject({
          method: 'POST',
          url: `/api/v1/products/${kolbeProductId}/variants`,
          headers: adminHeaders,
          payload: { variants: [{ size: '2XL', color: 'black' }] },
        });
        assert.equal(addVariantRes.statusCode, 201, addVariantRes.body);
        const newBlack2XLId = addVariantRes.json().variants[0].id as string;
        const priceNewBlack2XL = await app.inject({
          method: 'GET',
          url: `/api/v1/pricing/variants/${newBlack2XLId}`,
        });
        assert.equal(priceNewBlack2XL.json().discountAmount, '1500000');
        assert.equal(priceNewBlack2XL.json().finalPrice, '8500000');
        assert.equal(priceNewBlack2XL.json().matchedRule.targetType, 'color');

        // --------------------------------------------------------------------
        // Scenario 18: Size-level Discount (Product = kolbeProductId, Size = 'XL' -> 12% off)
        // Olive/XL and Cream/XL get 12% off (final = 8,800,000),
        // Olive/M stays 0% off, and Black/XL keeps 25% variant rule!
        // --------------------------------------------------------------------
        const sizeRuleRes = await app.inject({
          method: 'POST',
          url: '/api/v1/promotions/rules',
          headers: { ...adminHeaders, 'idempotency-key': `rule-size-${suffix}` },
          payload: {
            name: 'تخفیف ۱۲٪ سایز XL پالتو کلبه',
            targetType: 'size',
            productId: kolbeProductId,
            sizeCode: 'XL',
            discountType: 'percent',
            discountValue: 12,
          },
        });
        assert.equal(sizeRuleRes.statusCode, 201, sizeRuleRes.body);

        const priceOliveXL_2 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vOliveXL.id}` });
        assert.equal(priceOliveXL_2.json().discountAmount, '1200000');
        assert.equal(priceOliveXL_2.json().finalPrice, '8800000');
        assert.equal(priceOliveXL_2.json().matchedRule.targetType, 'size');

        const priceCreamXL_2 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vCreamXL.id}` });
        assert.equal(priceCreamXL_2.json().finalPrice, '8800000');
        assert.equal(priceCreamXL_2.json().matchedRule.targetType, 'size');

        // Olive/M (different size) still has 0 discount
        const priceOliveM_3 = await app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${vOliveM.id}` });
        assert.equal(priceOliveM_3.json().finalPrice, '10000000');

        // --------------------------------------------------------------------
        // Scenario 19 & 20: Product-level Discount (Product = kolbeProductId -> 10% off)
        // + Deterministic Precedence when Product (10%) + Size (12%) + Color (15%) + Variant (25%) overlap!
        // --------------------------------------------------------------------
        const productRuleRes = await app.inject({
          method: 'POST',
          url: '/api/v1/promotions/rules',
          headers: { ...adminHeaders, 'idempotency-key': `rule-prod-${suffix}` },
          payload: {
            name: 'تخفیف ۱۰٪ کل محصول پالتو کلبه',
            targetType: 'product',
            productId: kolbeProductId,
            discountType: 'percent',
            discountValue: 10,
          },
        });
        assert.equal(productRuleRes.statusCode, 201, productRuleRes.body);

        // Now check all 4 levels simultaneously on the same product:
        // 1. Olive/M -> matches ONLY Product rule (10%) -> 9,000,000
        // 2. Olive/XL -> matches Product (10%) & Size (12%) -> Size wins (specificity 20 > 10) -> 8,800,000
        // 3. Black/M -> matches Product (10%) & Color (15%) -> Color wins (specificity 30 > 10) -> 8,500,000
        // 4. Black/XL -> matches Product (10%), Size (12%), Color (15%), Variant (25%) -> Variant wins (specificity 40) -> 7,500,000
        const resolveBatch = await app.inject({
          method: 'POST',
          url: '/api/v1/pricing/resolve',
          payload: {
            orderType: 'retail',
            paymentMode: 'cash',
            items: [
              { variantId: vOliveM.id, quantity: 1 },
              { variantId: vOliveXL.id, quantity: 1 },
              { variantId: vBlackM.id, quantity: 1 },
              { variantId: vBlackXL.id, quantity: 1 },
            ],
          },
        });
        assert.equal(resolveBatch.statusCode, 200, resolveBatch.body);
        const batchLines = resolveBatch.json().lines as Array<{
          variantId: string;
          finalPrice: string;
          matchedRule: { targetType: string };
        }>;
        assert.equal(batchLines.find((l) => l.variantId === vOliveM.id)!.finalPrice, '9000000');
        assert.equal(batchLines.find((l) => l.variantId === vOliveM.id)!.matchedRule.targetType, 'product');

        assert.equal(batchLines.find((l) => l.variantId === vOliveXL.id)!.finalPrice, '8800000');
        assert.equal(batchLines.find((l) => l.variantId === vOliveXL.id)!.matchedRule.targetType, 'size');

        assert.equal(batchLines.find((l) => l.variantId === vBlackM.id)!.finalPrice, '8500000');
        assert.equal(batchLines.find((l) => l.variantId === vBlackM.id)!.matchedRule.targetType, 'color');

        assert.equal(batchLines.find((l) => l.variantId === vBlackXL.id)!.finalPrice, '7500000');
        assert.equal(batchLines.find((l) => l.variantId === vBlackXL.id)!.matchedRule.targetType, 'variant');

        // Verify PDP / Catalog endpoint (/api/v1/products) returns identical resolved prices
        const catalogProducts = await app.inject({ method: 'GET', url: '/api/v1/products' });
        assert.equal(catalogProducts.statusCode, 200);
        const pdpProduct = (catalogProducts.json().items as Array<{ id: string; variants: Array<{ id: string; finalPriceRial: string }> }>)
          .find((p) => p.id === kolbeProductId)!;
        assert.equal(pdpProduct.variants.find((v) => v.id === vOliveM.id)!.finalPriceRial, '9000000');
        assert.equal(pdpProduct.variants.find((v) => v.id === vOliveXL.id)!.finalPriceRial, '8800000');
        assert.equal(pdpProduct.variants.find((v) => v.id === vBlackM.id)!.finalPriceRial, '8500000');
        assert.equal(pdpProduct.variants.find((v) => v.id === vBlackXL.id)!.finalPriceRial, '7500000');

        // Verify Checkout (POST /api/v1/orders) applies the exact same server-side pricing and rejects client price tampering
        const tamperedOrder = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...retailHeaders, 'idempotency-key': `tamper-ord-${suffix}` },
          payload: {
            orderType: 'retail',
            paymentMode: 'cash',
            totalRial: '1000', // Client attempting to override total price
            items: [{ variantId: vBlackXL.id, quantity: 1 }],
          },
        });
        assert.equal(tamperedOrder.statusCode, 400, tamperedOrder.body);

        const checkoutOrder = await app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          headers: { ...retailHeaders, 'idempotency-key': `promo-ord-${suffix}` },
          payload: {
            orderType: 'retail',
            paymentMode: 'cash',
            items: [
              { variantId: vOliveM.id, quantity: 1 },
              { variantId: vOliveXL.id, quantity: 1 },
              { variantId: vBlackM.id, quantity: 1 },
              { variantId: vBlackXL.id, quantity: 1 },
            ],
          },
        });
        assert.equal(checkoutOrder.statusCode, 201, checkoutOrder.body);
        // Subtotal = 4 * 10,000,000 = 40,000,000
        // Discounts = 1,000,000 + 1,200,000 + 1,500,000 + 2,500,000 = 6,200,000
        // Total = 33,800,000
        assert.equal(checkoutOrder.json().subtotalRial, '40000000');
        assert.equal(checkoutOrder.json().discountRial, '6200000');
        assert.equal(checkoutOrder.json().totalRial, '33800000');

        // Also verify deactivating the Variant rule falls back deterministically to the Color rule (15%) for Black/XL
        const deactivateVarRule = await app.inject({
          method: 'DELETE',
          url: `/api/v1/promotions/rules/${variantRuleId}`,
          headers: adminHeaders,
        });
        assert.equal(deactivateVarRule.statusCode, 204);

        const priceBlackXLFallback = await app.inject({
          method: 'GET',
          url: `/api/v1/pricing/variants/${vBlackXL.id}`,
        });
        assert.equal(priceBlackXLFallback.json().finalPrice, '8500000');
        assert.equal(priceBlackXLFallback.json().matchedRule.targetType, 'color');
      });
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
