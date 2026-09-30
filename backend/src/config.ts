import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  JWT_SECRET: z.string().min(32),
  SECRETS_KEY: z.string().min(32).optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  PUBLIC_ORIGIN: z.url(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  API_PUBLIC_URL: z.url().optional(),
  ZIBAL_MERCHANT: z.string().min(2).optional(),
  NEXTPAY_API_KEY: z.string().min(10).optional(),
  MELIPAYAMAK_USERNAME: z.string().min(1).optional(),
  MELIPAYAMAK_PASSWORD: z.string().min(1).optional(),
  MELIPAYAMAK_SENDER: z.string().min(1).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_PUBLIC_BASE_URL: z.url().optional(),
}).refine((env) => {
  const storage = [env.S3_ENDPOINT, env.S3_REGION, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY, env.S3_PUBLIC_BASE_URL];
  return storage.every((value) => !value) || storage.every(Boolean);
}, { message: 'S3 storage configuration must be provided as a complete set.' });

export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => schema.parse(process.env);
