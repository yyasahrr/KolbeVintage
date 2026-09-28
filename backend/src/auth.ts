import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { badRequest, conflict, forbidden, unauthorized } from './errors.js';
import { audit } from './operations.js';

const registration = z.object({
  email: z.email().max(254).optional(),
  phone: z.string().regex(/^09\d{9}$/).optional(),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(120),
}).refine((value) => !!value.email || !!value.phone, 'ایمیل یا شماره همراه لازم است.');
const loginBody = z.object({ identity: z.string().trim().min(5).max(254), password: z.string() });
type UserRow = { id: string; email: string | null; phone: string | null; display_name: string; password_hash: string; status: string; token_version: number };
export type Principal = { id: string; displayName: string; roles: string[]; permissions: string[]; sessionId: string };

const secret = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = (config: Config) => ({ path: '/api/v1/auth', httpOnly: true, secure: config.COOKIE_SECURE === 'true' || config.NODE_ENV === 'production', sameSite: 'strict' as const, maxAge: 30 * 24 * 60 * 60 });

async function accessToken(user: UserRow, sessionId: string, config: Config) {
  return new SignJWT({ ver: user.token_version, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('kolbe-api')
    .setAudience('kolbe-clients').setIssuedAt().setExpirationTime('15m').sign(secret(config));
}

async function createSession(pool: DbPool, user: UserRow, config: Config) {
  const sessionId = randomUUID();
  const refreshToken = randomBytes(48).toString('base64url');
  await pool.query('INSERT INTO sessions(id, user_id, refresh_hash, expires_at) VALUES ($1, $2, $3, now() + interval \'30 days\')', [sessionId, user.id, tokenHash(refreshToken)]);
  return { accessToken: await accessToken(user, sessionId, config), refreshToken };
}

export async function principal(request: FastifyRequest, pool: DbPool, config: Config): Promise<Principal> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  let subject: string, sessionId: string, version: number;
  try {
    const verified = await jwtVerify(header.slice(7), secret(config), { issuer: 'kolbe-api', audience: 'kolbe-clients' });
    subject = verified.payload.sub ?? '';
    sessionId = String(verified.payload.sid ?? '');
    version = Number(verified.payload.ver);
  } catch { throw unauthorized(); }
  const row = await one<UserRow & { session_active: boolean }>(pool,
    `SELECT u.*, (s.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > now()) AS session_active
     FROM users u LEFT JOIN sessions s ON s.id = $2 AND s.user_id = u.id WHERE u.id = $1`, [subject, sessionId]);
  if (!row || !row.session_active || row.status !== 'active' || row.token_version !== version) throw unauthorized();
  const access = await pool.query<{ role_code: string; permission_code: string | null }>(
    `SELECT ur.role_code, rp.permission_code FROM user_roles ur
     LEFT JOIN role_permissions rp ON rp.role_code = ur.role_code WHERE ur.user_id = $1`, [row.id]);
  const planPermissions = await pool.query<{ permission_code: string }>(
    `SELECT unnest(p.permissions) AS permission_code FROM memberships m
     JOIN membership_plans p ON p.id = m.plan_id
     WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()`, [row.id]);
  return {
    id: row.id, displayName: row.display_name, sessionId,
    roles: [...new Set(access.rows.map((item) => item.role_code))],
    permissions: [...new Set([...access.rows.map((item) => item.permission_code),
      ...planPermissions.rows.map((item) => item.permission_code)].filter((code): code is string => !!code))],
  };
}

export function requirePermission(user: Principal, permission: string) {
  if (!user.permissions.includes(permission)) throw forbidden();
}

export function registerAuthRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.post('/api/v1/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = registration.parse(request.body);
    const email = body.email?.toLowerCase() ?? null;
    const id = randomUUID();
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO users(id, email, phone, password_hash, display_name) VALUES ($1,$2,$3,$4,$5)', [id, email, body.phone ?? null, passwordHash, body.displayName]);
        await client.query('INSERT INTO user_roles(user_id, role_code) VALUES ($1,$2)', [id, 'customer']);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('این ایمیل یا شماره همراه قبلاً ثبت شده است.');
      throw error;
    }
    return reply.code(201).send({ id, displayName: body.displayName });
  });

  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const user = await one<UserRow>(pool,
      'SELECT * FROM users WHERE email = $1 OR phone = $1', [body.identity.toLowerCase()]);
    const valid = user ? await argon2.verify(user.password_hash, body.password) : false;
    if (!valid || user?.status !== 'active') throw unauthorized();
    const session = await createSession(pool, user, config);
    reply.setCookie('kolbe_refresh', session.refreshToken, cookieOptions(config));
    return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: 900 };
  });

  app.post('/api/v1/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const current = request.cookies.kolbe_refresh;
    if (!current) throw unauthorized();
    const replacement = randomBytes(48).toString('base64url');
    const user = await transaction(pool, async (client) => {
      const row = await one<UserRow & { session_id: string }>(client,
        `SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active' FOR UPDATE OF s`, [tokenHash(current)]);
      if (!row) throw unauthorized();
      await client.query('UPDATE sessions SET refresh_hash = $1 WHERE id = $2', [tokenHash(replacement), row.session_id]);
      return row;
    });
    reply.setCookie('kolbe_refresh', replacement, cookieOptions(config));
    return { accessToken: await accessToken(user, user.session_id, config), tokenType: 'Bearer', expiresIn: 900 };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const current = request.cookies.kolbe_refresh;
    if (current) await pool.query('UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1', [tokenHash(current)]);
    reply.clearCookie('kolbe_refresh', { path: '/api/v1/auth' });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (request) => {
    const user = await principal(request, pool, config);
    const row = await one<{ id: string; display_name: string; email: string | null; phone: string | null; birthday: string | null; preferences: Record<string, boolean> | null }>(
      pool, 'SELECT id, display_name, email, phone, birthday, preferences FROM users WHERE id = $1', [user.id]);
    return { id: user.id, displayName: row?.display_name ?? user.displayName, email: row?.email ?? null, phone: row?.phone ?? null,
      birthday: row?.birthday ?? null, preferences: row?.preferences ?? {}, roles: user.roles, permissions: user.permissions };
  });

  /** Notification preferences (allowlisted keys) — the account UI persists switches here. */
  const PREFERENCE_KEYS = ['orderUpdates', 'offers', 'sms', 'email'] as const;
  app.patch('/api/v1/auth/me/preferences', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.record(z.string().max(40), z.boolean()).parse(request.body);
    const entries = Object.entries(body).filter(([key]) => (PREFERENCE_KEYS as readonly string[]).includes(key));
    if (!entries.length) throw badRequest('کلید تنظیمات اعلان معتبر نیست.');
    const patch = Object.fromEntries(entries);
    return transaction(pool, async (client) => {
      const updated = await one<{ preferences: Record<string, boolean> }>(client,
        'UPDATE users SET preferences = preferences || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING preferences',
        [user.id, JSON.stringify(patch)]);
      await audit(client, user.id, 'user.preferences_updated', 'user', user.id, undefined, patch, request.ip);
      return { preferences: updated?.preferences ?? patch };
    });
  });

  app.patch('/api/v1/auth/me', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({
      displayName: z.string().trim().min(2).max(120).optional(),
      email: z.string().email().max(254).optional().nullable(),
      birthday: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/).optional().nullable(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT display_name, email, birthday FROM users WHERE id = $1', [user.id]);
      if (!before) throw unauthorized();
      const updates: string[] = [];
      const vals: unknown[] = [user.id];
      if (body.displayName !== undefined) { vals.push(body.displayName.trim()); updates.push(`display_name = $${vals.length}`); }
      if (body.email !== undefined) { vals.push(body.email ? body.email.toLowerCase() : null); updates.push(`email = $${vals.length}`); }
      if (body.birthday !== undefined) {
        let dbDate: string | null = null;
        if (body.birthday) {
          const [y,m,d] = body.birthday.split('/').map(Number);
          dbDate = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
        vals.push(dbDate);
        updates.push(`birthday = $${vals.length}::date`);
      }
      if (!updates.length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
      await client.query(`UPDATE users SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`, vals);
      const row = await one<{ id: string; display_name: string; email: string | null; phone: string | null; birthday: string | null }>(client, 'SELECT id, display_name, email, phone, birthday FROM users WHERE id = $1', [user.id]);
      if (!row) throw unauthorized();
      await audit(client, user.id, 'profile.updated', 'user', user.id, before, row, request.ip);
      return { id: user.id, displayName: row.display_name, email: row.email, phone: row.phone, birthday: row.birthday ? new Date(row.birthday).toLocaleDateString('fa-IR') : null };
    });
  });
}
