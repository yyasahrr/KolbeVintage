/* Shipping label PDFs — Master §I.
 *
 * The label is a separate OPERATIONAL document (never a financial one):
 *   - server-generated PDF (the about:blank + document.write path is gone),
 *   - NO product prices anywhere,
 *   - branding, order reference + Jalali date, sender, full recipient block,
 *     shipping method / carrier / tracking, and the REQUIRED package contents
 *     (name + color/size + qty per line) with a compact mode («و X ردیف دیگر…»)
 *     when the order exceeds the configured line limit,
 *   - two formats: 100×150mm thermal (one label per page) and an A4 batch grid
 *     (4 labels per page) for office printers.
 *
 * Rendering reuses the existing server PDF infrastructure (embedded Persian
 * font + RTL shaping from pdf.ts/shaping.ts) — no new rendering stack. */
import type { FastifyInstance } from 'fastify';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { notFound } from './errors.js';
import { formatJalali, loadFontBytes } from './pdf.js';
import { toPdfString } from './shaping.js';

/* 100mm × 150mm in PDF points (1mm = 2.83465pt). */
const THERMAL = { width: 283.46, height: 425.2 };
const A4 = { width: 595.28, height: 841.89 };
const INK = rgb(0.08, 0.1, 0.13);
const MUTED = rgb(0.4, 0.43, 0.48);
const LINE = rgb(0.72, 0.74, 0.78);

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
const shaped = (value: string) => toPdfString(value);

export type ShippingLabelData = {
  orderId: string;
  reference: string;
  createdAt: string;
  recipientName: string;
  recipientPhone: string;
  province: string;
  city: string;
  addressLine: string;
  postalCode: string;
  shippingMethod: string;
  carrier: string;
  trackingCode: string;
  lines: { productName: string; colorLabel: string | null; sizeLabel: string | null; quantity: number }[];
};

type AddressJson = { recipient?: string; phone?: string; province?: string; city?: string; line?: string; postalCode?: string };

/** Load label data for a set of orders (order preserved, missing ids skipped).
 *  Deliberately selects NO price columns — prices must not reach the label. */
export async function loadShippingLabelData(pool: DbPool, orderIds: string[]): Promise<ShippingLabelData[]> {
  if (!orderIds.length) return [];
  const orders = await pool.query<{
    id: string; reference: string; created_at: string; shipping_address: AddressJson;
    buyer_name: string | null; buyer_phone: string | null; shipping_method: string | null;
    carrier: string | null; tracking_code: string | null;
  }>(
    `SELECT o.id, o.reference, o.created_at, o.shipping_address,
            u.display_name AS buyer_name, u.phone AS buyer_phone,
            sm.name AS shipping_method, s.carrier, s.tracking_code
     FROM orders o
     LEFT JOIN users u ON u.id = o.buyer_id
     LEFT JOIN shipping_methods sm ON sm.id = o.shipping_method_id
     LEFT JOIN LATERAL (
       SELECT carrier, tracking_code FROM shipments
       WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
     ) s ON true
     WHERE o.id = ANY($1::uuid[])`, [orderIds]);
  const lines = await pool.query<{
    order_id: string; product_name: string; quantity: number; color_label: string | null; size_label: string | null;
  }>(
    `SELECT ol.order_id, ol.product_name, ol.quantity, pv.color_label, pv.size_label
     FROM order_lines ol
     LEFT JOIN product_variants pv ON pv.id = ol.variant_id
     WHERE ol.order_id = ANY($1::uuid[])
     ORDER BY ol.order_id, ol.id`, [orderIds]);
  const byOrder = new Map<string, ShippingLabelData['lines']>();
  for (const row of lines.rows) {
    const list = byOrder.get(row.order_id) ?? [];
    list.push({ productName: row.product_name, colorLabel: row.color_label, sizeLabel: row.size_label, quantity: row.quantity });
    byOrder.set(row.order_id, list);
  }
  const byId = new Map(orders.rows.map((row) => [row.id, row]));
  const result: ShippingLabelData[] = [];
  for (const id of orderIds) {
    const row = byId.get(id);
    if (!row) continue;
    const addr = row.shipping_address ?? {};
    result.push({
      orderId: row.id,
      reference: row.reference,
      createdAt: row.created_at,
      recipientName: addr.recipient || row.buyer_name || 'ثبت نشده',
      recipientPhone: addr.phone || row.buyer_phone || 'ثبت نشده',
      province: addr.province || 'ثبت نشده',
      city: addr.city || 'ثبت نشده',
      addressLine: addr.line || 'ثبت نشده',
      postalCode: addr.postalCode || 'ثبت نشده',
      shippingMethod: row.shipping_method || 'ثبت نشده',
      carrier: row.carrier || 'ثبت نشده',
      trackingCode: row.tracking_code || 'ثبت نشده',
      lines: byOrder.get(id) ?? [],
    });
  }
  return result;
}

/* ----------------------------- drawing helpers ----------------------------- */

/** Trim a logical string until its shaped form fits maxWidth (adds …). */
function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(shaped(text), size) <= maxWidth) return shaped(text);
  let keep = text;
  while (keep.length > 1 && font.widthOfTextAtSize(shaped(`${keep}…`), size) > maxWidth) keep = keep.slice(0, -1);
  return shaped(`${keep}…`);
}

type Cell = { page: PDFPage; font: PDFFont; x: number; yTop: number; width: number; height: number; cursor: number };

function textRight(cell: Cell, text: string, size: number, opts?: { color?: ReturnType<typeof rgb>; pad?: number }) {
  const value = fit(cell.font, text, size, cell.width - (opts?.pad ?? 0) * 2);
  const width = cell.font.widthOfTextAtSize(value, size);
  cell.page.drawText(value, { x: cell.x + cell.width - (opts?.pad ?? 0) - width, y: cell.cursor - size, size, font: cell.font, color: opts?.color ?? INK });
}

function textLeft(cell: Cell, text: string, size: number, color = MUTED) {
  const value = fit(cell.font, text, size, cell.width / 2);
  cell.page.drawText(value, { x: cell.x, y: cell.cursor - size, size, font: cell.font, color });
}

function rule(cell: Cell, y: number, thickness = 0.8, color = LINE) {
  cell.page.drawLine({ start: { x: cell.x, y }, end: { x: cell.x + cell.width, y }, thickness, color });
}

/** Draw one label into a rectangular cell (shared by thermal + A4 grid). */
function drawLabel(cell: Cell, label: ShippingLabelData, maxLines: number, boxed: boolean) {
  const { page } = cell;
  if (boxed) {
    page.drawRectangle({ x: cell.x - 6, y: cell.yTop - cell.height + 2, width: cell.width + 12, height: cell.height - 4, borderColor: LINE, borderWidth: 0.8 });
  }
  cell.cursor = cell.yTop;
  // ① branding + Jalali date
  textRight(cell, 'کلبه وینتیج', 11);
  textLeft(cell, formatJalali(label.createdAt), 7.5);
  cell.cursor -= 15;
  rule(cell, cell.cursor, 1.2, INK);
  cell.cursor -= 6;
  // ② order reference
  textRight(cell, `سفارش ${label.reference}`, 12.5);
  cell.cursor -= 19;
  // ③ recipient
  textRight(cell, 'گیرنده', 6.5, { color: MUTED });
  cell.cursor -= 9;
  textRight(cell, `${label.recipientName} — ${label.recipientPhone}`, 9.5);
  cell.cursor -= 13;
  textRight(cell, `${label.province}، ${label.city}`, 8.5);
  cell.cursor -= 11.5;
  textRight(cell, label.addressLine, 8.5);
  cell.cursor -= 11.5;
  textRight(cell, `کد پستی: ${label.postalCode}`, 8.5);
  cell.cursor -= 13;
  rule(cell, cell.cursor);
  cell.cursor -= 5;
  // ④ sender + shipping
  textRight(cell, 'فرستنده: کلبه وینتیج — انبار مرکزی', 8, { color: MUTED });
  cell.cursor -= 11;
  textRight(cell, `ارسال: ${label.shippingMethod} — حامل: ${label.carrier}`, 8.5);
  cell.cursor -= 12;
  textRight(cell, `کد رهگیری: ${label.trackingCode}`, 10);
  cell.cursor -= 15;
  rule(cell, cell.cursor);
  cell.cursor -= 5;
  // ⑤ package contents — REQUIRED (name / color / size / qty), never prices.
  const totalQty = label.lines.reduce((sum, line) => sum + line.quantity, 0);
  textRight(cell, `اقلام بسته (${fa(label.lines.length)} ردیف — ${fa(totalQty)} عدد)`, 7.5, { color: MUTED });
  cell.cursor -= 10.5;
  const lineHeight = 10.5;
  const floor = cell.yTop - cell.height + 10;
  let shown = 0;
  for (const line of label.lines) {
    const needMoreRow = shown + 1 < label.lines.length;
    if (shown >= maxLines || cell.cursor - lineHeight - (needMoreRow ? lineHeight : 0) < floor) break;
    const variant = [line.colorLabel, line.sizeLabel].filter(Boolean).join(' / ');
    textRight(cell, `• ${line.productName}${variant ? ` — ${variant}` : ''} ×${fa(line.quantity)}`, 8);
    cell.cursor -= lineHeight;
    shown += 1;
  }
  if (shown < label.lines.length) {
    textRight(cell, `و ${fa(label.lines.length - shown)} ردیف دیگر…`, 8, { color: MUTED });
  }
}

/** Render labels: 'thermal' = one 100×150mm page per label; 'a4' = grid of 4 per A4 page. */
export async function renderShippingLabelsPdf(labels: ShippingLabelData[], options: { format: 'thermal' | 'a4'; maxLines: number }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await loadFontBytes(), { subset: true });
  pdf.setTitle('لیبل ارسال — کلبه وینتیج');
  pdf.setProducer('Kolbe Vintage — server label engine');
  pdf.setCreationDate(new Date());
  if (options.format === 'thermal') {
    const margin = 14;
    for (const label of labels) {
      const page = pdf.addPage([THERMAL.width, THERMAL.height]);
      drawLabel({ page, font, x: margin, yTop: THERMAL.height - margin, width: THERMAL.width - margin * 2, height: THERMAL.height - margin * 2, cursor: 0 },
        label, options.maxLines, false);
    }
  } else {
    const cellWidth = A4.width / 2;
    const cellHeight = A4.height / 2;
    const pad = 20;
    for (let index = 0; index < labels.length; index += 1) {
      const slot = index % 4;
      const page = slot === 0 ? pdf.addPage([A4.width, A4.height]) : pdf.getPage(pdf.getPageCount() - 1);
      const col = slot % 2; // RTL reading order: first label top-right
      const row = Math.floor(slot / 2);
      const x = (col === 0 ? cellWidth : 0) + pad;
      const yTop = A4.height - row * cellHeight - pad;
      drawLabel({ page, font, x, yTop, width: cellWidth - pad * 2, height: cellHeight - pad * 2, cursor: 0 },
        labels[index]!, options.maxLines, true);
    }
  }
  return pdf.save();
}

/* ----------------------------- routes ----------------------------- */

const maxLinesSchema = z.coerce.number().int().min(3).max(12).default(6);

export function registerShippingLabelRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** Single order label — 100×150mm thermal PDF, served inline. */
  app.get('/api/v1/admin/orders/:orderId/label', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'tracking:manage');
    const { orderId } = z.object({ orderId: z.uuid() }).parse(request.params);
    const { maxLines } = z.object({ maxLines: maxLinesSchema }).parse(request.query ?? {});
    const labels = await loadShippingLabelData(pool, [orderId]);
    if (!labels.length) throw notFound();
    const bytes = await renderShippingLabelsPdf(labels, { format: 'thermal', maxLines });
    await transaction(pool, (client) => audit(client, actor.id, 'label.printed', 'order', orderId,
      undefined, { reference: labels[0]!.reference, format: 'thermal' }, request.ip));
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="label-${labels[0]!.reference}.pdf"`)
      .header('Cache-Control', 'private, max-age=0, must-revalidate')
      .send(Buffer.from(bytes));
  });

  /** Batch labels for selected orders — thermal stack or A4 grid (4/page). */
  app.get('/api/v1/admin/orders/labels/bundle', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'tracking:manage');
    const query = z.object({
      ids: z.string().min(1).max(4000),
      format: z.enum(['thermal', 'a4']).default('thermal'),
      maxLines: maxLinesSchema,
    }).parse(request.query ?? {});
    const ids = [...new Set(query.ids.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 60);
    for (const id of ids) z.uuid().parse(id);
    const labels = await loadShippingLabelData(pool, ids);
    if (!labels.length) throw notFound();
    const bytes = await renderShippingLabelsPdf(labels, { format: query.format, maxLines: query.maxLines });
    await transaction(pool, (client) => audit(client, actor.id, 'label.bundle_printed', 'label_bundle', labels.map((l) => l.reference).join(','),
      undefined, { count: labels.length, format: query.format }, request.ip));
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="labels-bundle-${labels.length}.pdf"`)
      .header('Cache-Control', 'private, max-age=0, must-revalidate')
      .send(Buffer.from(bytes));
  });
}
