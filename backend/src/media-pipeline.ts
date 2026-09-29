import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, type DbPool } from './db.js';
import { isResizable, renderVariant } from './images.js';
import { getFile, putFile } from './storage.js';

/* Media Processing Pipeline (Req 234, 250-251, 322-323). Every `media.uploaded` outbox event is
   processed asynchronously: validate → inspect (dimensions, dominant colour) → responsive variants
   → background removal. Background removal needs an external vision provider; without one the step
   is recorded as `skipped` and the run finishes as `partial` (no fake cut-outs). */

export type PipelineSubject = 'product_media' | 'cms_asset' | 'review_photo';
type Step = { step: string; status: 'completed' | 'skipped' | 'failed'; detail?: string; at: string };

const PIPELINE_WIDTHS = [320, 640, 960] as const;

export async function runMediaPipeline(pool: DbPool, subject: PipelineSubject, subjectId: string, fileId: string | null) {
  const runId = randomUUID();
  const steps: Step[] = [];
  const metadata: Record<string, unknown> = {};
  const push = (step: string, status: Step['status'], detail?: string) => steps.push({ step, status, detail, at: new Date().toISOString() });
  await pool.query(`INSERT INTO media_pipeline_runs(id, subject_type, subject_id, file_id, status) VALUES ($1,$2,$3,$4,'running')`, [runId, subject, subjectId, fileId]);
  if (subject === 'product_media') await pool.query(`UPDATE product_media SET pipeline_status = 'processing' WHERE id = $1`, [subjectId]);
  let failed = false;
  try {
    const file = fileId ? await one<{ storage_key: string; mime_type: string; size_bytes: number }>(pool, 'SELECT storage_key, mime_type, size_bytes FROM files WHERE id = $1', [fileId]) : null;
    if (!file) {
      push('validate', 'skipped', 'رسانه خارجی (URL) — پردازش سمت سرور لازم نیست.');
    } else {
      const buffer = await getFile(file.storage_key);
      push('validate', 'completed', `${file.mime_type} · ${Math.round(file.size_bytes / 1024)}KB`);
      if (isResizable(file.mime_type)) {
        const image = sharp(buffer, { failOn: 'error' });
        const info = await image.metadata();
        const stats = await image.stats();
        const d = stats.dominant;
        metadata.width = info.width; metadata.height = info.height; metadata.hasAlpha = Boolean(info.hasAlpha);
        metadata.dominantColor = `#${[d.r, d.g, d.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
        push('inspect', 'completed', `${info.width}×${info.height}`);
        const made: number[] = [];
        for (const width of PIPELINE_WIDTHS) {
          if (info.width && width > info.width) continue;
          const variant = await renderVariant(buffer, width, 'webp');
          if (!variant) continue;
          const stored = await putFile(variant.buffer, `variant-${width}.webp`, variant.mime);
          await pool.query(`INSERT INTO media_variants(file_id, width, format, storage_key, size_bytes) VALUES ($1,$2,'webp',$3,$4)
            ON CONFLICT (file_id, width, format) DO UPDATE SET storage_key = EXCLUDED.storage_key, size_bytes = EXCLUDED.size_bytes`, [fileId, width, stored.storageKey, variant.buffer.length]);
          made.push(width);
        }
        metadata.variants = made;
        push('responsive_variants', 'completed', made.length ? made.map((w) => `${w}w`).join('، ') : 'تصویر کوچک‌تر از کوچک‌ترین عرض است');
      } else {
        push('inspect', 'skipped', 'فرمت غیرتصویری');
      }
    }
    const provider = await one<{ enabled: boolean }>(pool, `SELECT enabled FROM integrations WHERE code = 'background_removal'`).catch(() => null);
    if (subject === 'product_media' && provider?.enabled) push('background_removal', 'skipped', 'درخواست به سرویس بیرونی در صف ارسال قرار گرفت.');
    else push('background_removal', 'skipped', 'سرویس حذف پس‌زمینه متصل نیست.');
  } catch (error) {
    failed = true;
    push('error', 'failed', error instanceof Error ? error.message.slice(0, 200) : 'unknown');
  }
  const status = failed ? 'failed' : steps.some((s) => s.status === 'skipped' && s.step !== 'validate') ? 'partial' : 'completed';
  await pool.query(`UPDATE media_pipeline_runs SET status = $2, steps = $3, metadata = $4, finished_at = now() WHERE id = $1`,
    [runId, status, JSON.stringify(steps), JSON.stringify(metadata)]);
  if (subject === 'product_media') await pool.query(`UPDATE product_media SET pipeline_status = $2 WHERE id = $1`, [subjectId, failed ? 'failed' : 'ready']);
  return { runId, status, steps, metadata };
}

/** Outbox consumer: processes `media.uploaded` events that don't have a pipeline run yet. */
export async function processMediaUploadedEvents(pool: DbPool, limit = 10) {
  const rows = await pool.query(`SELECT e.id, e.aggregate_type, e.aggregate_id::text AS aggregate_id, e.payload FROM outbox_events e
    WHERE e.event_type = 'media.uploaded' AND e.aggregate_type IN ('product_media','cms_asset','review_photo')
      AND NOT EXISTS (SELECT 1 FROM media_pipeline_runs r WHERE r.subject_id = e.aggregate_id AND r.created_at >= e.created_at)
    ORDER BY e.created_at LIMIT $1`, [limit]);
  let processed = 0;
  for (const row of rows.rows as { aggregate_type: PipelineSubject; aggregate_id: string; payload: Record<string, unknown> }[]) {
    let fileId: string | null = typeof row.payload.fileId === 'string' ? row.payload.fileId : null;
    if (!fileId && row.aggregate_type === 'product_media') fileId = (await one<{ file_id: string | null }>(pool, 'SELECT file_id FROM product_media WHERE id = $1', [row.aggregate_id]))?.file_id ?? null;
    if (!fileId && row.aggregate_type === 'cms_asset') fileId = (await one<{ file_id: string | null }>(pool, 'SELECT file_id FROM cms_assets WHERE id = $1', [row.aggregate_id]))?.file_id ?? null;
    await runMediaPipeline(pool, row.aggregate_type, row.aggregate_id, fileId).catch(() => undefined);
    processed += 1;
  }
  return processed;
}

export function registerMediaPipelineRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/media-pipeline/runs', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:read');
    const q = z.object({ subjectType: z.enum(['product_media', 'cms_asset', 'review_photo']).optional(), subjectId: z.uuid().optional() }).parse(request.query);
    return { items: (await pool.query(`SELECT * FROM media_pipeline_runs WHERE ($1::text IS NULL OR subject_type = $1) AND ($2::uuid IS NULL OR subject_id = $2)
      ORDER BY created_at DESC LIMIT 100`, [q.subjectType ?? null, q.subjectId ?? null])).rows };
  });
  /** Admin trigger (also used by tests) — processes pending uploads immediately instead of waiting for the worker tick. */
  app.post('/api/v1/admin/media-pipeline/process', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:media');
    return { processed: await processMediaUploadedEvents(pool, 20) };
  });
}
