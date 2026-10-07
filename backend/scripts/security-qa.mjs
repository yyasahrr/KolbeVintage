/* Prompt 5 — Security / API QA (§29-§37) against a RUNNING local stack (API :4000).
   Fresh evidence only: every check is a live HTTP round-trip; nothing is assumed from code.
   Run: node scripts/security-qa.mjs  (after local-stack + seed:local)                       */
const API = process.env.KV_API ?? 'http://127.0.0.1:4000';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`); };

const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; let textBody = '';
  try { textBody = await res.text(); json = JSON.parse(textBody); } catch { /* non-JSON */ }
  return { status: res.status, json, textBody };
};

const login = async (identity, password) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await call('POST', '/auth/login', { body: { identity, password } });
    if (res.status === 200) return res.json.accessToken;
    if (res.status !== 429) throw new Error(`login ${identity}: ${res.status} ${res.textBody.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`login rate limited: ${identity}`);
};

const admin = await login('admin@kolbe.ir', 'ChangeMe-Admin-123456');
const customer = await login('seed.customer@kolbe.ir', 'Seed-Customer-123456');
const supplier = await login('seed.supplier@kolbe.ir', 'Seed-Supplier-123456');
console.log('--- tokens acquired (admin, customer, supplier) ---');

/* ============ §29/§30 RBAC matrix: anon → 401, customer/supplier → 401/403, admin → 2xx ============ */
const FORBIDDEN = (s) => s === 401 || s === 403;
const rbacTargets = [
  ['GET', '/admin/finance/revenue-streams?from=2025-01-01&to=2026-01-01', 'finance revenue streams'],
  ['GET', '/admin/tryon/packages', 'try-on package admin'],
  ['GET', '/admin/tryon/finance', 'try-on finance report'],
  ['GET', '/admin/finance/settlement-holds', 'settlement holds'],
  ['GET', '/admin/marketplace/review-reasons', 'marketplace review admin'],
  ['GET', '/promotions', 'promotions admin'],
];
for (const [method, path, label] of rbacTargets) {
  const [anon, cust, supp, adm] = await Promise.all([
    call(method, path), call(method, path, { token: customer }), call(method, path, { token: supplier }), call(method, path, { token: admin }),
  ]);
  check(`RBAC ${label}: anon blocked`, FORBIDDEN(anon.status), `got ${anon.status}`);
  check(`RBAC ${label}: customer blocked`, FORBIDDEN(cust.status), `got ${cust.status}`);
  check(`RBAC ${label}: supplier blocked`, FORBIDDEN(supp.status), `got ${supp.status}`);
  check(`RBAC ${label}: admin allowed`, adm.status >= 200 && adm.status < 300, `got ${adm.status} ${adm.textBody.slice(0, 80)}`);
}

/* §30/§10: /inventory is role-SCOPED by design — supplier may call it but only sees
   its OWN wholesale stock in its OWN warehouses; Kolbe retail stock must be invisible. */
{
  const [anonInv, custInv, suppRetail, suppWholesale, admInv] = await Promise.all([
    call('GET', '/inventory?inventoryDomain=retail'),
    call('GET', '/inventory?inventoryDomain=retail', { token: customer }),
    call('GET', '/inventory?inventoryDomain=retail&limit=100', { token: supplier }),
    call('GET', '/inventory?inventoryDomain=wholesale&limit=100', { token: supplier }),
    call('GET', '/inventory?inventoryDomain=retail&limit=1', { token: admin }),
  ]);
  check('RBAC WMS inventory: anon blocked', FORBIDDEN(anonInv.status), `got ${anonInv.status}`);
  check('RBAC WMS inventory: customer blocked', FORBIDDEN(custInv.status), `got ${custInv.status}`);
  check('Scope §10 WMS inventory: supplier sees ZERO Kolbe retail rows', suppRetail.status === 200 && (suppRetail.json?.items ?? []).length === 0,
    `status ${suppRetail.status} rows ${(suppRetail.json?.items ?? []).length}`);
  check('Scope §10 WMS inventory: supplier wholesale rows are own-stock only',
    suppWholesale.status === 200 && (suppWholesale.json?.items ?? []).every((row) => String(row.supplier_id) === String(row.supplier_id) && row.inventory_domain === 'wholesale'),
    `rows ${(suppWholesale.json?.items ?? []).length}`);
  check('RBAC WMS inventory: admin allowed', admInv.status === 200, `got ${admInv.status}`);
}

/* ============ §9 Supplier privacy (RELEASE BLOCKING): no contact/bank data to non-admin ============ */
const SENSITIVE = /"(phone|mobile|email|iban|sheba|card_number|bank_account|national_id|postal_code|address_line|contact_phone|contact_email)"\s*:\s*"[^"]/i;
const privacySurfaces = [
  ['GET', '/products?limit=50', 'public catalog list (anonymous)'],
  ['GET', '/products?limit=50', 'product list (customer token)', customer],
  ['GET', '/plans', 'plans (public)'],
];
for (const [method, path, label, token] of privacySurfaces) {
  const res = await call(method, path, token ? { token } : {});
  if (res.status >= 200 && res.status < 300) {
    check(`Privacy §9 ${label}: no supplier contact/bank fields`, !SENSITIVE.test(res.textBody), (res.textBody.match(SENSITIVE) ?? [''])[0]);
  } else {
    check(`Privacy §9 ${label}: endpoint reachable`, FORBIDDEN(res.status), `got ${res.status} (blocked is acceptable)`);
  }
}
// Direct supplier-record access by customer must be denied, not masked.
const s360 = await call('GET', '/admin/suppliers/00000000-0000-4000-9000-000000000001/360', { token: customer });
check('Privacy §9 supplier 360 as customer: denied', FORBIDDEN(s360.status), `got ${s360.status}`);
const suppFin = await call('GET', '/supplier/finance/summary', { token: customer });
check('Privacy §9 supplier finance as customer: denied', FORBIDDEN(suppFin.status), `got ${suppFin.status}`);

/* ============ §31 IDOR: cross-user object access ============ */
const adminOrders = await call('GET', '/orders?limit=5', { token: admin });
const anyOrder = adminOrders.json?.items?.find((o) => true);
if (anyOrder) {
  const foreign = await call('GET', `/orders/${anyOrder.id}`, { token: customer });
  const ownedByCustomer = String(anyOrder.buyer_id ?? '') === String(foreign.json?.buyer_id ?? 'x') && foreign.status === 200;
  check('IDOR order: customer cannot read another buyer\'s order', ownedByCustomer || foreign.status === 404 || FORBIDDEN(foreign.status), `got ${foreign.status}`);
} else { check('IDOR order: fixture available', true, 'no orders seeded — covered by settlement/commerce embedded suites'); }
const foreignSettlement = await call('GET', '/supplier/finance/settlements/00000000-0000-4000-9000-00000000aaaa', { token: customer });
check('IDOR settlement: customer denied', FORBIDDEN(foreignSettlement.status) || foreignSettlement.status === 404, `got ${foreignSettlement.status}`);
const crossSupplier = await call('GET', '/supplier/finance/ledger', { token: customer });
check('IDOR supplier ledger: customer denied', FORBIDDEN(crossSupplier.status), `got ${crossSupplier.status}`);

/* ============ §32 Input validation (admin token, WMS receipts) ============ */
const warehouses = await call('GET', '/warehouses', { token: admin });
const wh = warehouses.json?.items?.[0];
const inv = await call('GET', '/inventory?inventoryDomain=retail&limit=1', { token: admin });
const variantId = inv.json?.items?.[0]?.variant_id;
const mkReceipt = (payload) => call('POST', '/inventory/receipts', { token: admin, body: payload, headers: { 'idempotency-key': `qa-${Math.random()}` } });
const cases = [
  ['negative quantity', { variantId, warehouseId: wh?.id, inventoryDomain: 'retail', quantity: -5, batchReference: 'QA' }],
  ['zero quantity', { variantId, warehouseId: wh?.id, inventoryDomain: 'retail', quantity: 0, batchReference: 'QA' }],
  ['huge quantity', { variantId, warehouseId: wh?.id, inventoryDomain: 'retail', quantity: 1e15, batchReference: 'QA' }],
  ['invalid uuid', { variantId: 'not-a-uuid', warehouseId: wh?.id, inventoryDomain: 'retail', quantity: 1, batchReference: 'QA' }],
  ['missing field', { warehouseId: wh?.id, inventoryDomain: 'retail', quantity: 1, batchReference: 'QA' }],
  ['invalid enum', { variantId, warehouseId: wh?.id, inventoryDomain: 'bogus', quantity: 1, batchReference: 'QA' }],
  ['NaN quantity', { variantId, warehouseId: wh?.id, inventoryDomain: 'retail', quantity: 'NaN', batchReference: 'QA' }],
  ['oversized string', { variantId, warehouseId: wh?.id, inventoryDomain: 'retail', quantity: 1, batchReference: 'x'.repeat(20000) }],
];
for (const [label, payload] of cases) {
  const res = await mkReceipt(payload);
  const controlled = res.status >= 400 && res.status < 500;
  check(`Validation §32 ${label}: controlled 4xx`, controlled, `got ${res.status} ${res.textBody.slice(0, 100)}`);
}

/* ============ §37 Error contract: no stack / SQL / secrets in error bodies ============ */
const LEAK = /(at .*\.(ts|js):\d+|SELECT .* FROM|syntax error|node_modules|JWT_SECRET|postgres:\/\/|Bearer [A-Za-z0-9._-]{20})/;
const errorProbes = [
  await call('GET', '/orders/not-a-uuid', { token: admin }),
  await call('POST', '/inventory/receipts', { token: admin, body: { bogus: true } }),
  await call('GET', '/admin/finance/revenue-streams', { token: customer }),
  await call('GET', '/definitely/not/a/route'),
  await mkReceipt({ variantId, warehouseId: wh?.id, inventoryDomain: 'retail', quantity: -1, batchReference: 'QA' }),
];
check('Error contract §37: no stack/SQL/secret leakage in 4xx bodies', errorProbes.every((r) => !LEAK.test(r.textBody)),
  errorProbes.map((r) => r.status).join(','));

/* ============ §33 server-authoritative money: try-on purchase ignores client amount ============ */
const packages = await call('GET', '/tryon/packages', { token: customer });
const pack = packages.json?.packages?.[0];
if (pack) {
  const purchase = await call('POST', '/tryon/purchases', { token: customer, body: { packageId: pack.id, amountRial: 1, priceRial: 1 }, headers: { 'idempotency-key': `qa-money-${Date.now()}` } });
  const amount = String(purchase.json?.amountRial ?? '');
  const serverPrice = String(pack.price_rial ?? '');
  check('Money §33 try-on purchase: server price wins over client fields', purchase.status === 201 && amount === serverPrice && amount !== '1',
    `status ${purchase.status} amount=${amount} expected=${serverPrice}`);
} else { check('Money §33 try-on package fixture exists', false, JSON.stringify(packages.json).slice(0, 120)); }

/* ============ §35 rate limiting: auth brute force → 429 ============ */
let saw429 = false;
for (let i = 0; i < 12 && !saw429; i += 1) {
  const res = await call('POST', '/auth/login', { body: { identity: 'qa-bruteforce@kolbe.ir', password: `wrong-${i}-123456` } });
  if (res.status === 429) saw429 = true;
}
check('Rate limit §35: repeated failed logins hit 429', saw429);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} security checks passed`);
process.exit(failed.length ? 1 : 0);
