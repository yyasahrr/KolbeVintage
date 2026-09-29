import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
