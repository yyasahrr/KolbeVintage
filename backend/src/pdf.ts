/* Server-side PDF rendering for financial documents (invoices, statements, reports).
 *
 * Output requirements (product doc items 29, 148, 168):
 *   - generated on the server, never in the browser,
 *   - RTL + Persian, Jalali dates, A4, print-ready,
 *   - a real embedded Persian-compatible font (no client font dependency),
 *   - the produced file is stored through the file/storage domain so every
 *     document keeps a stable reference to its own immutable PDF.
 *
 * The renderer is deliberately template-driven: pages, tables and text blocks
 * are described as data, so admins configure templates instead of code.
 */
import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { toPdfString } from './shaping.js';

export const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.85, 0.86, 0.88);

let fontPromise: Promise<Uint8Array> | null = null;
/** Shared embedded Persian font (also used by the shipping-label renderer). */
export function loadFontBytes() {
  fontPromise ??= readFile(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url));
  return fontPromise;
}

const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

/** Gregorian → Jalali (no external dependency, same arithmetic as the UI helper). */
export function toJalali(date: Date): { year: number; month: number; day: number } {
  const gy = date.getFullYear(); const gm = date.getMonth() + 1; const gd = date.getDate();
  const gDaysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let jy = gy <= 1600 ? 0 : 979;
  const gy2 = gy <= 1600 ? gy - 621 : gy - 1600;
  const gm2 = gm > 2 ? gm : gm;
  let days = (gy2 * 365) + Math.floor((gy2 + 3) / 4) - (gy <= 1600 ? 0 : Math.floor((gy2 + 99) / 100)) + Math.floor((gy2 + 399) / 400)
    - 80 + gd + gDaysInMonth.slice(0, gm2 - 1).reduce((total, value) => total + value, 0)
    + (gm > 2 && ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0) ? 1 : 0);
  jy += 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return { year: jy, month: jm, day: jd };
}

/** `۱۴۰۵/۰۷/۰۷ ۱۰:۳۰` — Persian digits, Jalali calendar, Tehran-independent (UTC derived). */
export function formatJalali(value: Date | string | null | undefined, withTime = false): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const { year, month, day } = toJalali(date);
  const parts = withTime
    ? [String(date.getHours()).padStart(2, '0'), String(date.getMinutes()).padStart(2, '0')]
    : [];
  const digits = (text: string) => text.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]!);
  return digits([`${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`, ...parts].join(' '));
}

export function formatJalaliLong(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const { year, month, day } = toJalali(date);
  const digits = (text: string) => text.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]!);
  return digits(`${day} ${JALALI_MONTHS[month - 1]} ${year}`);
}

export function formatRial(value: bigint | string | number): string {
  const amount = typeof value === 'bigint' ? value : BigInt(String(value || 0));
  const digits = (text: string) => text.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]!);
  return `${digits(amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '٬'))} ریال`;
}

export type PdfColumn = { key: string; label: string; width: number; align?: 'right' | 'left' };

export type PdfSection =
  | { type: 'heading'; text: string; sub?: string }
  | { type: 'keyValues'; title?: string; rows: Array<{ label: string; value: string }> }
  | { type: 'table'; title?: string; columns: PdfColumn[]; rows: Array<Record<string, string>>; emptyText?: string }
  | { type: 'totals'; title?: string; rows: Array<{ label: string; value: string; strong?: boolean }> }
  | { type: 'paragraph'; title?: string; text: string }
  | { type: 'divider' }
  | { type: 'signature'; lines: string[] };

export type PdfDocumentModel = {
  title: string;
  subtitle?: string;
  accent?: { r: number; g: number; b: number };
  watermarkText?: string;
  footerText?: string;
  sections: PdfSection[];
};

/** Every string that goes onto a page is shaped here (contextual Arabic forms). */
const shaped = (value: string) => toPdfString(value);

class Renderer {
  private page: PDFPage;
  private cursorY = A4.height - MARGIN;
  private readonly pages: PDFPage[] = [];
  private readonly accent: ReturnType<typeof rgb>;

  constructor(private readonly pdf: PDFDocument, private readonly font: PDFFont, accent: { r: number; g: number; b: number }) {
    this.accent = rgb(accent.r, accent.g, accent.b);
    this.page = pdf.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
  }

  private ensureSpace(height: number) {
    if (this.cursorY - height < MARGIN + 30) {
      this.page = this.pdf.addPage([A4.width, A4.height]);
      this.pages.push(this.page);
      this.cursorY = A4.height - MARGIN;
    }
  }

  /** Right-aligned text (RTL default) — `align: 'left'` for codes and Latin amounts. */
  text(value: string, options: { size?: number; color?: ReturnType<typeof rgb>; align?: 'right' | 'left' | 'center'; indent?: number; bold?: boolean } = {}) {
    const size = options.size ?? 10;
    const visual = shaped(value);
    const width = this.font.widthOfTextAtSize(visual, size);
    const align = options.align ?? 'right';
    let x = A4.width - MARGIN - (options.indent ?? 0);
    if (align === 'right') x -= width;
    else if (align === 'center') x = (A4.width - width) / 2;
    this.ensureSpace(size + 6);
    this.cursorY -= size + 4;
    this.page.drawText(visual, { x, y: this.cursorY, size, font: this.font, color: options.color ?? INK });
    return this;
  }

  space(height = 8) { this.cursorY -= height; }

  private rule() {
    this.ensureSpace(10);
    this.cursorY -= 6;
    this.page.drawLine({ start: { x: MARGIN, y: this.cursorY }, end: { x: A4.width - MARGIN, y: this.cursorY }, thickness: 0.7, color: LINE });
    this.cursorY -= 6;
  }

  header(model: PdfDocumentModel) {
    this.page.drawRectangle({ x: 0, y: A4.height - 12, width: A4.width, height: 12, color: this.accent });
    this.cursorY -= 10;
    this.text(model.title, { size: 18 });
    if (model.subtitle) this.text(model.subtitle, { size: 11, color: MUTED });
    this.rule();
  }

  section(section: PdfSection) {
    switch (section.type) {
      case 'heading': {
        this.space(4);
        this.text(section.text, { size: 13 });
        if (section.sub) this.text(section.sub, { size: 10, color: MUTED });
        this.space(2);
        break;
      }
      case 'keyValues': {
        if (section.title) { this.space(4); this.text(section.title, { size: 11.5, color: this.accent }); }
        for (const row of section.rows) {
          this.ensureSpace(16);
          const label = shaped(row.label);
          this.cursorY -= 14;
          const labelWidth = this.font.widthOfTextAtSize(label, 9.5);
          // RTL layout: label hugs the right margin; value sits to its left and may not
          // overlap the label column — long values are truncated with an ellipsis.
          this.page.drawText(label, { x: A4.width - MARGIN - labelWidth, y: this.cursorY, size: 9.5, font: this.font, color: MUTED });
          const maxValueWidth = A4.width - MARGIN * 2 - 160;
          let rawValue = row.value;
          let value = shaped(rawValue);
          let width = this.font.widthOfTextAtSize(value, 9.5);
          while (width > maxValueWidth && rawValue.length > 1) {
            rawValue = rawValue.slice(0, -2);
            value = shaped(`${rawValue}…`);
            width = this.font.widthOfTextAtSize(value, 9.5);
          }
          this.page.drawText(value, { x: A4.width - MARGIN - 160 - width, y: this.cursorY, size: 9.5, font: this.font, color: INK });
        }
        this.space(2);
        break;
      }
      case 'table': {
        if (section.title) { this.space(4); this.text(section.title, { size: 11.5, color: this.accent }); }
        const contentWidth = A4.width - MARGIN * 2;
        const totalWeight = section.columns.reduce((total, column) => total + column.width, 0) || 1;
        const widths = section.columns.map((column) => (column.width / totalWeight) * contentWidth);
        this.ensureSpace(26);
        this.cursorY -= 18;
        let x = A4.width - MARGIN;
        this.page.drawRectangle({ x: MARGIN, y: this.cursorY - 4, width: contentWidth, height: 18, color: rgb(0.96, 0.96, 0.97) });
        section.columns.forEach((column, index) => {
          const width = widths[index]!;
          const label = shaped(column.label);
          const textWidth = this.font.widthOfTextAtSize(label, 9);
          const drawX = column.align === 'left' ? x - width + 4 : x - textWidth - 4;
          this.page.drawText(label, { x: drawX, y: this.cursorY, size: 9, font: this.font, color: MUTED });
          x -= width;
        });
        this.cursorY -= 8;
        for (const row of section.rows) {
          this.ensureSpace(18);
          this.cursorY -= 16;
          let cursorX = A4.width - MARGIN;
          section.columns.forEach((column, index) => {
            const width = widths[index]!;
            const value = shaped(row[column.key] ?? '—');
            const textWidth = this.font.widthOfTextAtSize(value, 9);
            const drawX = column.align === 'left' ? cursorX - width + 4 : cursorX - textWidth - 4;
            this.page.drawText(value, { x: drawX, y: this.cursorY, size: 9, font: this.font, color: INK });
            cursorX -= width;
          });
          this.page.drawLine({ start: { x: MARGIN, y: this.cursorY - 5 }, end: { x: A4.width - MARGIN, y: this.cursorY - 5 }, thickness: 0.4, color: LINE });
        }
        if (!section.rows.length) this.text(section.emptyText ?? 'موردی ثبت نشده است.', { size: 9.5, color: MUTED });
        this.space(4);
        break;
      }
      case 'totals': {
        if (section.title) { this.space(4); this.text(section.title, { size: 11.5, color: this.accent }); }
        for (const row of section.rows) {
          this.ensureSpace(18);
          const label = shaped(row.label);
          const value = shaped(row.value);
          this.cursorY -= 16;
          if (row.strong) {
            this.page.drawRectangle({ x: A4.width - MARGIN - 260, y: this.cursorY - 4, width: 260, height: 18, color: rgb(0.97, 0.95, 0.93) });
          }
          this.page.drawText(label, { x: A4.width - MARGIN - 250, y: this.cursorY, size: row.strong ? 11 : 9.5, font: this.font, color: row.strong ? INK : MUTED });
          const width = this.font.widthOfTextAtSize(value, row.strong ? 11 : 9.5);
          this.page.drawText(value, { x: A4.width - MARGIN - width, y: this.cursorY, size: row.strong ? 11 : 9.5, font: this.font, color: row.strong ? this.accent : INK });
        }
        this.space(4);
        break;
      }
      case 'paragraph': {
        if (section.title) { this.space(4); this.text(section.title, { size: 11.5, color: this.accent }); }
        for (const line of section.text.split('\n')) this.text(line, { size: 9.5, color: INK });
        this.space(2);
        break;
      }
      case 'divider':
        this.rule();
        break;
      case 'signature': {
        this.space(16);
        this.ensureSpace(30);
        const column = (A4.width - MARGIN * 2) / Math.max(1, section.lines.length);
        this.cursorY -= 22;
        section.lines.forEach((line, index) => {
          const label = shaped(line);
          const width = this.font.widthOfTextAtSize(label, 9.5);
          const x = A4.width - MARGIN - column * index - column / 2 - width / 2;
          this.page.drawText(label, { x, y: this.cursorY, size: 9.5, font: this.font, color: MUTED });
          this.page.drawLine({
            start: { x: A4.width - MARGIN - column * index - column / 2 - 60, y: this.cursorY + 26 },
            end: { x: A4.width - MARGIN - column * index - column / 2 + 60, y: this.cursorY + 26 },
            thickness: 0.6, color: LINE,
          });
        });
        this.space(6);
        break;
      }
    }
  }

  finish(model: PdfDocumentModel) {
    for (const [index, page] of this.pages.entries()) {
      const footer = shaped(`${model.footerText ?? ''} — صفحه ${index + 1} از ${this.pages.length}`);
      const width = this.font.widthOfTextAtSize(footer, 8.5);
      page.drawText(footer, { x: A4.width - MARGIN - width, y: MARGIN / 2, size: 8.5, font: this.font, color: MUTED });
    }
  }
}

/** Render one document model into a print-ready A4 PDF (RTL, Persian, embedded font). */
export async function renderPdf(model: PdfDocumentModel): Promise<Uint8Array> {
  const fontBytes = await loadFontBytes();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  pdf.setTitle(model.title);
  pdf.setProducer('Kolbe Vintage — server invoice engine');
  pdf.setCreationDate(new Date());
  const renderer = new Renderer(pdf, font, model.accent ?? { r: 0.76, g: 0.38, b: 0.23 });
  renderer.header(model);
  for (const section of model.sections) renderer.section(section);
  renderer.finish(model);
  return pdf.save();
}

/** Render a report table (used by the report centre and the aging/statement exports). */
export async function renderTablePdf(input: {
  title: string; subtitle?: string; columns: PdfColumn[]; rows: Array<Record<string, string>>;
  totals?: Array<{ label: string; value: string }>; footerText?: string;
}): Promise<Uint8Array> {
  return renderPdf({
    title: input.title,
    subtitle: input.subtitle,
    footerText: input.footerText,
    sections: [
      { type: 'table', columns: input.columns, rows: input.rows },
      ...(input.totals?.length ? [{ type: 'totals' as const, rows: input.totals }] : []),
    ],
  });
}
