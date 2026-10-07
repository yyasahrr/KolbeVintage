import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';

export type StoragePutResult = { storageKey: string; sha256: string };

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif',
  'application/pdf', 'video/mp4', 'video/webm', 'text/plain',
]);
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function validateFileMeta(mime: string, size: number) {
  if (!ALLOWED_MIME.has(mime)) throw new Error('نوع فایل مجاز نیست.');
  if (size <= 0 || size > MAX_FILE_BYTES) throw new Error('حجم فایل باید بین 1 بایت تا 10 مگابایت باشد.');
}

function storageDir() {
  // Use backend/storage/private for dev
  // In production, this would be S3 abstraction
  const base = join(process.cwd(), 'storage', 'private');
  return base;
}

export async function putFile(buffer: Buffer, originalName: string, mime: string): Promise<StoragePutResult> {
  validateFileMeta(mime, buffer.length);
  const dir = storageDir();
  await mkdir(dir, { recursive: true });
  const key = `${new Date().toISOString().slice(0,10)}/${randomUUID()}${extname(originalName).toLowerCase() || ''}`;
  const fullPath = join(dir, key);
  await mkdir(join(dir, key.split('/')[0] ?? ''), { recursive: true });
  await writeFile(fullPath, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return { storageKey: key, sha256 };
}

export async function getFile(storageKey: string): Promise<Buffer> {
  const fullPath = join(storageDir(), storageKey);
  return readFile(fullPath);
}

export async function deleteFile(storageKey: string): Promise<void> {
  const fullPath = join(storageDir(), storageKey);
  await unlink(fullPath).catch(() => {});
}

export function getPrivateUrl(storageKey: string): string {
  // For dev, return a route that checks permission; for prod, signed URL
  return `/api/v1/files/${encodeURIComponent(storageKey)}`;
}

/* ---- Agent D2: S3-compatible object storage (optional; returns null when NOT_CONFIGURED) ---- */
import type { Config } from './config.js';

export function createObjectStorage(config: Config) {
  if (!config.S3_ENDPOINT || !config.S3_REGION || !config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY || !config.S3_PUBLIC_BASE_URL) return null;
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
  });
  return {
    bucket: config.S3_BUCKET,
    publicBase: config.S3_PUBLIC_BASE_URL.replace(/\/$/, ''),
    async signPut(key: string, contentType: string) {
      const command = new PutObjectCommand({ Bucket: config.S3_BUCKET!, Key: key, ContentType: contentType });
      return getSignedUrl(client, command, { expiresIn: 300 });
    },
    async head(key: string) {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.S3_BUCKET!, Key: key }));
      return { size: head.ContentLength ?? null, contentType: head.ContentType ?? null };
    },
  };
}
