import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4011, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 2,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('SKU has DB UNIQUE and concurrent inserts are serialized', { skip: !enabled }, async () => {
  const pool = createPool(config);
  try {
    // Direct DB check: sku UNIQUE
    const sku = `SKU-${randomUUID().slice(0,8).toUpperCase()}`;
    const suffix = sku.slice(4).toLowerCase();
    const cat = 'کت';
    // Insert product + variant via app to exercise sku_sequence
    const app = await buildApp(config);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)', [adminId, `sku-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'SKU admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ identity: `sku-admin-${suffix}@example.test`, password:'AdminPassword123456!' }});
    assert.equal(login.statusCode, 200, login.body);
    const token = login.json().accessToken as string;
    const headers = { authorization: `Bearer ${token}` };
    // Concurrent product creations — SKU sequence must give distinct values
    const payloads = [1,2,3].map(i=> ({ brand:'Kolbe', name:`SKU conc ${sku}-${i}`, category:cat, cashPriceRial:'1000000', variants:[{size:'M',color:'black'}] }));
    const results = await Promise.all(payloads.map(p=> app.inject({ method:'POST', url:'/api/v1/products', headers, payload:p })));
    for(const r of results) assert.equal(r.statusCode, 201, r.body);
    const skus = results.map(r=> ((r.json().variants[0] as {sku:string} | undefined)!.sku));
    assert.equal(new Set(skus).size, 3, `SKU collision: ${skus.join(', ')}`);
    // Manual duplicate SKU insert must violate UNIQUE (skus[0] already exists from concurrent creation)
    await assert.rejects(async ()=> {
      await pool.query('INSERT INTO product_variants(id,product_id,sku,size_label,color_label,attributes) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), (results[0] as NonNullable<typeof results[0]>).json().id, skus[0], 'XL', 'red', JSON.stringify({})]);
    });
    await app.close();
  } finally { await pool.end(); }
});

test('WMS available = on_hand - reserved - damaged and reservations are atomic', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0,8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)', [adminId, `wms-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'WMS admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ identity: `wms-admin-${suffix}@example.test`, password:'AdminPassword123456!' }});
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };
    const product = await app.inject({ method:'POST', url:'/api/v1/products', headers, payload:{ brand:'Kolbe', name:'WMS coat', category:'کت', cashPriceRial:'50000000', variants:[{size:'M',color:'black'}] }});
    assert.equal(product.statusCode, 201, product.body);
    const variantId = (product.json().variants[0] as {id:string}).id as string;
    const productId = product.json().id as string;
    await app.inject({ method:'PATCH', url:`/api/v1/products/${productId}/status`, headers, payload:{ status:'published' }});
    const wh = await app.inject({ method:'POST', url:'/api/v1/warehouses', headers, payload:{ code:`WMS-${suffix.toUpperCase()}`, name:'WMS test WH' }});
    assert.equal(wh.statusCode, 201, wh.body);
    const whId = wh.json().id as string;
    // Create stock: on_hand 10
    const adj1 = await app.inject({ method:'POST', url:'/api/v1/inventory/adjustments', headers:{...headers,'idempotency-key':`wms-${suffix}-1`}, payload:{ variantId, warehouseId: whId, delta:10, reason:'initial', reference:`WMS-${suffix}-1` }});
    assert.equal(adj1.statusCode, 201, adj1.body);
    // Mark 2 as damaged
    const dmg = await app.inject({ method:'POST', url:'/api/v1/inventory/damaged', headers, payload:{ variantId, warehouseId: whId, quantity:2, reason:'broken' }});
    assert.equal(dmg.statusCode, 201, dmg.body);
    // Reserve 3 via order (reserves are done inside order creation)
    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)', [buyerId, `wms-buyer-${suffix}@example.test`, await argon2.hash('BuyerPassword123456!'), 'WMS buyer']);
    const buyerLogin = await app.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ identity:`wms-buyer-${suffix}@example.test`, password:'BuyerPassword123456!' }});
    const buyerHeaders = { authorization:`Bearer ${buyerLogin.json().accessToken as string}` };
    const order = await app.inject({ method:'POST', url:'/api/v1/orders', headers:{...buyerHeaders,'idempotency-key':`wms-order-${suffix}`}, payload:{ orderType:'retail', paymentMode:'cash', items:[{variantId, quantity:3}], shippingAddress:{ recipient:'WMS buyer', phone:'09123456789', province:'Tehran', city:'Tehran', line:'Test street address 12345, Tehran Iran', postalCode:'1234567890' } }});
    assert.equal(order.statusCode, 201, order.body);
    const balances = await app.inject({ method:'GET', url:`/api/v1/inventory?warehouseId=${whId}&variantId=${variantId}`, headers });
    assert.equal(balances.statusCode, 200, balances.body);
    const row = (balances.json().items as {variant_id:string; on_hand:number; reserved:number; damaged:number; available:number}[])[0]!;
    assert.equal(row.on_hand, 10);
    assert.equal(row.reserved, 3);
    assert.equal(row.damaged, 2);
    assert.equal(row.available, 5, `available should be on_hand - reserved - damaged = 10-3-2=5 but got ${row.available}`);
    // Idempotent adjust: same key should not double count (200 or 201 accepted)
    const adjDup = await app.inject({ method:'POST', url:'/api/v1/inventory/adjustments', headers:{...headers,'idempotency-key':`wms-${suffix}-1`}, payload:{ variantId, warehouseId: whId, delta:10, reason:'initial', reference:`WMS-${suffix}-1` }});
    assert.ok(adjDup.statusCode === 200 || adjDup.statusCode === 201, adjDup.body);
    const balances2 = await app.inject({ method:'GET', url:`/api/v1/inventory?warehouseId=${whId}&variantId=${variantId}`, headers });
    const row2 = (balances2.json().items as typeof row[])[0]!;
    assert.equal(row2.on_hand, 10, 'idempotent adjust duplicated');
  } finally { await app.close(); await pool.end(); }
});
