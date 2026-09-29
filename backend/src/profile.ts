import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, claimIdempotency, completeIdempotency, outbox as outboxEvent, requestHash } from './operations.js';
import { emitEvent } from './events.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { badRequest, conflict, notFound, unauthorized } from './errors.js';
import { recordTimeline } from './crm-intelligence.js';

/* Customer profile + account security (items 101-104).
   Sensitive identity changes (email/mobile) never apply with a plain PATCH:
   they go through an emailed link or an SMS OTP, and every admin correction is
   audited with old value, new value, actor and reason. */

const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');
const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));

/* ------------------------------- TOTP (RFC 6238) ------------------------------- */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = '';
  for (const byte of raw) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) secret += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)];
  return secret;
}

const base32Decode = (secret: string): Buffer => {
  const clean = secret.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw badRequest('کد Authenticator نامعتبر است.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

export function totpCode(secret: string, at = Date.now(), step = 30): string {
  const counter = Math.floor(at / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Accepts the current window and ±1 step for clock drift. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  return [-1, 0, 1].some((drift) => totpCode(secret, now + drift * 30_000) === code);
}

export const recordLoginAttempt = async (pool: DbPool, input: {
  userId: string | null; identity: string; success: boolean; reason?: string; ip?: string; userAgent?: string;
}) => {
  await pool.query(
    `INSERT INTO user_login_history(id,user_id,identity,success,reason,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), input.userId, input.identity.slice(0, 200), input.success, input.reason ?? null,
      input.ip ?? null, (input.userAgent ?? '').slice(0, 300)]);
};

export function registerProfileRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* --------------------------------- profile --------------------------------- */
  app.get('/api/v1/customer/profile', async (request) => {
    const user = await principal(request, pool, config);
    const profile = await one<Record<string, unknown>>(pool,
      `SELECT u.id,u.display_name,u.email,u.phone,u.birthday,u.status,u.created_at,
              cp.first_name,cp.last_name,cp.gender,cp.national_id,
              bp.business_name,bp.city,bp.vip_level,bp.credit_limit_rial
       FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id
       LEFT JOIN buyer_profiles bp ON bp.user_id = u.id WHERE u.id = $1`, [user.id]);
    const addresses = await pool.query('SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1', [user.id]);
    const twoFactor = await one<{ enabled: boolean; method: string | null }>(pool,
      'SELECT enabled,method FROM user_two_factor WHERE user_id = $1', [user.id]);
    const pending = await pool.query(
      `SELECT id,kind,new_value,channel,expires_at FROM customer_contact_changes
       WHERE user_id = $1 AND consumed_at IS NULL AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [user.id]);
    return {
      profile, addresses: addresses.rows[0]?.count ?? 0,
      security: { twoFactorEnabled: twoFactor?.enabled ?? false, twoFactorMethod: twoFactor?.method ?? null, pendingChanges: pending.rows },
    };
  });

  app.patch('/api/v1/customer/profile', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({
      displayName: z.string().trim().min(2).max(120).optional(),
      firstName: z.string().trim().max(80).nullable().optional(),
      lastName: z.string().trim().max(80).nullable().optional(),
      birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      gender: z.enum(['female', 'male', 'unspecified']).optional(),
      city: z.string().trim().max(80).nullable().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT id,display_name,birthday FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      if (!before) throw notFound();
      if (body.displayName) {
        await client.query('UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1', [user.id, body.displayName]);
        await recordTimeline(client, { userId: user.id, eventType: 'profile.updated', title: 'نام نمایشی تغییر کرد',
          description: `${String(before.display_name)} → ${body.displayName}`, actorId: user.id, source: 'account' });
      }
      if (body.birthday !== undefined) {
        await client.query('UPDATE users SET birthday = $2, updated_at = now() WHERE id = $1', [user.id, body.birthday]);
      }
      if (body.firstName !== undefined || body.lastName !== undefined || body.gender !== undefined) {
        await client.query(
          `INSERT INTO customer_profiles(user_id,first_name,last_name,gender) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id) DO UPDATE SET first_name = COALESCE($2, customer_profiles.first_name),
             last_name = COALESCE($3, customer_profiles.last_name), gender = COALESCE($4, customer_profiles.gender),
             updated_at = now()`,
          [user.id, body.firstName ?? null, body.lastName ?? null, body.gender ?? null]);
      }
      if (body.city !== undefined) {
        await client.query(
          `INSERT INTO buyer_profiles(user_id,city) VALUES ($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET city = COALESCE($2, buyer_profiles.city), updated_at = now()`,
          [user.id, body.city]);
      }
      await audit(client, user.id, 'customer.profile_updated', 'user', user.id, before, body, request.ip);
      await outboxEvent(client, 'customer.updated', 'user', user.id, { userId: user.id, fields: Object.keys(body) });
      await emitEvent(client, { eventType: 'customer.updated', entityType: 'user', entityId: user.id,
        payload: { userId: user.id, fields: Object.keys(body) }, actorId: user.id });
      return { updated: true };
    });
  });

  /* ------------------- email/mobile change with verification (103) ------------------- */
  app.post('/api/v1/customer/profile/contact-change', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({
      kind: z.enum(['email', 'phone']),
      newValue: z.string().trim().min(5).max(254),
      idempotencyKey: z.string().trim().min(8).max(120),
    }).strict().parse(request.body);
    const email = body.kind === 'email' ? body.newValue.toLowerCase() : null;
    if (body.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.newValue)) throw badRequest('ایمیل نامعتبر است.');
    if (body.kind === 'phone' && !/^09\d{9}$/.test(body.newValue)) throw badRequest('شماره همراه نامعتبر است.');
    const code = sixDigits();
    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, `profile.contact_change.${body.kind}`, body.idempotencyKey,
        requestHash({ kind: body.kind, newValue: body.newValue }));
      if (claim.previous) return claim.previous as Record<string, unknown>;
      const duplicate = body.kind === 'email'
        ? await one(client, 'SELECT id FROM users WHERE email = $1 AND id <> $2', [email, user.id])
        : await one(client, 'SELECT id FROM users WHERE phone = $1 AND id <> $2', [body.newValue, user.id]);
      if (duplicate) throw conflict('این مقدار برای حساب دیگری ثبت شده است.');
      await client.query(
        `UPDATE customer_contact_changes SET consumed_at = now() WHERE user_id = $1 AND kind = $2 AND consumed_at IS NULL`,
        [user.id, body.kind]);
      const requestId = randomUUID();
      const channel = body.kind === 'email' ? 'email_link' : 'sms_otp';
      await client.query(
        `INSERT INTO customer_contact_changes(id,user_id,kind,new_value,code_hash,channel,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + interval '15 minutes')`,
        [requestId, user.id, body.kind, body.newValue, codeHash(code), channel]);
      if (channel === 'sms_otp') {
        const emitted = await emitEvent(client, { eventType: 'customer.contact_change', entityType: 'user', entityId: user.id,
          payload: { requestId, kind: body.kind }, actorId: user.id });
        await client.query(
          `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,'transactional')`,
          [randomUUID(), emitted.eventId, user.id, body.newValue, `کد تأیید تغییر شماره همراه در کلبه وینتیج: ${code}`]);
      }
      await audit(client, user.id, 'customer.contact_change_requested', 'customer_contact_change', requestId, undefined,
        { kind: body.kind, newValue: body.newValue, channel }, request.ip);
      const response: Record<string, unknown> = {
        requestId, kind: body.kind, channel, status: 'pending_verification', expiresInSeconds: 900,
        deliveryHint: channel === 'sms_otp' ? 'کد به شماره جدید ارسال شد.' : 'لینک تأیید به ایمیل جدید ارسال می‌شود.',
      };
      // There is no email provider configured yet: outside production the code is
      // returned so the flow stays testable end-to-end. Never in production.
      if (channel === 'email_link' && config.NODE_ENV !== 'production') response.developmentCode = code;
      await completeIdempotency(client, user.id, `profile.contact_change.${body.kind}`, body.idempotencyKey, response);
      return response;
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/customer/profile/contact-change/:id/confirm', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const change = await one<{ id: string; kind: 'email' | 'phone'; new_value: string; code_hash: string; attempts: number; expires_at: Date }>(
        client, 'SELECT * FROM customer_contact_changes WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, user.id]);
      if (!change) throw notFound();
      if (new Date(change.expires_at).getTime() < Date.now()) throw conflict('مهلت کد تأیید پایان یافته است.');
      await client.query('UPDATE customer_contact_changes SET attempts = attempts + 1 WHERE id = $1', [id]);
      if (change.attempts >= 5) throw conflict('تعداد تلاش‌های ناموفق بیش از حد مجاز است.');
      if (change.code_hash !== codeHash(body.code)) throw conflict('کد تأیید نادرست است.');
      const duplicate = change.kind === 'email'
        ? await one(client, 'SELECT id FROM users WHERE email = $1 AND id <> $2', [change.new_value, user.id])
        : await one(client, 'SELECT id FROM users WHERE phone = $1 AND id <> $2', [change.new_value, user.id]);
      if (duplicate) throw conflict('این مقدار برای حساب دیگری ثبت شده است.');
      const before = await one<Record<string, unknown>>(client, 'SELECT email,phone FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      if (change.kind === 'email') {
        await client.query('UPDATE users SET email = $2, updated_at = now() WHERE id = $1', [user.id, change.new_value.toLowerCase()]);
      } else {
        await client.query('UPDATE users SET phone = $2, updated_at = now() WHERE id = $1', [user.id, change.new_value]);
      }
      await client.query('UPDATE customer_contact_changes SET verified_at = now(), consumed_at = now() WHERE id = $1', [id]);
      await recordTimeline(client, { userId: user.id, eventType: 'profile.contact_changed', source: 'account',
        title: change.kind === 'email' ? 'ایمیل تغییر کرد' : 'شماره همراه تغییر کرد',
        description: change.new_value, refType: 'customer_contact_change', refId: id, actorId: user.id });
      await audit(client, user.id, 'customer.contact_changed', 'user', user.id, before,
        { [change.kind]: change.new_value }, request.ip);
      await outboxEvent(client, 'customer.updated', 'user', user.id, { userId: user.id, fields: [change.kind] });
      return { updated: true, kind: change.kind };
    });
    return result;
  });

  /* ------------------------------ security center (104) ------------------------------ */
  app.get('/api/v1/customer/security/sessions', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(
      `SELECT id,ip,user_agent,created_at,last_seen_at,expires_at FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [user.id]);
    return { items: rows.rows.map((row) => ({ ...row, current: row.id === user.sessionId })) };
  });

  app.post('/api/v1/customer/security/sessions/:id/revoke', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const session = await one<{ id: string }>(client, 'SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, user.id]);
      if (!session) throw notFound();
      await client.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [id]);
      await audit(client, user.id, 'security.session_revoked', 'session', id, undefined, undefined, request.ip);
      return { revoked: true, current: id === user.sessionId };
    });
  });

  app.post('/api/v1/customer/security/sessions/revoke-others', async (request) => {
    const user = await principal(request, pool, config);
    return transaction(pool, async (client) => {
      const result = await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id',
        [user.id, user.sessionId]);
      await audit(client, user.id, 'security.other_sessions_revoked', 'session', user.sessionId, undefined,
        { revoked: result.rowCount }, request.ip);
      return { revoked: result.rowCount ?? 0 };
    });
  });

  app.get('/api/v1/customer/security/login-history', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,success,reason,ip,user_agent,created_at FROM user_login_history
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [user.id, query.limit]);
    return { items: rows.rows };
  });

  app.post('/api/v1/customer/security/password', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) }).strict().parse(request.body);
    const row = await one<{ password_hash: string }>(pool, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!row || !(await argon2.verify(row.password_hash, body.currentPassword))) throw unauthorized();
    const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
    return transaction(pool, async (client) => {
      await client.query('UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1',
        [user.id, hash]);
      const revoked = await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id', [user.id, user.sessionId]);
      await recordTimeline(client, { userId: user.id, eventType: 'security.password_changed', source: 'account',
        title: 'رمز عبور تغییر کرد', actorId: user.id });
      await audit(client, user.id, 'security.password_changed', 'user', user.id, undefined, { revokedSessions: revoked.rowCount }, request.ip);
      return { updated: true, revokedOtherSessions: revoked.rowCount ?? 0 };
    });
  });

  app.get('/api/v1/customer/security/2fa', async (request) => {
    const user = await principal(request, pool, config);
    const row = await one<{ enabled: boolean; method: string | null; secret_hint: string | null; confirmed_at: Date | null }>(pool,
      'SELECT enabled,method,secret_hint,confirmed_at FROM user_two_factor WHERE user_id = $1', [user.id]);
    return { twoFactor: row ?? { enabled: false, method: null, secret_hint: null, confirmed_at: null } };
  });

  app.post('/api/v1/customer/security/2fa/setup', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ method: z.enum(['otp_sms', 'authenticator']) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      if (body.method === 'authenticator') {
        const secret = generateTotpSecret();
        const encrypted = encryptSecret(config, secret);
        await client.query(
          `INSERT INTO user_two_factor(user_id,method,enabled,secret_ciphertext,secret_iv,secret_tag,secret_hint,confirmed_at)
           VALUES ($1,'authenticator',false,$2,$3,$4,$5,NULL)
           ON CONFLICT (user_id) DO UPDATE SET method = 'authenticator', enabled = false,
             secret_ciphertext = $2, secret_iv = $3, secret_tag = $4, secret_hint = $5, updated_at = now()`,
          [user.id, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.hint]);
        await audit(client, user.id, 'security.2fa_setup_started', 'user', user.id, undefined, { method: body.method }, request.ip);
        const issuer = encodeURIComponent('Kolbe Vintage');
        const label = encodeURIComponent(`${user.displayName}:${user.id.slice(0, 8)}`);
        return {
          method: body.method, status: 'pending_confirmation',
          otpauthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
          manualEntryKey: secret,
        };
      }
      const code = sixDigits();
      await client.query(
        `INSERT INTO user_two_factor(user_id,method,enabled,secret_hint) VALUES ($1,'otp_sms',false,$2)
         ON CONFLICT (user_id) DO UPDATE SET method = 'otp_sms', enabled = false, updated_at = now()`,
        [user.id, '••••']);
      const emitted = await emitEvent(client, { eventType: 'customer.2fa_setup', entityType: 'user', entityId: user.id,
        payload: { method: body.method }, actorId: user.id });
      const phone = (await one<{ phone: string | null }>(client, 'SELECT phone FROM users WHERE id = $1', [user.id]))?.phone;
      if (phone) {
        await client.query('INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,$$transactional$$)',
          [randomUUID(), emitted.eventId, user.id, phone, `کد فعال‌سازی ورود دومرحله‌ای: ${code}`]);
      }
      await client.query('UPDATE user_two_factor SET secret_hint = $2 WHERE user_id = $1', [user.id, codeHash(code).slice(0, 8)]);
      return { method: body.method, status: 'pending_confirmation', deliveryHint: phone ? 'کد به شماره همراه شما ارسال شد.' : 'شماره همراه ثبت نشده است.', developmentCode: config.NODE_ENV !== 'production' ? code : undefined };
    });
  });

  app.post('/api/v1/customer/security/2fa/confirm', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const row = await one<{ method: string | null; secret_ciphertext: Buffer | null; secret_iv: Buffer | null; secret_tag: Buffer | null; secret_hint: string | null }>(
        client, 'SELECT method,secret_ciphertext,secret_iv,secret_tag,secret_hint FROM user_two_factor WHERE user_id = $1 FOR UPDATE', [user.id]);
      if (!row?.method) throw notFound();
      let valid = false;
      if (row.method === 'authenticator' && row.secret_ciphertext && row.secret_iv && row.secret_tag) {
        valid = verifyTotp(decryptSecret(config, { ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }), body.code);
      } else {
        valid = row.secret_hint === codeHash(body.code).slice(0, 8);
      }
      if (!valid) throw conflict('کد تأیید نادرست است.');
      const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString('hex').toUpperCase());
      await client.query(
        `UPDATE user_two_factor SET enabled = true, confirmed_at = now(), recovery_codes = $2, updated_at = now() WHERE user_id = $1`,
        [user.id, JSON.stringify(recovery.map((code) => codeHash(code)))]);
      await recordTimeline(client, { userId: user.id, eventType: 'security.2fa_enabled', source: 'account',
        title: 'ورود دومرحله‌ای فعال شد', actorId: user.id });
      await audit(client, user.id, 'security.2fa_enabled', 'user', user.id, undefined, { method: row.method }, request.ip);
      return { enabled: true, method: row.method, recoveryCodes: recovery };
    });
  });

  app.post('/api/v1/customer/security/2fa/disable', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ password: z.string().min(1) }).strict().parse(request.body);
    const row = await one<{ password_hash: string }>(pool, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!row || !(await argon2.verify(row.password_hash, body.password))) throw unauthorized();
    return transaction(pool, async (client) => {
      await client.query(
        `UPDATE user_two_factor SET enabled = false, secret_ciphertext = NULL, secret_iv = NULL, secret_tag = NULL,
           recovery_codes = '[]'::jsonb, updated_at = now() WHERE user_id = $1`, [user.id]);
      await recordTimeline(client, { userId: user.id, eventType: 'security.2fa_disabled', source: 'account',
        title: 'ورود دومرحله‌ای غیرفعال شد', actorId: user.id });
      await audit(client, user.id, 'security.2fa_disabled', 'user', user.id, undefined, undefined, request.ip);
      return { enabled: false };
    });
  });

  /** Admin view of a customer's security state (support/security team). */
  app.get('/api/v1/admin/users/:id/security', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'security:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const sessions = await pool.query(
      `SELECT id,ip,user_agent,created_at,last_seen_at,revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]);
    const logins = await pool.query(
      `SELECT id,success,reason,ip,user_agent,created_at FROM user_login_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]);
    const twoFactor = await one<Record<string, unknown>>(pool,
      'SELECT enabled,method,confirmed_at FROM user_two_factor WHERE user_id = $1', [id]);
    return { sessions: sessions.rows, logins: logins.rows, twoFactor: twoFactor ?? { enabled: false, method: null } };
  });
}

/** Used by auth.ts to persist session context without duplicating SQL. */
export async function touchSession(client: PoolClient, sessionId: string, ip?: string, userAgent?: string) {
  await client.query('UPDATE sessions SET ip = COALESCE($2,ip), user_agent = COALESCE($3,user_agent), last_seen_at = now() WHERE id = $1',
    [sessionId, ip ?? null, (userAgent ?? '').slice(0, 300) || null]);
}
