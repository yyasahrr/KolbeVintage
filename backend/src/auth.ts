import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from './errors.js';
import { audit } from './operations.js';
import { recordLoginAttempt, touchSession, verifyTotp } from './profile.js';
import { emitEvent } from './events.js';
import { ensureContact, recordTimeline } from './crm-intelligence.js';
import { decryptSecret } from './secrets.js';

const registration = z.object({
  email: z.email().max(254).optional(),
  phone: z.string().regex(/^09\d{9}$/).optional(),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(120),
}).refine((value) => !!value.email || !!value.phone, 'ایمیل یا شماره همراه لازم است.');
const loginBody = z.object({ identity: z.string().trim().min(5).max(254), password: z.string(),
  // 6 digits for TOTP/SMS, 10 hex characters for a saved recovery code.
  code: z.string().trim().regex(/^([0-9]{6}|[A-Fa-f0-9]{10})$/).optional() });
type UserRow = { id: string; email: string | null; phone: string | null; display_name: string; password_hash: string; status: string; token_version: number; must_reset_password: boolean };
export type Principal = { id: string; displayName: string; roles: string[]; permissions: string[]; sessionId: string };

const secret = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = (config: Config) => ({ path: '/api/v1/auth', httpOnly: true, secure: config.COOKIE_SECURE === 'true' || config.NODE_ENV === 'production', sameSite: 'strict' as const, maxAge: 30 * 24 * 60 * 60 });

async function accessToken(user: UserRow, sessionId: string, config: Config) {
  return new SignJWT({ ver: user.token_version, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('kolbe-api')
    .setAudience('kolbe-clients').setIssuedAt().setExpirationTime('15m').sign(secret(config));
}

/** Human-readable device label for the security page (Req 351) — derived, never trusted for auth. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const os = /Android/i.test(ua) ? 'اندروید' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'ویندوز' : /Mac OS/i.test(ua) ? 'مک' : /Linux/i.test(ua) ? 'لینوکس' : 'دستگاه نامشخص';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'مرورگر';
  return `${browser} روی ${os}`;
}

type ClientInfo = { ip?: string; userAgent?: string; method?: string };

async function createSession(pool: DbPool, user: UserRow, config: Config, info: ClientInfo = {}) {
  const sessionId = randomUUID();
  const refreshToken = randomBytes(48).toString('base64url');
  const ua = info.userAgent?.slice(0, 300) ?? null;
  await pool.query(`INSERT INTO sessions(id, user_id, refresh_hash, expires_at, user_agent, ip_address, device_label)
    VALUES ($1, $2, $3, now() + interval '30 days', $4, $5, $6)`, [sessionId, user.id, tokenHash(refreshToken), ua, info.ip ?? null, deviceLabel(ua ?? undefined)]);
  await pool.query(`INSERT INTO login_history(id, user_id, session_id, ip_address, user_agent, device_label, method, succeeded) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
    [randomUUID(), user.id, sessionId, info.ip ?? null, ua, deviceLabel(ua ?? undefined), info.method ?? 'password']);

  return { accessToken: await accessToken(user, sessionId, config), refreshToken };
}

const otpHash = (code: string) => createHash('sha256').update(`2fa:${code}`).digest('hex');
const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));

/** Issue an SMS OTP challenge and queue the message through the SMS panel. */
async function issueSmsChallenge(pool: DbPool, input: { userId: string; identity: string; ip?: string }) {
  const code = sixDigits();
  const challengeId = randomUUID();
  const result = await transaction(pool, async (client) => {
    const row = await one<{ phone: string | null }>(client, 'SELECT phone FROM users WHERE id = $1', [input.userId]);
    // Earlier unconsumed challenges die with the new one so only one code is ever valid.
    await client.query('UPDATE two_factor_challenges SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [input.userId]);
    await client.query(
      `INSERT INTO two_factor_challenges(id,user_id,purpose,method,code_hash,phone,expires_at,ip)
       VALUES ($1,$2,'login','otp_sms',$3,$4, now() + interval '5 minutes',$5)`,
      [challengeId, input.userId, otpHash(code), row?.phone ?? null, input.ip ?? null]);
    const emitted = await emitEvent(client, { eventType: 'customer.2fa_challenge', entityType: 'user', entityId: input.userId,
      payload: { challengeId, purpose: 'login' }, actorId: input.userId, source: 'auth' });
    let deliveryHint = 'sms_queued';
    if (row?.phone && /^09\d{9}$/.test(row.phone)) {
      await client.query(
        `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,'transactional')`,
        [randomUUID(), emitted.eventId, input.userId, row.phone, `کد ورود دومرحله‌ای کلبه وینتیج: ${code}`]);
    } else {
      deliveryHint = 'no_phone_on_file';
    }
    return { phone: row?.phone ?? null, deliveryHint };
  });
  return {
    challengeId, deliveryHint: result.deliveryHint,
    phoneMasked: result.phone ? `${result.phone.slice(0, 4)}***${result.phone.slice(-2)}` : 'ثبت‌شده',
  };
}

/** Constant-time-ish compare of a submitted OTP against the active challenge. */
async function verifySmsChallenge(pool: DbPool, userId: string, code: string) {
  return transaction(pool, async (client) => {
    const challenge = await one<{ id: string; code_hash: string; attempts: number; max_attempts: number }>(client,
      `SELECT id,code_hash,attempts,max_attempts FROM two_factor_challenges
       WHERE user_id = $1 AND purpose = 'login' AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId]);
    if (!challenge) return false;
    if (challenge.attempts >= challenge.max_attempts) return false;
    if (challenge.code_hash !== otpHash(code)) {
      await client.query('UPDATE two_factor_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
      return false;
    }
    await client.query('UPDATE two_factor_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
    return true;
  });
}

/** One-time recovery code: matches the stored hash and is removed on use. */
async function consumeRecoveryCode(pool: DbPool, userId: string, code: string) {
  if (!/^[A-Fa-f0-9]{10}$/.test(code)) return false;
  return transaction(pool, async (client) => {
    const row = await one<{ recovery_codes: string[] }>(client,
      'SELECT recovery_codes FROM user_two_factor WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!row) return false;
    const hash = createHash('sha256').update(code.toUpperCase()).digest('hex');
    const remaining = (row.recovery_codes ?? []).filter((saved) => saved !== hash);
    if (remaining.length === row.recovery_codes.length) return false;
    await client.query('UPDATE user_two_factor SET recovery_codes = $2, updated_at = now() WHERE user_id = $1',
      [userId, JSON.stringify(remaining)]);
    return true;
  });
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
        // Requirement 143: marketing SMS is opt-in, so a new account starts with a
        // consent row that says "no" instead of relying on a missing row.
        await client.query(
          `INSERT INTO customer_consents(user_id,marketing_sms,transactional_sms,email_marketing,source)
           VALUES ($1,false,true,false,'registration') ON CONFLICT (user_id) DO NOTHING`, [id]);
        // Requirement 23: customer.created is part of the automation event catalog.
        await emitEvent(client, { eventType: 'customer.created', entityType: 'user', entityId: id,
          payload: { userId: id, displayName: body.displayName, hasEmail: Boolean(email), hasPhone: Boolean(body.phone) },
          actorId: id, source: 'auth' });
        await recordTimeline(client, { userId: id, eventType: 'customer.created', source: 'auth',
          title: 'حساب کاربری ساخته شد', actorId: id, refType: 'user', refId: id });
        await ensureContact(client, id, 'customer');
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
    if (!user || user.status !== 'active') {
      await recordLoginAttempt(pool, { userId: null, identity: body.identity, success: false,
        reason: !user ? 'unknown_identity' : 'inactive_account', ip: request.ip, userAgent: request.headers['user-agent'] });
      throw unauthorized();
    }
    // Item 45: migrated accounts hold a random unknown password, so ANY password
    // attempt must surface "set a new password" instead of a dead-end 401.
    if (user.must_reset_password) throw new ApiError(403, 'PASSWORD_RESET_REQUIRED', 'برای فعال‌سازی حساب باید گذرواژه جدید تعیین کنید.');
    const valid = await argon2.verify(user.password_hash, body.password);
    if (!valid) {
      await pool.query(`INSERT INTO login_history(id, user_id, ip_address, user_agent, device_label, method, succeeded) VALUES ($1,$2,$3,$4,$5,'password',false)`,
        [randomUUID(), user.id, request.ip, request.headers['user-agent']?.slice(0, 300) ?? null, deviceLabel(request.headers['user-agent'])]);
      await recordLoginAttempt(pool, { userId: user.id, identity: body.identity, success: false, reason: 'bad_password',
        ip: request.ip, userAgent: request.headers['user-agent'] });
      throw unauthorized();
    }
    let session: Awaited<ReturnType<typeof createSession>>;
    // Agent D1: second factor (item 104) via user_two_factor (inline code or SMS challenge).
    const factor = await one<{ enabled: boolean; method: string | null; secret_ciphertext: Buffer | null; secret_iv: Buffer | null; secret_tag: Buffer | null }>(pool,
      'SELECT enabled,method,secret_ciphertext,secret_iv,secret_tag FROM user_two_factor WHERE user_id = $1', [user.id]);
    if (factor?.enabled) {
      const smsChallenge = factor.method === 'otp_sms';
      if (!body.code) {
        await recordLoginAttempt(pool, { userId: user.id, identity: body.identity, success: false, reason: 'two_factor_required',
          ip: request.ip, userAgent: request.headers['user-agent'] });
        if (!smsChallenge) throw new ApiError(401, 'TWO_FACTOR_REQUIRED', 'کد ورود دومرحله‌ای لازم است.');
        // SMS OTP is issued server-side and stored hashed; the browser never sees it.
        const challenge = await issueSmsChallenge(pool, { userId: user.id, identity: body.identity, ip: request.ip });
        const error = new ApiError(401, 'TWO_FACTOR_REQUIRED', `کد ورود دومرحله‌ای به شماره ${challenge.phoneMasked} پیامک شد.`);
        Object.assign(error, { challenge: { challengeId: challenge.challengeId, method: 'otp_sms', expiresInSeconds: 300, deliveryHint: challenge.deliveryHint } });
        throw error;
      }
      let secretOk = false;
      let usedRecovery = false;
      if (factor.method === 'authenticator' && factor.secret_ciphertext && factor.secret_iv && factor.secret_tag) {
        secretOk = verifyTotp(decryptSecret(config, { ciphertext: factor.secret_ciphertext, iv: factor.secret_iv, tag: factor.secret_tag }), body.code);
      } else if (smsChallenge) {
        secretOk = await verifySmsChallenge(pool, user.id, body.code);
      }
      if (!secretOk) {
        // Recovery codes are the documented fallback when the phone is lost (item 104).
        usedRecovery = await consumeRecoveryCode(pool, user.id, body.code);
      }
      if (!secretOk && !usedRecovery) {
        await recordLoginAttempt(pool, { userId: user.id, identity: body.identity, success: false, reason: 'bad_two_factor_code',
          ip: request.ip, userAgent: request.headers['user-agent'] });
        throw new ApiError(401, 'TWO_FACTOR_INVALID', 'کد ورود دومرحله‌ای نادرست است.');
      }
      if (usedRecovery) {
        await recordLoginAttempt(pool, { userId: user.id, identity: body.identity, success: false, reason: 'two_factor_recovery_used',
          ip: request.ip, userAgent: request.headers['user-agent'] });
      }
      session = await createSession(pool, user, config, { ip: request.ip, userAgent: request.headers['user-agent'],
        method: usedRecovery ? 'password+recovery' : smsChallenge ? 'password+sms_otp' : 'password+totp' });
      await recordLoginAttempt(pool, { userId: user.id, identity: body.identity, success: true, ip: request.ip,
        userAgent: request.headers['user-agent'] });
    } else {
      // Legacy two-step login (Req 104, 351): users.two_factor_enabled issues an
      // SMS challenge that is answered at POST /api/v1/auth/login/2fa.
      const twoFactor = await one<{ two_factor_enabled: boolean }>(pool, 'SELECT two_factor_enabled FROM users WHERE id = $1', [user.id]);
      if (twoFactor?.two_factor_enabled && user.phone) {
        const challengeId = randomUUID();
        const code = String(randomInt(100000, 999999));
        await transaction(pool, async (client) => {
          await client.query(`UPDATE contact_change_requests SET status = 'cancelled' WHERE user_id = $1 AND channel = '2fa' AND status = 'pending'`, [user.id]);
          await client.query(`INSERT INTO contact_change_requests(id,user_id,channel,new_value,otp_code_hash,expires_at) VALUES ($1,$2,'2fa','-',$3, now() + interval '5 minutes')`,
            [challengeId, user.id, tokenHash(`${challengeId}:${code}:${config.JWT_SECRET}`)]);
          const eventId = randomUUID();
          await client.query(`INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,'auth.2fa_challenge','user',$2,$3)`,
            [eventId, user.id, JSON.stringify({ challengeId })]);
          await client.query('INSERT INTO sms_deliveries(id,event_id,user_id,phone,message) VALUES ($1,$2,$3,$4,$5)',
            [randomUUID(), eventId, user.id, user.phone, `کلبه وینتیج — کد ورود دومرحله‌ای: ${code}`]);
        });
        return { twoFactorRequired: true, challengeId, devCode: config.NODE_ENV === 'production' ? undefined : code };
      }
      session = await createSession(pool, user, config, { ip: request.ip, userAgent: request.headers['user-agent'], method: 'password' });
      await recordLoginAttempt(pool, { userId: user.id, identity: body.identity, success: true, ip: request.ip,
        userAgent: request.headers['user-agent'] });
    }
    reply.setCookie('kolbe_refresh', session.refreshToken, cookieOptions(config));
    return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: 900 };
  });

  app.post('/api/v1/auth/login/2fa', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const row = await one<{ user_id: string; status: string; expires_at: string; attempts: number; otp_code_hash: string }>(client,
        `SELECT * FROM contact_change_requests WHERE id = $1 AND channel = '2fa' FOR UPDATE`, [body.challengeId]);
      if (!row || row.status !== 'pending' || new Date(row.expires_at) < new Date() || row.attempts >= 5) return null;
      if (tokenHash(`${body.challengeId}:${body.code}:${config.JWT_SECRET}`) !== row.otp_code_hash) {
        await client.query('UPDATE contact_change_requests SET attempts = attempts + 1 WHERE id = $1', [body.challengeId]);
        return null;
      }
      await client.query(`UPDATE contact_change_requests SET status = 'verified', verified_at = now() WHERE id = $1`, [body.challengeId]);
      return one<UserRow>(client, 'SELECT * FROM users WHERE id = $1', [row.user_id]);
    });
    if (!result || result.status !== 'active') throw unauthorized();
    const session = await createSession(pool, result, config, { ip: request.ip, userAgent: request.headers['user-agent'], method: 'password+sms_otp' });
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
      await client.query('UPDATE sessions SET refresh_hash = $1, last_active_at = now() WHERE id = $2', [tokenHash(replacement), row.session_id]);
      await touchSession(client, row.session_id, request.ip, request.headers['user-agent']);
      return row;
    });
    reply.setCookie('kolbe_refresh', replacement, cookieOptions(config));
    return { accessToken: await accessToken(user, user.session_id, config), tokenType: 'Bearer', expiresIn: 900 };
  });

  // Item 45: one-time password activation for imported/migrated users.
  // The token is shown to the admin exactly once (import report or admin panel);
  // only its SHA-256 hash is stored.
  app.post('/api/v1/admin/users/:id/reset-token', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'users:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ ttlHours: z.number().int().min(1).max(24 * 30).default(72) }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const target = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [id]);
      if (!target) throw notFound();
      const token = randomBytes(32).toString('base64url');
      const tokenId = randomUUID();
      const expiresAt = new Date(Date.now() + body.ttlHours * 3600_000).toISOString();
      await client.query(
        `INSERT INTO password_reset_tokens(id, user_id, token_hash, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5)`, [tokenId, id, tokenHash(token), expiresAt, user.id]);
      await client.query('UPDATE users SET must_reset_password = true, updated_at = now() WHERE id = $1', [id]);
      await audit(client, user.id, 'auth.reset_token_issued', 'user', id, undefined, { tokenId, expiresAt }, request.ip);
      return { userId: id, token, expiresAt };
    });
  });

  app.post('/api/v1/auth/set-password', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request) => {
    const body = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(12).max(128) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const row = await one<{ id: string; user_id: string; expires_at: string }>(client,
        `SELECT id, user_id, expires_at FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [tokenHash(body.token)]);
      if (!row) throw badRequest('توکن معتبر نیست یا منقضی شده است.');
      const passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
      await client.query('UPDATE users SET password_hash = $2, must_reset_password = false, token_version = token_version + 1, updated_at = now() WHERE id = $1',
        [row.user_id, passwordHash]);
      await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await audit(client, row.user_id, 'auth.password_set', 'user', row.user_id, undefined, undefined, request.ip);
      return { userId: row.user_id, activated: true };
    });
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
