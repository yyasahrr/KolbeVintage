import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { formatJalali, formatRial, renderPdf, renderTablePdf } from './pdf.js';
import { extractPdfText, pdfStructure, readObjects } from './pdf-inspect.js';
import { requiredCodepoints, toPdfString, toVisual } from './shaping.js';
import { buildCsv, buildXlsx } from './xlsx.js';

const samples = [
  'سلام',
  'فاکتور فروش عمده',
  'کت کرم پشمی — سایز ۳۲',
  'مبلغ ۱۰۰٬۰۰۰ ریال',
  'تاریخ ۱۴۰۵/۰۷/۰۷ — شماره INV-2026-000123',
  '۰۹۱۲۳۴۵۶۷۸۹',
  'خریدار: خانم زهرا محمدی (VIP)',
  'می‌رود Ž در دسترس نیست؟',
];

test('Persian shaping keeps RTL text joined and LTR codes intact', async () => {
  // Persian words are shaped into their contextual presentation forms.
  const shaped = toVisual('سلام');
  assert.match(shaped, /[\uFE70-\uFEFF]/u, 'شکل‌های فارسی تولید شده‌اند');
  assert.equal(shaped, 'ﻡﺎﻼﺳ');
  // Latin codes / numbers stay in their own left-to-right order.
  assert.equal(toVisual('شماره INV-2026-000123'), 'INV-2026-000123 ﻩﺭﺎﻤﺷ');
  assert.equal(toVisual('کد KV-12'), 'KV-12 ﺪﮐ');
  // Persian digits are never mirrored.
  assert.equal(toVisual('۱۴۰۵/۰۷/۰۷'), '۱۴۰۵/۰۷/۰۷');
  assert.equal(toVisual('۰۹۱۲۳۴۵۶۷۸۹'), '۰۹۱۲۳۴۵۶۷۸۹');
  // ZWNJ only breaks the join and leaves no glyph behind.
  const zwnj = toVisual('می‌رود');
  assert.equal(zwnj.includes('\u200c'), false);
  // The PDF string is the exact reverse: fontkit's own RTL reversal lands on `toVisual`.
  assert.equal(toPdfString('شماره INV-2026-000123'), [...toVisual('شماره INV-2026-000123')].reverse().join(''));
});

test('every codepoint the shaper emits exists in the embedded font', async () => {
  const font = fontkit.create(await readFile(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url)));
  const missing = new Set<number>();
  for (const sample of samples) {
    for (const code of requiredCodepoints(sample)) {
      if (!font.hasGlyphForCodePoint(code)) missing.add(code);
    }
  }
  assert.deepEqual([...missing].map((code) => code.toString(16)), [], 'همه نویسه‌ها در فونت موجودند');
});

test('renders an A4 PDF whose extracted text matches the visual order', async () => {
  for (const sample of samples) {
    const pdf = await renderPdf({ title: sample, sections: [] });
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString('latin1'), '%PDF-');
    const structure = pdfStructure(pdf);
    assert.equal(structure.a4, true, `A4 expected for ${sample}`);
    assert.equal(structure.embeddedFont, true);
    assert.equal(structure.pageCount, 1);
    assert.equal(extractPdfText(pdf).split('\n')[0], toVisual(sample), `visual order mismatch for ${sample}`);
  }
});

test('table documents draw headers, rows and totals', async () => {
  const pdf = await renderTablePdf({
    title: 'گزارش تسویه تأمین‌کنندگان',
    subtitle: 'بازه ۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۳۰',
    columns: [
      { key: 'supplier', label: 'تأمین‌کننده', width: 200, align: 'right' },
      { key: 'gross', label: 'ناخالص', width: 150, align: 'left' },
      { key: 'net', label: 'خالص', width: 165, align: 'left' },
    ],
    rows: [{ supplier: 'برند آوین', gross: formatRial(125000000), net: formatRial(100000000) }],
    totals: [{ label: 'جمع خالص', value: formatRial(100000000) }],
    footerText: 'کلبه وینتج',
  });
  const text = extractPdfText(pdf);
  assert.ok(text.includes(toVisual('برند آوین')));
  assert.ok(text.includes('125,000,000'.replace(/,/g, '٬')) || text.includes(toVisual('۱۲۵٬۰۰۰٬۰۰۰ ریال')));
  assert.ok(text.includes(toVisual('جمع خالص')));
  assert.equal(pdfStructure(pdf).pageCount, 1);
});

test('Jalali and Rial formatting is server-side and Persian', () => {
  assert.equal(formatRial('123456789'), '۱۲۳٬۴۵۶٬۷۸۹ ریال');
  assert.equal(formatRial(0), '۰ ریال');
  const jalali = formatJalali(new Date('2026-03-21T10:30:00.000Z'));
  assert.match(jalali, /^۱۴۰۵\/۰۱\/۰۱/, `unexpected jalali: ${jalali}`);
});

test('xlsx exports are valid OOXML archives and CSV is Excel-ready', async () => {
  const workbook = buildXlsx([{ name: 'تسویه', columns: ['مرجع', 'مبلغ'],
    rows: [['SET-2026-000001', 1200000], ['SET-2026-000002', '۲۵۰٬۰۰۰']] }]);
  assert.equal(workbook.subarray(0, 2).toString('latin1'), 'PK');
  // Inflate the local file entries and check the workbook parts are real OOXML.
  const parts = new Map<string, string>();
  let offset = 0;
  while (workbook.readUInt32LE(offset) === 0x04034b50) {
    const size = workbook.readUInt32LE(offset + 18);
    const nameLength = workbook.readUInt16LE(offset + 26);
    const extraLength = workbook.readUInt16LE(offset + 28);
    const name = workbook.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    parts.set(name, inflateRawSync(workbook.subarray(start, start + size)).toString('utf8'));
    offset = start + size;
  }
  assert.ok(parts.has('[Content_Types].xml'));
  assert.ok(parts.get('xl/worksheets/sheet1.xml')?.includes('SET-2026-000001'));
  assert.ok(parts.get('xl/worksheets/sheet1.xml')?.includes('<v>1200000</v>'), 'اعداد به صورت عددی ذخیره می‌شوند');

  const csv = buildCsv(['مرجع', 'مبلغ'], [['SET-2026-000001', 1200000], ['x,y', '"quoted"']]);
  assert.equal(csv.subarray(0, 3).toString('utf8'), '\uFEFF');
  assert.ok(csv.toString('utf8').includes('مرجع'));
  assert.ok(csv.toString('utf8').includes('\r\n'));
  assert.ok(csv.toString('utf8').includes('"x,y"'));
});

test('pdf objects are readable and text operators are present', async () => {
  const pdf = await renderPdf({ title: 'سند آزمایشی', sections: [{ type: 'paragraph', text: 'متن آزمایشی' }] });
  const objects = readObjects(pdf);
  assert.ok(objects.length >= 4);
  assert.ok(objects.some((object) => object.inflated?.includes(' Tj')));
  assert.equal(objects.some((object) => object.inflated?.includes('beginbfchar')), true, 'ToUnicode map exists');
});
