import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import type { DbPool } from './db.js';
import { one, transaction } from './db.js';
import { audit } from './operations.js';
import { badRequest, notFound, forbidden } from './errors.js';
import { getFile, putFile, MAX_FILE_BYTES } from './storage.js';

export function registerFileRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Generic file upload (multipart)
  // Requires @fastify/multipart — if not registered, we handle json fallback for tests
  app.post('/api/v1/files', async (request, reply) => {
    const user = await principal(request, pool, config);
    // Try multipart
    let buffer: Buffer | null = null;
    let originalName = 'file';
    let mime = 'application/octet-stream';
    try {
      // @ts-ignore — fastify-multipart adds request.file
      const file = await (request as any).file?.();
      if (file) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of file.file) {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) throw badRequest('حجم فایل بیش از 10 مگابایت است.');
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
        originalName = file.filename ?? 'file';
        mime = file.mimetype ?? 'application/octet-stream';
      }
    } catch (e) {
      // fallback to json body for tests
    }
    if (!buffer) {
      const body = z.object({ originalName: z.string().min(1).max(255).optional(), mime: z.string().optional(), dataBase64: z.string().optional(), fileMeta: z.any().optional() }).parse(request.body ?? {});
      if (body.dataBase64) {
        buffer = Buffer.from(body.dataBase64, 'base64');
        originalName = body.originalName ?? 'file';
        mime = body.mime ?? 'application/octet-stream';
      } else if (body.fileMeta) {
        // fileMeta-only for backward compat — we still create a placeholder file record with empty content
        // But we require real file for new uploads; for now, reject
        throw badRequest('فایل واقعی ارسال نشده است. لطفاً multipart/form-data با فیلد file ارسال کنید.');
      } else {
        throw badRequest('فایل ارسال نشده است.');
      }
    }
    const { storageKey, sha256 } = await putFile(buffer, originalName, mime);
    const id = randomUUID();
    await pool.query(`INSERT INTO files(id, owner_id, storage_key, original_name, mime_type, size_bytes, sha256, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,'private')`,
      [id, user.id, storageKey, originalName, mime, buffer.length, sha256]);
    await transaction(pool, (c) => audit(c, user.id, 'file.uploaded', 'file', id, undefined, { originalName, mime, size: buffer.length }, request.ip));
    return reply.code(201).send({ id, storageKey, originalName, mime, size: buffer.length, sha256 });
  });

  // Download with permission check: owner or tickets:manage or admin
  app.get('/api/v1/files/:id', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const file = await one<any>(pool, 'SELECT * FROM files WHERE id = $1', [id]);
    if (!file) throw notFound();
    const isOwner = file.owner_id === user.id;
    const isManager = user.permissions.includes('tickets:manage') || user.permissions.includes('files:read') || user.roles.includes('admin');
    // Also check if file is linked to a ticket owned by user
    let hasTicketAccess = false;
    if (!isOwner && !isManager) {
      const link = await one(pool, 'SELECT ta.id FROM ticket_attachments ta JOIN tickets t ON t.id = ta.ticket_id WHERE ta.file_id = $1 AND t.owner_id = $2 LIMIT 1', [id, user.id]);
      hasTicketAccess = !!link;
      if (!hasTicketAccess) {
        // Check supplier doc access? For now, owner or manager only
        throw forbidden();
      }
    }
    const buffer = await getFile(file.storage_key);
    reply.header('Content-Type', file.mime_type);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    reply.header('Content-Length', file.size_bytes);
    return reply.send(buffer);
  });
}
