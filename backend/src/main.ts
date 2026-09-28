import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { ZibalAdapter } from './zibal.js';
import { NextPayAdapter } from './nextpay.js';
import { createPool } from './db.js';

const config = loadConfig();
if ((config.ZIBAL_MERCHANT || config.NEXTPAY_API_KEY) && !config.API_PUBLIC_URL)
  throw new Error('API_PUBLIC_URL is required for payment callbacks.');
const providerPool = createPool(config);
const adapters = {
  ...(config.ZIBAL_MERCHANT ? { zibal: new ZibalAdapter(config.ZIBAL_MERCHANT) } : {}),
  ...(config.NEXTPAY_API_KEY ? { nextpay: new NextPayAdapter(config.NEXTPAY_API_KEY, providerPool) } : {}),
};
const app = await buildApp(config, adapters);
const shutdown = async () => { await app.close(); await providerPool.end(); process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
