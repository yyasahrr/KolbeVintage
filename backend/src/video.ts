import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { badRequest, forbidden, notFound } from './errors.js';

/* Responsive product video + video analytics (items 313-314).
   The player gets poster/sources/adaptive data from the media domain and reports
   play / 25 / 50 / 75 / complete, which flows into product analytics and CRM. */

const mediaBody = z.object({
  // Union of Agent C's media roles and Agent D1's video-domain roles.
  role: z.enum(['hero', 'gallery', 'flat_lay', 'on_model', 'detail', 'size_guide', 'video', 'poster', 'campaign']).default('gallery'),
  fileId: z.uuid().nullable().optional(),
  externalUrl: z.string().url().max(500).nullable().optional(),
  url: z.string().regex(/^https:\/\/[^\s<>"]+$/).max(500).nullable().optional(),
  posterFileId: z.uuid().nullable().optional(),
  variantId: z.uuid().nullable().optional(),
  position: z.number().int().min(0).max(100).default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
  altText: z.string().trim().max(300).default(''),
  cutoutUrl: z.string().max(400).nullable().optional(),
  // Agent D2 contract: media-library purpose bucket (column default 'gallery').
  purpose: z.string().min(1).max(100).optional(),
  // Agent D2: link the product to a Media Library asset (media_assets row created via /admin/media).
  mediaAssetId: z.uuid().nullable().optional(),
}).strict().refine((value) => Boolean(value.fileId || value.externalUrl || value.url || value.mediaAssetId), 'fileId، externalUrl، url یا mediaAssetId لازم است.');

export function registerVideoRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** Public media payload for the responsive player (item 313). */
  app.get('/api/v1/products/:id/media', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<{ status: string }>(pool, 'SELECT status FROM products WHERE id = $1', [id]);
    if (!product || product.status !== 'published') throw notFound();
    const rows = await pool.query(
      `SELECT m.id,m.role,m.position,m.url,m.external_url,m.cutout_url,m.alt_text,m.pipeline_status,m.metadata,m.variant_id,
              f.id AS file_id, f.original_name, f.mime_type, f.size_bytes,
              p.id AS poster_id, p.storage_key AS poster_key, p.mime_type AS poster_mime
       FROM product_media m
       LEFT JOIN files f ON f.id = m.file_id
       LEFT JOIN files p ON p.id = m.poster_file_id
       WHERE m.product_id = $1 AND m.active ORDER BY m.position, m.created_at`, [id]);
    const items = rows.rows.map((row) => ({
      id: row.id, role: row.role, variantId: row.variant_id, position: row.position,
      // Union URL semantics: external_url (Agent D1), 035's url column, then the file route.
      url: row.external_url ?? row.url ?? (row.file_id ? `/api/v1/files/${row.file_id}` : null),
      cutoutUrl: row.cutout_url, altText: row.alt_text,
      pipelineStatus: row.pipeline_status, pipelineMeta: row.metadata ?? {},
      mimeType: row.mime_type, fileName: row.original_name, sizeBytes: row.size_bytes,
      posterUrl: row.poster_id ? `/api/v1/files/${row.poster_id}` : null,
      metadata: row.metadata ?? {},
    }));
    // Player hints keep the responsive/lazy requirements declarative instead of duplicated in the UI.
    return {
      items,
      player: {
        lazy: true, controls: true, mutedPreviewDefault: true, adaptiveSizing: true,
        posterRequiredForVideo: true, preload: 'metadata',
      },
    };
  });

  app.get('/api/v1/videos/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one<Record<string, unknown>>(pool,
      `SELECT id,title,product_id,media_id,blog_post_code,poster_url,duration_seconds,sources,cdn_ready
       FROM video_assets WHERE id = $1 AND active`, [id]);
    if (!row) throw notFound();
    return { video: {
      id: row.id, title: row.title, productId: row.product_id, blogPostCode: row.blog_post_code,
      posterUrl: row.poster_url, durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      sources: row.sources ?? [], cdnReady: row.cdn_ready,
    }, player: { lazy: true, controls: true, mutedPreviewDefault: true, adaptiveSizing: true } };
  });

  /** Batch ingest from the player — cheap, privacy-aware and idempotent per event id. */
  app.post('/api/v1/video/events', async (request, reply) => {
    const user = await principal(request, pool, config).catch(() => null);
    const body = z.object({
      sessionId: z.string().max(80).optional(),
      anonymousId: z.string().max(80).optional(),
      events: z.array(z.object({
        videoId: z.string().trim().min(1).max(120),
        productId: z.uuid().nullable().optional(),
        blogPostCode: z.string().max(80).nullable().optional(),
        eventType: z.enum(['play', '25', '50', '75', 'complete', 'pause', 'seek', 'error']),
        positionSeconds: z.number().min(0).max(86_400).optional(),
        watchedSeconds: z.number().min(0).max(86_400).optional(),
        surface: z.enum(['product', 'blog', 'cms', 'other']).default('product'),
        source: z.string().max(40).default('web'),
        clientEventId: z.string().max(80).optional(),
      })).min(1).max(100),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      let recorded = 0;
      for (const event of body.events) {
        if (event.clientEventId) {
          const duplicate = await one(client,
            `SELECT id FROM video_analytics_events WHERE id::text = $1`, [event.clientEventId]);
          if (duplicate) continue;
        }
        await client.query(
          `INSERT INTO video_analytics_events(id,video_id,product_id,blog_post_code,user_id,anonymous_id,session_id,
             event_type,position_seconds,watched_seconds,surface,source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [event.clientEventId ?? randomUUID(), event.videoId, event.productId ?? null, event.blogPostCode ?? null,
            user?.id ?? null, body.anonymousId ?? null, body.sessionId ?? null, event.eventType,
            event.positionSeconds ?? null, event.watchedSeconds ?? null, event.surface, event.source]);
        recorded += 1;
      }
      return { recorded };
    });
    return reply.code(202).send(result);
  });

  /** Requirement 314 + 117: completion funnel per video/product, CRM-connectable. */
  app.get('/api/v1/admin/video/analytics', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'media:manage');
    const query = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      productId: z.uuid().optional(),
      videoId: z.string().max(120).optional(),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.video_id, e.product_id,
              count(*) FILTER (WHERE e.event_type = 'play')::int AS plays,
              count(*) FILTER (WHERE e.event_type = '25')::int AS q25,
              count(*) FILTER (WHERE e.event_type = '50')::int AS q50,
              count(*) FILTER (WHERE e.event_type = '75')::int AS q75,
              count(*) FILTER (WHERE e.event_type = 'complete')::int AS completes,
              count(*) FILTER (WHERE e.event_type = 'error')::int AS errors,
              COALESCE(avg(e.watched_seconds) FILTER (WHERE e.event_type = 'complete'), 0)::numeric(10,1)::text AS avg_watched_seconds
       FROM video_analytics_events e
       WHERE e.created_at > now() - ($1::int || ' days')::interval
         AND ($2::uuid IS NULL OR e.product_id = $2) AND ($3::text IS NULL OR e.video_id = $3)
       GROUP BY e.video_id, e.product_id ORDER BY plays DESC LIMIT 100`,
      [query.days, query.productId ?? null, query.videoId ?? null]);
    const items = rows.rows.map((row) => ({
      videoId: row.video_id, productId: row.product_id, plays: row.plays,
      quartiles: { q25: row.q25, q50: row.q50, q75: row.q75, complete: row.completes },
      completionRate: row.plays ? Math.round((row.completes / row.plays) * 10000) / 100 : 0,
      averageWatchedSeconds: Number(row.avg_watched_seconds),
      errors: row.errors,
      crmHook: 'رویداد complete می‌تواند تریگر CRM باشد (video.completed).',
    }));
    const byUser = await pool.query(
      `SELECT user_id, count(*) FILTER (WHERE event_type = 'complete')::int AS completions
       FROM video_analytics_events
       WHERE user_id IS NOT NULL AND created_at > now() - ($1::int || ' days')::interval
       GROUP BY user_id ORDER BY completions DESC LIMIT 10`, [query.days]);
    return { items, topViewers: byUser.rows };
  });

  app.post('/api/v1/admin/products/:id/media', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = mediaBody.parse(request.body);
    const product = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    // Agent D2 media library asset (optional): validate it and borrow its public URL/mime when no file/url given.
    let asset: { public_url: string; mime_type: string | null; alt_text: string | null } | null = null;
    if (body.mediaAssetId) {
      asset = await one<{ public_url: string; mime_type: string | null; alt_text: string | null }>(
        pool, `SELECT public_url, mime_type, alt_text FROM media_assets WHERE id = $1 AND processing_status IN ('ready','pending')`, [body.mediaAssetId]);
      if (!asset) throw notFound();
    }
    // Union permission: supplier owners / products:write (Agent C) or media:manage (Agent D1).
    const isOwner = product.supplier_id === user.id && user.roles.includes('supplier');
    if (!isOwner && !user.permissions.includes('products:write') && !user.permissions.includes('media:manage')) throw forbidden();
    if (body.variantId) {
      const variant = await one(pool, 'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2', [body.variantId, id]);
      if (!variant) throw badRequest('واریانت متعلق به این محصول نیست.');
    }
    let mime: string | null = null;
    if (body.fileId) {
      const file = await one<{ mime_type: string; visibility: string }>(pool, 'SELECT mime_type, visibility FROM files WHERE id = $1', [body.fileId]);
      if (!file) throw badRequest('فایل یافت نشد.');
      mime = file.mime_type;
      if (body.role === 'video' ? !mime.startsWith('video/') : !mime.startsWith('image/')) throw badRequest('نوع فایل با نقش رسانه سازگار نیست.');
      if (body.role === 'video' && file.visibility !== 'public') throw badRequest('ویدیوی محصول باید فایل عمومی باشد.');
    }
    if (!mime && asset) mime = asset.mime_type;
    const mediaId = randomUUID();
    const url = body.fileId ? `/api/v1/media/${body.fileId}` : (body.url ?? asset?.public_url ?? null);
    return transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO product_media(id,product_id,variant_id,media_asset_id,purpose,role,file_id,url,external_url,poster_file_id,cutout_url,mime_type,alt_text,position,pipeline_status,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [mediaId, id, body.variantId ?? null, body.mediaAssetId ?? null, body.purpose ?? 'gallery', body.role, body.fileId ?? null, url, body.externalUrl ?? null,
          body.posterFileId ?? null, body.cutoutUrl ?? null, mime, body.altText || asset?.alt_text || '', body.position,
          body.role === 'flat_lay' && !body.cutoutUrl ? 'uploaded' : 'ready', JSON.stringify(body.metadata)]);
      if (body.role === 'video') {
        await client.query(
          `INSERT INTO video_assets(id,title,product_id,media_id,poster_url,sources,cdn_ready)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), String(body.metadata.title ?? 'ویدیوی محصول'), id, mediaId,
            body.posterFileId ? `/api/v1/files/${body.posterFileId}` : (body.metadata.posterUrl as string) ?? null,
            JSON.stringify(body.metadata.sources ?? []), Boolean(body.metadata.cdnReady ?? false)]);
      }
      await audit(client, user.id, 'product.media_added', 'product', id, undefined, { mediaId, role: body.role }, request.ip);
      // Agent C automation hooks: media pipeline + style analysis (worker-side, async).
      await outbox(client, 'media.uploaded', 'product_media', mediaId, { productId: id, mediaId, role: body.role, url: url ?? body.externalUrl });
      if (body.role !== 'video') await outbox(client, 'product.style_analysis_requested', 'product', id, { productId: id, reason: 'media.uploaded' });
      return reply.code(201).send({ id: mediaId, productId: id, role: body.role, url: url ?? body.externalUrl ?? null });
    });
  });
}
