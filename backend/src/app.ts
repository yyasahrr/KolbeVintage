import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
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
import { registerWalletRoutes } from './wallet.js';
import { registerTicketRoutes } from './tickets.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerAdminRoutes } from './admin.js';

export async function buildApp(config: Config, paymentAdapters: Record<string, PaymentProviderAdapter> = {}) {
  const app = Fastify({ logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'] },
    bodyLimit: 1024 * 1024, trustProxy: false, requestTimeout: 30_000 });
  const pool = createPool(config);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true }) : null;
  if (config.NODE_ENV === 'production' && !redis) throw new Error('REDIS_URL is required in production.');
  if (redis) await redis.connect();
  await app.register(cookie);
  await app.register(cors, { origin: config.PUBLIC_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] });
  await app.register(rateLimit, { global: false, redis: redis ?? undefined, skipOnError: false });
  await app.register(rawBody, { global: false, encoding: false, runFirst: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'داده‌های درخواست معتبر نیست.', issues: error.issues });
    if ((error as { code?: string }).code === '23505') return reply.code(409).send({ code: 'CONFLICT', message: 'رکورد تکراری است.' });
    app.log.error(error);
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
  registerWalletRoutes(app, pool, config);
  registerTicketRoutes(app, pool, config);
  registerNotificationRoutes(app, pool, config);
  registerAdminRoutes(app, pool, config);
  app.addHook('onClose', async () => {
    if (redis) redis.disconnect();
    await pool.end();
  });
  return app;
}
