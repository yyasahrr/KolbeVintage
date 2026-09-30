import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

/* Secrets are encrypted at rest with AES-256-GCM (item 23). Plaintext keys are
   never returned by the API; callers only ever see the hint (last characters). */

function keyFrom(config: Config): Buffer {
  const material = config.SECRETS_KEY ?? config.JWT_SECRET;
  return createHash('sha256').update(`kolbe-secrets:${material}`).digest();
}

export type EncryptedSecret = { ciphertext: Buffer; iv: Buffer; tag: Buffer; hint: string };

export function encryptSecret(config: Config, plaintext: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(config), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), hint: hintOf(plaintext) };
}

export function decryptSecret(config: Config, secret: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): string {
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(config), secret.iv);
  decipher.setAuthTag(secret.tag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}

export function hintOf(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}

/** Timestamped HMAC (`t=…,v1=…`) — the same scheme the outbox dispatcher signs with.
 *  A stale timestamp is rejected, which is the first half of replay protection. */
export function verifyTimestampedSignature(secret: string, rawBody: Buffer, signature: string,
  toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): { valid: boolean; reason?: string } {
  const parts = Object.fromEntries(signature.split(',').map((piece) => piece.split('=', 2) as [string, string]));
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return { valid: false, reason: 'malformed_signature' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: 'timestamp_out_of_tolerance' };
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  if (provided.length !== expected.length) return { valid: false, reason: 'bad_signature' };
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))
    ? { valid: true } : { valid: false, reason: 'bad_signature' };
}

export function verifyHmacSignature(secret: string, rawBody: Buffer, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]+$/i.test(provided) || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}
