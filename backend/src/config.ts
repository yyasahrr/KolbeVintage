import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  JWT_SECRET: z.string().min(32),
  PUBLIC_ORIGIN: z.url(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  API_PUBLIC_URL: z.url().optional(),
  ZIBAL_MERCHANT: z.string().min(2).optional(),
  NEXTPAY_API_KEY: z.string().min(10).optional(),
  MELIPAYAMAK_USERNAME: z.string().min(1).optional(),
  MELIPAYAMAK_PASSWORD: z.string().min(1).optional(),
  MELIPAYAMAK_SENDER: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => schema.parse(process.env);
