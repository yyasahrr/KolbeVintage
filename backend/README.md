# Kolbe Vintage backend

## Stack

TypeScript, Node.js, Fastify, PostgreSQL, Redis/BullMQ. The API is a modular monolith. PostgreSQL is the source of truth for orders, stock and financial records. All monetary values are integer **rial strings** in JSON and `numeric(20,0)` in PostgreSQL; JavaScript floating point is never used for order or ledger arithmetic.

## Local startup

1. Install Node.js 22+ and PostgreSQL 16+. Redis is needed for the worker and for production rate limiting.
2. `cd backend && npm ci`
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, a random 32+ character `JWT_SECRET`, and `PUBLIC_ORIGIN`. Set `REDIS_URL` when running the worker. Set `API_PUBLIC_URL` to the public HTTPS API origin for gateway callbacks.
4. `npm run migrate`
5. Set `BOOTSTRAP_ADMIN_EMAIL` and a 16+ character `BOOTSTRAP_ADMIN_PASSWORD`, then run `npm run bootstrap:admin` **once**.
6. `npm run dev` starts the API on port 4000; `npm run worker` processes the outbox and creates in-app notifications.

For cash retail checkout, configure `ZIBAL_MERCHANT`. For cash wholesale checkout, configure `NEXTPAY_API_KEY`. The gateway returns to `GET /api/v1/payments/callback`; configure that public URL in your merchant accounts. Callback fields are treated only as identifiers. The backend calls the provider's verify endpoint and checks the stored amount, order reference and transaction ID before updating an order. Use HTTPS and `COOKIE_SECURE=true` in production.

For transactional SMS, set `MELIPAYAMAK_USERNAME`, `MELIPAYAMAK_PASSWORD` and `MELIPAYAMAK_SENDER` on the worker. An SMS with uncertain submission outcome is marked `unknown` for manual reconciliation and is not automatically resent.

## API overview

All routes have prefix `/api/v1` except `/health/live` and `/health/ready`.

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me` |
| Catalog | `GET /products`, `/wholesale/products`; `POST /products`, `PATCH /products/:id/status` |
| Warehouse/stock | `POST /warehouses`, `/inventory/adjustments`; `GET /inventory` |
| Orders | `POST /orders`, `/orders/:id/transitions`; `GET /orders`, `/orders/:id` |
| Invoices | `POST /invoices`, `/invoices/:id/payments`, `/invoices/:id/cancel`, `/invoices/:id/revisions`; `GET /invoices`, `/invoices/:id` |
| Wallet/withdrawals | `GET /wallet`, `/wallet/entries`, `/wallet/withdrawals`; `POST /wallet/withdrawals`; admin `GET /admin/withdrawals`, `POST /admin/withdrawals/:id/status` |
| Settlements | `GET /settlements`; `POST /settlements`, `/settlements/:id/settle` |
| Suppliers | `GET/PATCH /supplier-profile`, `/supplier-profile/versions`, `POST /supplier-profile/documents`; public `GET /cooperation-form`, `POST /cooperation-requests`; admin supplier list/status, cooperation review, form management |
| Plans/membership | `GET /plans`; `POST /plans`, `/memberships` |
| Payments | `POST /payments/:id/checkout` and `GET /payments/callback` when Zibal is configured |
| Support | `POST /tickets`, `/tickets/:id/messages`; `GET /tickets`, `/tickets/:id`; status management |
| Notifications/admin | Notification listing/read; audit and ledger read endpoints |

Authenticated requests use `Authorization: Bearer <accessToken>`. Refresh tokens are rotated and stored only as hashes in the database; clients receive them in an HTTP-only cookie. Order, stock-adjustment and membership creation requests require a stable `Idempotency-Key` header. The API computes prices and discounts from database records, not client totals.

Example checkout body:

```json
{
  "orderType": "retail",
  "paymentMode": "cash",
  "items": [{ "variantId": "00000000-0000-4000-8000-000000000000", "quantity": 1 }],
  "shippingAddress": {
    "recipient": "نام خریدار", "phone": "09123456789", "province": "تهران",
    "city": "تهران", "line": "نشانی کامل، پلاک و واحد", "postalCode": "1234567890"
  }
}
```

## Verification

`npm run build` checks TypeScript. To run the integration test, migrate an isolated test database, set `TEST_DATABASE_URL` to its URL and run `npm test`. The test covers concurrent stock reservation, duplicate checkout, exact large integers, verified-payment deduplication, balanced ledger posting, membership activation and ticket replies.

## Current integration boundary

The backend provides the core data and transaction layer. It is **not yet a production payment system**. Zibal and NextPay are wired for cash retail and cash wholesale respectively, and MeliPayamak SMS is wired to the worker, but no live merchant credentials or sandbox callbacks have been tested. The admin console now uses server authentication and exposes a real order list and status transitions. Its other modules and the customer/supplier portals still use local demo data. DigiPay and SnappPay installment checkout, Vandar wallet/IBAN settlement, refund/reconciliation jobs, and the remaining frontend API replacement still need implementation and provider-specific acceptance tests. A pending payment never becomes paid without a verified provider response. Use the provider contract and keys issued to this merchant before enabling those flows.

In development, Vite proxies `/api` to `http://127.0.0.1:4000`. In deployment, route `/api` to the backend at the reverse proxy or set `VITE_API_BASE_URL` to the public API origin when building the frontend.
