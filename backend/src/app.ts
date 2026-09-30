import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import multipart from '@fastify/multipart';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createPool } from './db.js';
import { ApiError } from './errors.js';
import { registerAuthRoutes } from './auth.js';
import { registerCatalogRoutes } from './catalog.js';
import { registerInventoryRoutes } from './inventory.js';
import { registerOrderRoutes } from './orders.js';
import { registerPaymentRoutes, type PaymentProviderAdapter } from './payments.js';
import { registerInvoiceRoutes } from './invoices.js';
import { registerInvoiceDocumentRoutes } from './invoice-docs.js';
import { registerFinanceRoutes } from './finance.js';
import { registerWalletRoutes } from './wallet.js';
import { registerSupplierRoutes } from './suppliers.js';
import { registerSupplier360Routes } from './supplier360.js';
import { registerMarketplaceRoutes } from './marketplace.js';
import { registerPromoRoutes } from './promo.js';
import { registerCrmRoutes } from './crm.js';
import { registerIntegrationRoutes } from './integrations.js';
import { registerCmsRoutes } from './cms.js';
import { registerAccessRoutes } from './access.js';
import { registerTicketRoutes } from './tickets.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerWishlistRoutes } from './wishlist.js';
import { registerAddressRoutes } from './addresses.js';
import { registerSupplierReportRoutes } from './supplier-report.js';
import { registerAdminRoutes } from './admin.js';
import { registerShippingRoutes } from './shipping.js';
import { registerFileRoutes } from './files.js';
import { registerConsoleRoutes } from './console.js';
import { registerCmsStudioRoutes } from './cms-studio.js';
import { registerStyleRoutes } from './style.js';
import { registerProfileRoutes } from './profile.js';
import { registerSeoRoutes } from './seo.js';
import { registerInstallmentRoutes } from './installments.js';
import { registerRecommendationRoutes } from './recommendations.js';
import { registerMediaPipelineRoutes } from './media-pipeline.js';
import { registerProductTypeRoutes } from './product-types.js';
import { registerSpecRoutes } from './specs.js';
import { registerImportRoutes } from './imports.js';
import { registerMembershipLifecycleRoutes } from './membership.js';
import { registerBuyerRoutes } from './buyer360.js';
import { registerCrmIntelligenceRoutes } from './crm-intelligence.js';
import { registerAutomationRoutes } from './automation.js';
import { registerTrackingRoutes } from './tracking.js';
import { registerReviewRoutes } from './reviews.js';
import { registerVideoRoutes } from './video.js';
import { registerPromoSafetyRoutes } from './promo-safety.js';
import { registerCartRoutes } from './cart.js';

export async function buildApp(config: Config, paymentAdapters: Record<string, PaymentProviderAdapter> = {}) {
  const app = Fastify({ logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'] },
    bodyLimit: 1024 * 1024, trustProxy: false, requestTimeout: 30_000 });
  const pool = createPool(config);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true }) : null;
  if (config.NODE_ENV === 'production' && !redis) throw new Error('REDIS_URL is required in production.');
  if (redis) await redis.connect();
  await app.register(cookie);
  await app.register(cors, { origin: config.PUBLIC_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'] });
  await app.register(rateLimit, { global: false, redis: redis ?? undefined, skipOnError: false });
  await app.register(rawBody, { global: false, encoding: false, runFirst: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
if (process.env.DEBUG_ERRORS === '1') app.log.error(error);
      // Extra, non-secret context (e.g. the 2FA challenge descriptor) rides along.
      const { challenge, details } = error as ApiError & { challenge?: unknown; details?: unknown };
      return reply.code(error.statusCode).send({ code: error.code, message: error.message, ...(challenge ? { challenge } : {}), ...(details ? { details } : {}) });
    }
    if (error instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'داده‌های درخواست معتبر نیست.', issues: error.issues });
    // Framework-level client errors (empty JSON body, unsupported media type, …) stay 4xx instead of becoming 500.
    const frameworkError = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = frameworkError.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ code: frameworkError.code ?? 'BAD_REQUEST', message: frameworkError.message ?? 'درخواست نامعتبر است.' });
    }
    if ((error as { code?: string }).code === '23505') { app.log.error(error as Error); return reply.code(409).send({ code: 'CONFLICT', message: 'رکورد تکراری است.' }); }
    app.log.error(error);
    if (process.env.DEBUG_ERRORS === '1') console.error('RAW ERROR', error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'خطای داخلی رخ داد.' });
  });

  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => {
    await pool.query('SELECT 1');
    if (redis) await redis.ping();
    return { ok: true };
  });
  registerAuthRoutes(app, pool, config);
  registerCatalogRoutes(app, pool, config);
  registerInventoryRoutes(app, pool, config);
  registerOrderRoutes(app, pool, config, new Set(Object.keys(paymentAdapters)));
  registerPaymentRoutes(app, pool, config, paymentAdapters);
  registerInvoiceRoutes(app, pool, config);
  registerInvoiceDocumentRoutes(app, pool, config);
  registerFinanceRoutes(app, pool, config);
  registerWalletRoutes(app, pool, config);
  registerSupplierRoutes(app, pool, config);
  registerSupplier360Routes(app, pool, config);
  registerMarketplaceRoutes(app, pool, config);
  registerPromoRoutes(app, pool, config);
  registerCrmRoutes(app, pool, config);
  registerIntegrationRoutes(app, pool, config);
  registerCmsRoutes(app, pool, config);
  registerAccessRoutes(app, pool, config);
  registerTicketRoutes(app, pool, config);
  registerNotificationRoutes(app, pool, config);
  registerWishlistRoutes(app, pool, config);
  registerAddressRoutes(app, pool, config);
  registerSupplierReportRoutes(app, pool, config);
  registerAdminRoutes(app, pool, config);
  registerShippingRoutes(app, pool, config);
  registerFileRoutes(app, pool, config);
  registerConsoleRoutes(app, pool, config);
  registerCmsStudioRoutes(app, pool, config);
  registerStyleRoutes(app, pool, config);
  registerProfileRoutes(app, pool, config);
  registerSeoRoutes(app, pool, config);
  registerInstallmentRoutes(app, pool, config);
  registerRecommendationRoutes(app, pool, config);
  registerMediaPipelineRoutes(app, pool, config);
  registerProductTypeRoutes(app, pool, config);
  registerSpecRoutes(app, pool, config);
  registerImportRoutes(app, pool, config);
  registerMembershipLifecycleRoutes(app, pool, config);
  registerBuyerRoutes(app, pool, config);
  registerCrmIntelligenceRoutes(app, pool, config);
  registerAutomationRoutes(app, pool, config);
  registerTrackingRoutes(app, pool, config);
  registerReviewRoutes(app, pool, config);
  registerVideoRoutes(app, pool, config);
  registerPromoSafetyRoutes(app, pool, config);
  registerCartRoutes(app, pool, config);
  app.addHook('onClose', async () => {
    if (redis) redis.disconnect();
    await pool.end();
  });
  return app;
}
