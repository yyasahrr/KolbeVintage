import type { FastifyInstance } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from './config.js';
import type { DbPool } from './db.js';
import { one } from './db.js';
import { principal } from './auth.js';
import { ApiError, badRequest, notFound, unauthorized } from './errors.js';

const ALPHA_BASE = 'https://api.appalpha.ir/v1';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const secret = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);
type AlphaJob = {
  id?: string; status?: string; progress?: { percent?: number | null } | number | null;
  output?: { url?: string }; error?: { message?: string };
};

function imageMime(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function publicImageUrl(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const images = (metadata as { images?: unknown }).images;
  const first = Array.isArray(images) ? images[0] : null;
  const raw = typeof first === 'string' ? first : first && typeof first.url === 'string' ? first.url : null;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

async function alphaRequest(config: Config, path: string, body?: Record<string, unknown>): Promise<AlphaJob> {
  let response: Response;
  try {
    response = await fetch(`${ALPHA_BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.ALPHA_API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(body ? 30_000 : 15_000),
    });
  } catch {
    throw new ApiError(502, 'TRYON_PROVIDER_UNAVAILABLE', 'ارتباط با سرویس پرو مجازی برقرار نشد. دوباره تلاش کنید.');
  }
  const data = await response.json().catch(() => null) as AlphaJob | null;
  if (!response.ok || !data || (data.error && data.status !== 'failed')) {
    if (response.status === 402) throw new ApiError(503, 'TRYON_NO_CREDIT', 'اعتبار سرویس پرو مجازی کافی نیست.');
    if (response.status === 401 || response.status === 403) throw new ApiError(503, 'TRYON_AUTH', 'کلید سرویس پرو مجازی معتبر نیست.');
    if (response.status === 429) throw new ApiError(429, 'TRYON_BUSY', 'سرویس پرو مجازی شلوغ است. کمی بعد تلاش کنید.');
    throw new ApiError(502, 'TRYON_PROVIDER_ERROR', 'سرویس پرو مجازی درخواست را نپذیرفت.');
  }
  return data;
}

function clientJob(data: AlphaJob) {
  const progress = typeof data.progress === 'number' ? data.progress : data.progress?.percent;
  const percent = typeof progress === 'number' && Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.round(progress))) : null;
  const outputUrl = data.status === 'ready' && typeof data.output?.url === 'string' && data.output.url.startsWith('https://')
    ? data.output.url : null;
  return { status: data.status === 'ready' ? 'ready' : data.status === 'failed' ? 'failed' : 'processing', percent,
    outputUrl, message: data.status === 'failed' ? (data.error?.message?.slice(0, 200) || 'ساخت تصویر ناموفق بود.') : null };
}

/** Real image-edit flow. The customer photo is forwarded once and never persisted by Kolbe. */
export function registerTryOnRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.post('/api/v1/tryon/jobs', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!config.ALPHA_API_KEY) throw new ApiError(503, 'TRYON_NOT_CONFIGURED', 'سرویس پرو مجازی هنوز تنظیم نشده است.');
    if (!request.isMultipart()) throw badRequest('عکس را به صورت فایل ارسال کنید.');
    let productId = '';
    let photo: Buffer | null = null;
    for await (const part of request.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 2 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'productId' && typeof part.value === 'string') productId = part.value;
      } else if (part.fieldname === 'photo') {
        const buffer = await part.toBuffer();
        if (buffer.length > MAX_PHOTO_BYTES) throw badRequest('حجم عکس نباید بیش از ۵ مگابایت باشد.');
        photo = buffer;
      }
    }
    const id = z.uuid().safeParse(productId);
    if (!id.success) throw badRequest('محصول معتبر انتخاب کنید.');
    if (!photo || !photo.length) throw badRequest('عکس خود را انتخاب کنید.');
    const mime = imageMime(photo);
    if (!mime) throw badRequest('فرمت عکس باید JPG، PNG یا WebP باشد.');
    const product = await one<{ name: string; metadata: unknown }>(pool,
      "SELECT name,metadata FROM products WHERE id=$1 AND status='published' AND owner_type='kolbe' AND retail_enabled=true", [productId]);
    if (!product) throw notFound('محصول پیدا نشد.');
    const garmentImage = publicImageUrl(product.metadata);
    if (!garmentImage) throw badRequest('این محصول عکس عمومی مناسب برای پرو مجازی ندارد.');

    const job = await alphaRequest(config, '/generations', {
      model: 'qwen-image-edit',
      prompt: `تصویر اول عکس شخص است. تصویر دوم لباس یا اکسسوری محصول «${product.name}» است. محصول تصویر دوم را به شکل طبیعی روی شخص تصویر اول قرار بده؛ چهره، هویت، ژست و پس‌زمینهٔ شخص را حفظ کن. رنگ، طرح و جزئیات محصول را تا حد امکان مطابق تصویر دوم نگه دار. خروجی یک عکس واقع‌گرایانه از همان شخص با این محصول باشد.`,
      image: `data:${mime};base64,${photo.toString('base64')}`,
      image2: garmentImage,
    });
    if (!job.id || !z.uuid().safeParse(job.id).success) throw new ApiError(502, 'TRYON_BAD_RESPONSE', 'پاسخ سرویس پرو مجازی معتبر نبود.');
    const jobToken = await new SignJWT({ jid: job.id, sid: user.sessionId })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('kolbe-tryon')
      .setAudience('kolbe-tryon').setIssuedAt().setExpirationTime('20m').sign(secret(config));
    return reply.code(202).send({ jobToken, ...clientJob(job) });
  });

  // The signed token stays in a JSON body, away from URL logs and Fastify's path-length limit.
  app.post('/api/v1/tryon/jobs/status', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const user = await principal(request, pool, config);
    if (!config.ALPHA_API_KEY) throw new ApiError(503, 'TRYON_NOT_CONFIGURED', 'سرویس پرو مجازی هنوز تنظیم نشده است.');
    const { token } = z.object({ token: z.string().max(1200) }).parse(request.body);
    let jobId = '';
    try {
      const verified = await jwtVerify(token, secret(config), { issuer: 'kolbe-tryon', audience: 'kolbe-tryon' });
      if (verified.payload.sub !== user.id || verified.payload.sid !== user.sessionId) throw new Error('owner');
      jobId = String(verified.payload.jid ?? '');
      if (!z.uuid().safeParse(jobId).success) throw new Error('id');
    } catch { throw unauthorized(); }
    const job = await alphaRequest(config, `/generations/${jobId}`);
    return clientJob(job);
  });
}
