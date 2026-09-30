/* PDF inspection helpers used by the automated verification of generated
 * financial documents. pdf-lib writes the page, font and ToUnicode dictionaries
 * into a compressed object stream, so a naive text scan is not enough: we walk
 * every object, inflate the streams and decode the 16-bit CIDs through the
 * embedded ToUnicode CMap — exactly what a PDF reader would do.
 */
import { inflateSync } from 'node:zlib';

export type PdfObject = { number: number; body: string; stream?: Buffer; inflated?: string };

function inflate(buffer: Buffer): string | undefined {
  try { return inflateSync(buffer).toString('latin1'); } catch {
    try { return inflateSync(buffer, { finishFlush: 2 }).toString('latin1'); } catch { return undefined; }
  }
}

/** Split the file into its indirect objects, inflating every Flate stream. */
export function readObjects(pdf: Uint8Array): PdfObject[] {
  const text = Buffer.from(pdf).toString('latin1');
  const objects: PdfObject[] = [];
  const pattern = /(\d+)\s+0\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const number = Number(match[1]);
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) continue;
    const raw = text.slice(start, end);
    const streamIndex = raw.indexOf('stream');
    const object: PdfObject = { number, body: streamIndex < 0 ? raw : raw.slice(0, streamIndex) };
    if (streamIndex >= 0) {
      let from = streamIndex + 'stream'.length;
      if (raw[from] === '\r') from++;
      if (raw[from] === '\n') from++;
      const to = raw.lastIndexOf('endstream');
      const lengthMatch = /\/Length\s+(\d+)/.exec(object.body);
      const declared = lengthMatch ? Number(lengthMatch[1]) : -1;
      const sliceEnd = declared > 0 && from + declared <= to ? from + declared : to;
      object.stream = Buffer.from(raw.slice(from, sliceEnd), 'latin1');
      object.inflated = inflate(object.stream);
    }
    objects.push(object);
  }
  return objects;
}

const hexToChar = (hex: string) => {
  const value = Number.parseInt(hex, 16);
  if (value > 0x10ffff) return (hex.match(/../g) ?? []).map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join('');
  return String.fromCodePoint(value);
};

/** Parse `beginbfchar`/`beginbfrange` sections of a ToUnicode CMap. */
export function parseCMap(cmap: string): Map<number, string> {
  const mapping = new Map<number, string>();
  for (const match of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const body = match[1] ?? '';
    for (const [, src, dst] of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      mapping.set(Number.parseInt(src!, 16), hexToChar(dst!));
    }
  }
  for (const match of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = match[1] ?? '';
    for (const [, start, end, dst] of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const first = Number.parseInt(start!, 16);
      const last = Number.parseInt(end!, 16);
      const target = Number.parseInt(dst!, 16);
      for (let code = first; code <= last; code++) mapping.set(code, String.fromCodePoint(target + (code - first)));
    }
  }
  return mapping;
}

/** The text drawn on the page, decoded back to Unicode through the CMap. */
export function extractPdfText(pdf: Uint8Array): string {
  const objects = readObjects(pdf);
  const cmapText = objects.map((object) => object.inflated).find((value) => value?.includes('beginbfchar') || value?.includes('beginbfrange'));
  const mapping = cmapText ? parseCMap(cmapText) : new Map<number, string>();
  const lines: string[] = [];
  for (const object of objects) {
    const content = object.inflated;
    if (!content || (!content.includes(' Tj') && !content.includes(' TJ'))) continue;
    for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
      let line = '';
      for (const [, hex] of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*(?:Tj|TJ)/g)) {
        for (let index = 0; index + 4 <= hex!.length; index += 4) {
          const code = Number.parseInt(hex!.slice(index, index + 4), 16);
          line += mapping.get(code) ?? '?';
        }
      }
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

export type PdfStructure = {
  pageCount: number;
  embeddedFont: boolean;
  a4: boolean;
  drawings: number;
  producers: string[];
};

export function pdfStructure(pdf: Uint8Array): PdfStructure {
  const text = Buffer.from(pdf).toString('latin1');
  const objects = readObjects(pdf);
  const dictionaryText = [text, ...objects.map((object) => object.inflated ?? '')].join('\n');
  const pageCount = (dictionaryText.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
  const producers = [...dictionaryText.matchAll(/\/Producer\s*\(([^)]*)\)/g)].map((match) => match[1] ?? '');
  return {
    pageCount,
    embeddedFont: /\/FontFile2/.test(dictionaryText),
    a4: /\/MediaBox\s*\[\s*0\s+0\s+595\.2[0-9]*\s+841\.8[0-9]*\s*\]/.test(dictionaryText),
    drawings: (objects.map((object) => object.inflated ?? '').join('\n').match(/ Tj\b/g) ?? []).length,
    producers,
  };
}
