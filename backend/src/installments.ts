import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { badRequest, notFound } from './errors.js';

/* Installment providers (Req 188-191): count, eligibility limits, fee and wording come from the
   Integration/Pricing domain. The storefront and CMS only render the offers computed here. */

export type InstallmentProvider = {
  code: string; title: string; integration_code: string | null; installments_count: number; min_order_rial: string; max_order_rial: string | null;
  fee_percent: string; badge_text: string; terms: string; brand_color: string; logo_url: string | null; position: number; active: boolean;
};
export type InstallmentOffer = { provider: string; title: string; count: number; perInstallmentRial: string; totalRial: string; badge: string; terms: string; color: string };

type Queryable = DbPool | PoolClient;

export async function installmentProviders(db: Queryable, activeOnly = true): Promise<InstallmentProvider[]> {
  try {
    const rows = await db.query(`SELECT code, title, integration_code, installments_count, min_order_rial::text, max_order_rial::text, fee_percent::text,
        badge_text, terms, brand_color, logo_url, position, active FROM installment_providers WHERE ($1::boolean = false OR active) ORDER BY position, code`, [activeOnly]);
    return rows.rows as InstallmentProvider[];
  } catch { return []; } // table missing on very old databases → no offers rather than a 500
}

/** Server-side instalment maths (Req 191): ceil((base × (1 + fee)) / count), in integer rial. */
export function installmentOffers(base: bigint, enabled: boolean, allowed: string[], providers: InstallmentProvider[]): InstallmentOffer[] {
  if (!enabled || base <= 0n) return [];
  return providers
    .filter((p) => p.active && (!allowed.length || allowed.includes(p.code)))
    .filter((p) => base >= BigInt(p.min_order_rial) && (p.max_order_rial === null || base <= BigInt(p.max_order_rial)))
    .map((p) => {
      const feeBasis = BigInt(Math.round(Number(p.fee_percent) * 100)); // basis points
      const total = (base * (10_000n + feeBasis) + 9_999n) / 10_000n;
      const count = BigInt(p.installments_count);
      return { provider: p.code, title: p.title, count: p.installments_count, perInstallmentRial: ((total + count - 1n) / count).toString(),
        totalRial: total.toString(), badge: p.badge_text, terms: p.terms, color: p.brand_color };
    });
}

const providerBody = z.object({
  title: z.string().trim().min(2).max(60), installmentsCount: z.number().int().min(2).max(24),
  minOrderRial: z.string().regex(/^\d{1,15}$/), maxOrderRial: z.string().regex(/^\d{1,15}$/).nullable(),
  feePercent: z.number().min(0).max(30), badgeText: z.string().trim().max(80).refine((v) => !/<[a-z!/]/i.test(v), 'HTML مجاز نیست.'),
  terms: z.string().trim().max(400).refine((v) => !/<[a-z!/]/i.test(v), 'HTML مجاز نیست.'),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/), logoUrl: z.string().regex(/^(https:\/\/[^\s<>"]+|\/api\/v1\/media\/[0-9a-f-]{36})$/).nullable(),
  position: z.number().int().min(0).max(100), active: z.boolean(), integrationCode: z.string().regex(/^[a-z0-9_-]{2,40}$/).nullable(),
}).strict();

export function registerInstallmentRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/installment-providers', async () => ({
    items: (await installmentProviders(pool)).map((p) => ({ code: p.code, title: p.title, count: p.installments_count, minOrderRial: p.min_order_rial,
      maxOrderRial: p.max_order_rial, badge: p.badge_text, terms: p.terms, color: p.brand_color, logoUrl: p.logo_url })),
  }));

  app.get('/api/v1/admin/installment-providers', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'installments:manage');
    const providers = await installmentProviders(pool, false);
    const integrations = (await pool.query(`SELECT code, title, enabled, status FROM integrations WHERE category = 'payment' ORDER BY code`).catch(() => ({ rows: [] }))).rows;
    return { items: providers, integrations };
  });

  app.put('/api/v1/admin/installment-providers/:code', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'installments:manage');
    const { code } = z.object({ code: z.string().regex(/^[a-z0-9-]{2,30}$/) }).parse(request.params);
    const body = providerBody.parse(request.body);
    if (body.maxOrderRial !== null && BigInt(body.maxOrderRial) <= BigInt(body.minOrderRial)) throw badRequest('سقف مبلغ باید بیشتر از حداقل باشد.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM installment_providers WHERE code = $1 FOR UPDATE', [code]);
      await client.query(`INSERT INTO installment_providers(code,title,integration_code,installments_count,min_order_rial,max_order_rial,fee_percent,badge_text,terms,brand_color,logo_url,position,active,updated_by,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
        ON CONFLICT (code) DO UPDATE SET title = $2, integration_code = $3, installments_count = $4, min_order_rial = $5, max_order_rial = $6, fee_percent = $7,
          badge_text = $8, terms = $9, brand_color = $10, logo_url = $11, position = $12, active = $13, updated_by = $14, updated_at = now()`,
        [code, body.title, body.integrationCode, body.installmentsCount, body.minOrderRial, body.maxOrderRial, body.feePercent, body.badgeText, body.terms,
          body.brandColor, body.logoUrl, body.position, body.active, user.id]);
      await audit(client, user.id, before ? 'installment_provider.updated' : 'installment_provider.created', 'installment_provider', code, before ?? undefined, body, request.ip);
      await outbox(client, 'pricing.installment_policy.changed', 'installment_provider', randomUUID(), { code, installmentsCount: body.installmentsCount, active: body.active });
      const row = await one(client, 'SELECT * FROM installment_providers WHERE code = $1', [code]);
      if (!row) throw notFound();
      return row;
    });
  });
}
