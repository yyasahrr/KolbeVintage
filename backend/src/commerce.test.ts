import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, type DbPool } from './db.js';

const config: Config = {
  NODE_ENV: 'test', PORT: 4011, DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters',
  PG_POOL_MAX: 2, PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

function multipart(file: { name: string; type: string; content: Buffer }) {
  const boundary = `----kolbe${randomUUID().replace(/-/g, '')}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, file.content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

const ADDRESS = {
  recipient: 'خریدار تست', phone: '09123456789', province: 'تهران', city: 'تهران',
  line: 'خیابان تست، پلاک ۱', postalCode: '1234567890',
};

describe('commerce: types, specs, shipping, marketplace, imports', { skip: !process.env.TEST_DATABASE_URL }, () => {
  let app: FastifyInstance;
  let pool: DbPool;
  let admin: Record<string, string>;
  let supplier: Record<string, string>;
  let buyerA: Record<string, string>;
  let buyerB: Record<string, string>;
  let buyerBId = '';
  let planId = '';
  let warehouseId = '';
  let tshirtTypeId = '';
  let productP1 = '';
  let variantP1 = '';
  let skuP1 = '';
  let productP2 = '';
  let variantP2 = '';
  const suffix = randomUUID().slice(0, 8);

  const login = async (identity: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity, password } });
    assert.equal(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().accessToken as string}` };
  };

  const stockUp = async (variantId: string, qty: number, tag: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...admin, 'idempotency-key': `stk-${tag}-${suffix}` },
      payload: { variantId, warehouseId, delta: qty, reason: 'موجودی اولیه تست', reference: `ST-${tag}-${suffix}` } });
    assert.equal(res.statusCode, 201, res.body);
  };

  const publish = async (productId: string) => {
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [productId]);
  };

  const waitForJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/admin/imports/${jobId}`, headers: admin });
      assert.equal(res.statusCode, 200, res.body);
      const job = res.json() as { status: string };
      if (job.status === 'done' || job.status === 'failed') return res.json() as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail(`import job ${jobId} did not finish in time`);
  };

  before(async () => {
    app = await buildApp(config);
    pool = createPool(config);
    const mkUser = async (email: string, password: string, role: string, display: string) => {
      const id = randomUUID();
      await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
        [id, email, await argon2.hash(password), display]);
      await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, role]);
      return id;
    };
    await mkUser(`c-admin-${suffix}@example.test`, 'AdminPassword123456!', 'admin', 'مدیر تست');
    const supplierId = await mkUser(`c-sup-${suffix}@example.test`, 'SupplierPassword12345!', 'supplier', 'تأمین‌کننده');
    await pool.query(`INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status,commission_percent) VALUES ($1,$2,'approved',10)`,
      [supplierId, `Brand ${suffix}`]);
    await mkUser(`c-a-${suffix}@example.test`, 'BuyerAPassword123456!', 'customer', 'خریدار الف');
    buyerBId = await mkUser(`c-b-${suffix}@example.test`, 'BuyerBPassword123456!', 'customer', 'خریدار ب');
    admin = await login(`c-admin-${suffix}@example.test`, 'AdminPassword123456!');
    supplier = await login(`c-sup-${suffix}@example.test`, 'SupplierPassword12345!');
    buyerA = await login(`c-a-${suffix}@example.test`, 'BuyerAPassword123456!');
    buyerB = await login(`c-b-${suffix}@example.test`, 'BuyerBPassword123456!');

    planId = randomUUID();
    await pool.query(`INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,$3,0,$4)`,
      [planId, `c-plan-${suffix}`, 'پلن عمده تست', JSON.stringify({ discountPercent: 10 })]);
    await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`,
      [randomUUID(), buyerBId, planId]);

    const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: admin,
      payload: { code: `CW-${suffix.toUpperCase()}`, name: 'انبار مرکزی تست' } });
    assert.equal(warehouse.statusCode, 201, warehouse.body);
    warehouseId = warehouse.json().id as string;
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  it('serves seeded product types, sizes and taxonomies', async () => {
    const types = await app.inject({ method: 'GET', url: '/api/v1/product-types', headers: admin });
    assert.equal(types.statusCode, 200, types.body);
    const tshirt = (types.json().items as { id: string; code: string; sizes: { code: string }[] }[])
      .find((item) => item.code === 'tshirt');
    assert.ok(tshirt, 'seeded tshirt type missing');
    assert.ok(tshirt.sizes.some((size) => size.code === 'M'), 'seeded M size missing');
    tshirtTypeId = tshirt.id;

    const genders = await app.inject({ method: 'GET', url: '/api/v1/taxonomies?kind=gender', headers: admin });
    assert.deepEqual((genders.json().items as { code: string }[]).map((item) => item.code).sort(),
      ['female', 'kids', 'male', 'unisex']);
    const seasons = await app.inject({ method: 'GET', url: '/api/v1/taxonomies?kind=season', headers: admin });
    assert.ok((seasons.json().items as { code: string }[]).some((item) => item.code === 'autumn'));
  });

  it('admin manages product types and sizes', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/product-types', headers: admin,
      payload: { code: `ct-${suffix}`, name: 'نوع تست', description: '', active: true, position: 99 } });
    assert.equal(created.statusCode, 201, created.body);
    const typeId = created.json().id as string;

    const bad = await app.inject({ method: 'POST', url: '/api/v1/admin/product-types', headers: admin,
      payload: { code: 'Bad Code!', name: 'x', description: '' } });
    assert.equal(bad.statusCode, 400, bad.body);

    const size = await app.inject({ method: 'POST', url: `/api/v1/admin/product-types/${typeId}/sizes`, headers: admin,
      payload: { code: 'M', label: 'مدیوم', active: true, position: 1 } });
    assert.equal(size.statusCode, 201, size.body);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/admin/product-types/${typeId}`, headers: admin,
      payload: { name: 'نوع تست ویرایش‌شده' } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().name, 'نوع تست ویرایش‌شده');
  });

  it('product creation validates sizes and gender/season taxonomies', async () => {
    const base = { brand: 'کلبه', category: 'تی‌شرت', cashPriceRial: '50000000', productTypeId: tshirtTypeId,
      genderCode: 'female', seasons: ['autumn', 'winter'], installmentPolicy: 'enabled',
      variants: [{ size: 'M', color: 'کرم', weightGrams: 800 }] };
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin,
      payload: { ...base, name: `تی‌شرت تست ${suffix}` } });
    assert.equal(created.statusCode, 201, created.body);
    productP1 = created.json().id as string;
    variantP1 = created.json().variants[0].id as string;
    skuP1 = created.json().variants[0].sku as string;
    assert.match(skuP1, /^KV-/);
    await publish(productP1);
    await stockUp(variantP1, 10, 'p1');

    const badSize = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin,
      payload: { ...base, name: `سایز بد ${suffix}`, variants: [{ size: 'XXL-BAD' }] } });
    assert.equal(badSize.statusCode, 400, badSize.body);

    const badGender = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin,
      payload: { ...base, name: `جنسیت بد ${suffix}`, genderCode: 'alien' } });
    assert.equal(badGender.statusCode, 400, badGender.body);

    const badSeason = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin,
      payload: { ...base, name: `فصل بد ${suffix}`, seasons: ['monsoon'] } });
    assert.equal(badSeason.statusCode, 400, badSeason.body);
  });

  it('spec templates validate product values', async () => {
    const attribute = await app.inject({ method: 'POST', url: '/api/v1/admin/spec-attributes', headers: admin,
      payload: { code: `fabric-${suffix}`, label: 'جنس پارچه', description: '', type: 'single_select',
        required: true, searchable: false, filterable: true, scope: 'product', position: 1, validation: {}, active: true,
        options: [{ value: 'cotton', label: 'نخی' }, { value: 'wool', label: 'پشمی' }] } });
    assert.equal(attribute.statusCode, 201, attribute.body);
    const attributeId = attribute.json().id as string;

    const template = await app.inject({ method: 'POST', url: '/api/v1/admin/spec-templates', headers: admin,
      payload: { code: `tpl-${suffix}`, name: 'قالب تست', description: '', active: true } });
    assert.equal(template.statusCode, 201, template.body);
    const templateId = template.json().id as string;

    const group = await app.inject({ method: 'POST', url: `/api/v1/admin/spec-templates/${templateId}/groups`, headers: admin,
      payload: { name: 'مشخصات اصلی', position: 1 } });
    assert.equal(group.statusCode, 201, group.body);

    const linked = await app.inject({ method: 'POST', url: `/api/v1/admin/spec-templates/${templateId}/attributes`, headers: admin,
      payload: { attributeId, groupId: group.json().id, position: 1 } });
    assert.equal(linked.statusCode, 201, linked.body);

    const invalid = await app.inject({ method: 'PUT', url: `/api/v1/products/${productP1}/specs`, headers: admin,
      payload: { values: [{ attributeCode: `fabric-${suffix}`, value: 'plastic' }] } });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const saved = await app.inject({ method: 'PUT', url: `/api/v1/products/${productP1}/specs`, headers: admin,
      payload: { values: [{ attributeCode: `fabric-${suffix}`, value: 'cotton' }] } });
    assert.equal(saved.statusCode, 200, saved.body);

    const read = await app.inject({ method: 'GET', url: `/api/v1/products/${productP1}/specs`, headers: admin });
    assert.equal(read.statusCode, 200, read.body);
    assert.ok((read.json().values as { value: string }[]).some((item) => item.value === 'cotton'));
  });

  it('size guides attach in link or detached mode', async () => {
    const guide = await app.inject({ method: 'POST', url: '/api/v1/admin/size-guides', headers: admin,
      payload: { code: `guide-${suffix}`, name: 'راهنمای تست', description: '', status: 'active' } });
    assert.equal(guide.statusCode, 201, guide.body);
    const guideId = guide.json().id as string;

    for (const [code, label] of [['size', 'سایز'], ['chest', 'دور سینه']]) {
      const column = await app.inject({ method: 'POST', url: `/api/v1/admin/size-guides/${guideId}/columns`, headers: admin,
        payload: { code, label, unit: code === 'chest' ? 'cm' : null, position: 1 } });
      assert.equal(column.statusCode, 201, column.body);
    }
    const rows = await app.inject({ method: 'PUT', url: `/api/v1/admin/size-guides/${guideId}/rows`, headers: admin,
      payload: { rows: [{ size: 'M', chest: '96' }, { size: 'L', chest: '100' }] } });
    assert.equal(rows.statusCode, 200, rows.body);

    const attach = await app.inject({ method: 'PUT', url: `/api/v1/products/${productP1}/size-guide`, headers: admin,
      payload: { guideId, mode: 'link' } });
    assert.equal(attach.statusCode, 200, attach.body);

    const resolved = await app.inject({ method: 'GET', url: `/api/v1/products/${productP1}/size-guide`, headers: admin });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().mode, 'link');
    assert.equal((resolved.json().guide.rows as unknown[]).length, 2);

    const detached = await app.inject({ method: 'PUT', url: `/api/v1/products/${productP1}/size-guide`, headers: admin,
      payload: { guideId, mode: 'detached' } });
    assert.equal(detached.statusCode, 200, detached.body);
    const frozen = await app.inject({ method: 'GET', url: `/api/v1/products/${productP1}/size-guide`, headers: admin });
    assert.equal(frozen.json().mode, 'detached');
  });

  it('weight-based shipping rules price the quote', async () => {
    const method = await app.inject({ method: 'POST', url: '/api/v1/admin/shipping-methods', headers: admin,
      payload: { code: `post-${suffix}`, name: 'پست تست', active: true, type: 'standard', pricingType: 'weight',
        baseFeeRial: '90000', freeAboveRial: null, estimatedMinDays: 2, estimatedMaxDays: 5, config: {} } });
    assert.equal(method.statusCode, 201, method.body);
    const methodId = method.json().id as string;

    for (const [min, max, fee, position] of [[0, 1000, '30000', 1], [1001, null, '50000', 2]] as const) {
      const rule = await app.inject({ method: 'POST', url: `/api/v1/admin/shipping-methods/${methodId}/rules`, headers: admin,
        payload: { ruleType: 'weight', minWeightGrams: min, maxWeightGrams: max, feeRial: fee, position, active: true } });
      assert.equal(rule.statusCode, 201, rule.body);
    }

    const light = await app.inject({ method: 'POST', url: '/api/v1/shipping/quote',
      payload: { methodId, items: [{ variantId: variantP1, quantity: 1 }], subtotalRial: '50000000' } });
    assert.equal(light.statusCode, 200, light.body);
    assert.equal(light.json().feeRial, '30000');
    assert.equal(light.json().totalWeightGrams, 800);
    assert.ok(light.json().ruleId);

    const heavy = await app.inject({ method: 'POST', url: '/api/v1/shipping/quote',
      payload: { methodId, items: [{ variantId: variantP1, quantity: 2 }], subtotalRial: '100000000' } });
    assert.equal(heavy.json().feeRial, '50000');
  });

  it('retail checkout stores shipping and the pricing snapshot', async () => {
    const methods = await app.inject({ method: 'GET', url: '/api/v1/shipping-methods', headers: admin });
    const methodId = (methods.json().items as { id: string; code: string }[])
      .find((item) => item.code === `post-${suffix}`)!.id;
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerA, 'idempotency-key': `o-ship-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId: variantP1, quantity: 1 }],
        shippingMethodId: methodId, shippingAddress: ADDRESS } });
    assert.equal(order.statusCode, 201, order.body);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/orders/${order.json().id}`, headers: buyerA });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().shipping_rial, '30000');
    const snapshot = detail.json().pricing_snapshot as Record<string, unknown>;
    assert.equal(snapshot.totalRial, detail.json().total_rial);
    assert.ok((snapshot.shipping as Record<string, unknown>).ruleId);
    assert.ok(snapshot.installment);
  });

  it('supplier listings are wholesale-only with per-product MOQ', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplier,
      payload: { brand: `Brand ${suffix}`, name: `کت عمده ${suffix}`, category: 'کت', cashPriceRial: '100000000',
        wholesalePriceRial: '80000000', wholesaleMoq: 5, variants: [{ size: 'M', color: 'کرم' }] } });
    assert.equal(created.statusCode, 201, created.body);
    assert.match(created.json().variants[0].sku as string, /^SP-/);
    productP2 = created.json().id as string;
    variantP2 = created.json().variants[0].id as string;
    await publish(productP2);
    await stockUp(variantP2, 20, 'p2');

    const retail = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerA, 'idempotency-key': `o-rt-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId: variantP2, quantity: 1 }], shippingAddress: ADDRESS } });
    assert.equal(retail.statusCode, 403, retail.body);

    const noPlan = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerA, 'idempotency-key': `o-np-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash', items: [{ variantId: variantP2, quantity: 5 }], shippingAddress: ADDRESS } });
    assert.equal(noPlan.statusCode, 403, noPlan.body);

    const underMoq = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerB, 'idempotency-key': `o-moq-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash', items: [{ variantId: variantP2, quantity: 2 }], shippingAddress: ADDRESS } });
    assert.equal(underMoq.statusCode, 409, underMoq.body);

    const ok = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerB, 'idempotency-key': `o-ws-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash', items: [{ variantId: variantP2, quantity: 5 }], shippingAddress: ADDRESS } });
    assert.equal(ok.statusCode, 201, ok.body);
    // 5 × 80,000,000 with the 10% plan discount.
    assert.equal(ok.json().discountRial, '40000000');
  });

  it('installment eligibility is decided by the server', async () => {
    const mk = async (name: string, policy: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin,
        payload: { brand: 'کلبه', name, category: 'کت', cashPriceRial: '60000000', wholesalePriceRial: '50000000',
          installmentPolicy: policy, variants: [{ size: 'M' }] } });
      assert.equal(res.statusCode, 201, res.body);
      await publish(res.json().id as string);
      await stockUp(res.json().variants[0].id as string, 10, `inst-${policy}`);
      return res.json().variants[0].id as string;
    };
    const disabledVariant = await mk(`کت بدون قسط ${suffix}`, 'disabled');
    const conditionalVariant = await mk(`کت مشروط ${suffix}`, 'disabled_when_discounted');

    const blocked = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerA, 'idempotency-key': `o-id-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'four_installments',
        items: [{ variantId: disabledVariant, quantity: 1 }], shippingAddress: ADDRESS } });
    assert.equal(blocked.statusCode, 409, blocked.body);

    // Buyer B's plan applies 10% off, so the conditional product blocks installments.
    const discounted = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerB, 'idempotency-key': `o-ic-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'four_installments',
        items: [{ variantId: conditionalVariant, quantity: 1 }], shippingAddress: ADDRESS } });
    assert.equal(discounted.statusCode, 409, discounted.body);

    await pool.query('UPDATE membership_plans SET limits = $2 WHERE id = $1', [planId, JSON.stringify({})]);
    const allowed = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerB, 'idempotency-key': `o-ia-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'four_installments',
        items: [{ variantId: conditionalVariant, quantity: 1 }], shippingAddress: ADDRESS } });
    assert.equal(allowed.statusCode, 201, allowed.body);
  });

  it('order list supports sorts, filters and search', async () => {
    const byTotal = await app.inject({ method: 'GET', url: '/api/v1/orders?sort=total&limit=50', headers: admin });
    assert.equal(byTotal.statusCode, 200, byTotal.body);
    const totals = (byTotal.json().items as { total_rial: string }[]).map((item) => BigInt(item.total_rial));
    assert.ok(totals.length >= 3, 'expected seeded orders');
    for (let index = 1; index < totals.length; index++) {
      assert.ok(totals[index - 1]! >= totals[index]!, 'total sort is not descending');
    }
    const wholesale = await app.inject({ method: 'GET', url: '/api/v1/orders?sort=newest&orderType=wholesale&limit=50', headers: admin });
    assert.ok((wholesale.json().items as { order_type: string }[]).every((item) => item.order_type === 'wholesale'));
    const reference = (byTotal.json().items as { reference: string }[])[0]!.reference;
    const found = await app.inject({ method: 'GET', url: `/api/v1/orders?search=${encodeURIComponent(reference)}`, headers: admin });
    assert.ok((found.json().items as { reference: string }[]).some((item) => item.reference === reference));
  });

  it('marketplace rejection requires a reason and resubmission reopens review', async () => {
    const reasons = await app.inject({ method: 'GET', url: '/api/v1/admin/marketplace/review-reasons', headers: admin });
    assert.equal(reasons.statusCode, 200, reasons.body);
    assert.ok((reasons.json().items as { code: string }[]).some((item) => item.code === 'bad-images'));

    const noReason = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productP2}/review`, headers: admin,
      payload: { decision: 'rejected', note: 'بدون دلیل' } });
    assert.equal(noReason.statusCode, 400, noReason.body);

    const badReason = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productP2}/review`, headers: admin,
      payload: { decision: 'rejected', reasonCode: 'nope', note: 'x' } });
    assert.equal(badReason.statusCode, 400, badReason.body);

    const rejected = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productP2}/review`, headers: admin,
      payload: { decision: 'rejected', reasonCode: 'bad-images', note: 'لطفاً عکس بهتر بفرستید.' } });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(rejected.json().status, 'rejected');

    const mine = await app.inject({ method: 'GET', url: '/api/v1/supplier/products?status=rejected', headers: supplier });
    const row = (mine.json().items as { id: string; last_reason: string; last_decision: string }[])
      .find((item) => item.id === productP2);
    assert.ok(row, 'supplier cannot see own rejected product');
    assert.equal(row.last_decision, 'rejected');
    assert.match(row.last_reason, /تصاویر/);

    const resubmitted = await app.inject({ method: 'POST', url: `/api/v1/supplier/products/${productP2}/resubmit`, headers: supplier });
    assert.equal(resubmitted.statusCode, 200, resubmitted.body);
    assert.equal(resubmitted.json().status, 'pending');

    const queue = await app.inject({ method: 'GET', url: '/api/v1/admin/marketplace/products?limit=50', headers: admin });
    const queued = (queue.json().items as { id: string; last_reason: string }[]).find((item) => item.id === productP2);
    assert.ok(queued, 'resubmitted product missing from the review queue');
    assert.match(queued.last_reason, /تصاویر/);
  });

  it('imported users must set a password before login', async () => {
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users(id,email,password_hash,display_name,must_reset_password) VALUES ($1,$2,$3,$4,true)`,
      [userId, `c-reset-${suffix}@example.test`, await argon2.hash('LegacyPassword123456!'), 'کاربر مهاجر']);

    const blocked = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `c-reset-${suffix}@example.test`, password: 'LegacyPassword123456!' } });
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(blocked.json().code, 'PASSWORD_RESET_REQUIRED');

    const issued = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${userId}/reset-token`, headers: admin,
      payload: { ttlHours: 72 } });
    assert.equal(issued.statusCode, 200, issued.body);
    const token = issued.json().token as string;
    assert.ok(token.length > 20);

    const set = await app.inject({ method: 'POST', url: '/api/v1/auth/set-password',
      payload: { token, newPassword: 'BrandNewPassword123!' } });
    assert.equal(set.statusCode, 200, set.body);

    await login(`c-reset-${suffix}@example.test`, 'BrandNewPassword123!');

    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/set-password',
      payload: { token, newPassword: 'AnotherPassword123!' } });
    assert.ok([400, 404, 410].includes(reuse.statusCode), reuse.body);
  });

  it('imports products from CSV with dry-run and a background run', async () => {
    const csv = [
      'نام کالا,برند,دسته,قیمت نقدی (ریال),سایز,رنگ,کد قدیمی',
      `شال تست ${suffix},کلبه,شال,12000000,M,کرم,LEG-${suffix}`,
      `ردیف خراب ${suffix},کلبه,شال,,M,کرم,LEG-BAD-${suffix}`,
    ].join('\n');
    const file = multipart({ name: 'products.csv', type: 'text/csv', content: Buffer.from(csv, 'utf-8') });
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload?type=products&mode=create_update&matchBy=legacy_id',
      headers: { ...admin, 'content-type': file.contentType }, payload: file.payload });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    assert.ok((uploaded.json().mapping as Record<string, string>).name, 'smart mapping missed the name column');

    const jobId = uploaded.json().jobId as string;
    const dry = await app.inject({ method: 'POST', url: `/api/v1/admin/imports/${jobId}/dry-run`, headers: admin });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.equal(dry.json().valid, 1);
    assert.equal(dry.json().errors, 1);

    const run = await app.inject({ method: 'POST', url: `/api/v1/admin/imports/${jobId}/run`, headers: admin });
    assert.equal(run.statusCode, 202, run.body);
    const finished = await waitForJob(jobId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.succeeded_rows, 1);
    assert.equal(finished.failed_rows, 1);

    const created = await pool.query('SELECT id, name FROM products WHERE import_key = $1', [`LEG-${suffix}`]);
    assert.equal(created.rows.length, 1);

    const errorsCsv = await app.inject({ method: 'GET', url: `/api/v1/admin/imports/${jobId}/errors.csv`, headers: admin });
    assert.equal(errorsCsv.statusCode, 200, errorsCsv.body);
    assert.match(errorsCsv.body, /row/);

    const frozen = await app.inject({ method: 'PUT', url: `/api/v1/admin/imports/${jobId}/mapping`, headers: admin,
      payload: { mapping: { name: 'نام کالا' } } });
    assert.equal(frozen.statusCode, 409, frozen.body);
  });

  it('imports legacy users and issues one-time reset tokens', async () => {
    const csv = [
      'نام,ایمیل,موبایل,تاریخ عضویت,سطح',
      `کاربر مهاجر ${suffix},c-legacy-${suffix}@example.test,09120000001,1402/05/10,vip`,
    ].join('\n');
    const file = multipart({ name: 'users.csv', type: 'text/csv', content: Buffer.from(csv, 'utf-8') });
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload?type=users&mode=create_only&matchBy=email',
      headers: { ...admin, 'content-type': file.contentType }, payload: file.payload });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const jobId = uploaded.json().jobId as string;

    const run = await app.inject({ method: 'POST', url: `/api/v1/admin/imports/${jobId}/run`, headers: admin });
    assert.equal(run.statusCode, 202, run.body);
    const finished = await waitForJob(jobId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.succeeded_rows, 1);

    const user = await pool.query('SELECT id, must_reset_password FROM users WHERE email = $1',
      [`c-legacy-${suffix}@example.test`]);
    assert.equal(user.rows.length, 1);
    assert.equal(user.rows[0].must_reset_password, true);

    const report = finished.report as { resetTokens?: { row: number; token: string }[] };
    assert.equal(report.resetTokens?.length, 1);

    const blocked = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `c-legacy-${suffix}@example.test`, password: 'whatever-password-1' } });
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(blocked.json().code, 'PASSWORD_RESET_REQUIRED');
  });

  it('imports inventory receipts per variant and warehouse', async () => {
    const before = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2',
      [variantP2, warehouseId]);
    const csv = [
      'sku,تعداد,انبار,حالت',
      `${(await pool.query('SELECT sku FROM product_variants WHERE id = $1', [variantP2])).rows[0].sku},7,CW-${suffix.toUpperCase()},receipt`,
    ].join('\n');
    const file = multipart({ name: 'inventory.csv', type: 'text/csv', content: Buffer.from(csv, 'utf-8') });
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload?type=inventory&mode=create_update&matchBy=sku',
      headers: { ...admin, 'content-type': file.contentType }, payload: file.payload });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const jobId = uploaded.json().jobId as string;

    const run = await app.inject({ method: 'POST', url: `/api/v1/admin/imports/${jobId}/run`, headers: admin });
    assert.equal(run.statusCode, 202, run.body);
    const finished = await waitForJob(jobId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.succeeded_rows, 1);

    const after = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2',
      [variantP2, warehouseId]);
    assert.equal(Number(after.rows[0].on_hand) - Number(before.rows[0].on_hand), 7);
  });
});
