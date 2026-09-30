/* Arabic/Persian text shaping + minimal bidi reordering for server-side PDF rendering.
 *
 * The renderer draws text left-to-right with a single embedded font, so every
 * Persian string must be converted to its contextual presentation forms
 * (Arabic Presentation Forms-B, U+FE70–U+FEFF) and RTL runs must be reversed
 * before they reach the PDF content stream.
 *
 * This module contains no font-specific logic and executes no dynamic code: it
 * is a pure, table-driven transform over the input string.
 */

type Forms = { iso: number; fin?: number; init?: number; med?: number };
type Joining = 'dual' | 'right' | 'none';

const F = (iso: number, fin?: number, init?: number, med?: number): Forms => ({ iso, fin, init, med });

/** Contextual presentation forms for the letters used in Persian/Arabic text. */
export const LETTER_FORMS: Record<number, Forms> = {
  0x0621: F(0xfe80),                                                        // hamza
  0x0622: F(0xfe81, 0xfe82),                                                // alef madda
  0x0623: F(0xfe83, 0xfe84),                                                // alef hamza above
  0x0624: F(0xfe85, 0xfe86),                                                // waw hamza
  0x0625: F(0xfe87, 0xfe88),                                                // alef hamza below
  0x0626: F(0xfe89, 0xfe8a, 0xfe8b, 0xfe8c),                                // yeh hamza
  0x0627: F(0xfe8d, 0xfe8e),                                                // alef
  0x0628: F(0xfe8f, 0xfe90, 0xfe91, 0xfe92),                                // beh
  0x0629: F(0xfe93, 0xfe94),                                                // teh marbuta
  0x062a: F(0xfe95, 0xfe96, 0xfe97, 0xfe98),                                // teh
  0x062b: F(0xfe99, 0xfe9a, 0xfe9b, 0xfe9c),                                // theh
  0x062c: F(0xfe9d, 0xfe9e, 0xfe9f, 0xfea0),                                // jeem
  0x062d: F(0xfea1, 0xfea2, 0xfea3, 0xfea4),                                // hah
  0x062e: F(0xfea5, 0xfea6, 0xfea7, 0xfea8),                                // khah
  0x062f: F(0xfea9, 0xfeaa),                                                // dal
  0x0630: F(0xfeab, 0xfeac),                                                // thal
  0x0631: F(0xfead, 0xfeae),                                                // reh
  0x0632: F(0xfeaf, 0xfeb0),                                                // zain
  0x0633: F(0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4),                                // seen
  0x0634: F(0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8),                                // sheen
  0x0635: F(0xfeb9, 0xfeba, 0xfebb, 0xfebc),                                // sad
  0x0636: F(0xfebd, 0xfebe, 0xfebf, 0xfec0),                                // dad
  0x0637: F(0xfec1, 0xfec2, 0xfec3, 0xfec4),                                // tah
  0x0638: F(0xfec5, 0xfec6, 0xfec7, 0xfec8),                                // zah
  0x0639: F(0xfec9, 0xfeca, 0xfecb, 0xfecc),                                // ain
  0x063a: F(0xfecd, 0xfece, 0xfecf, 0xfed0),                                // ghain
  0x0641: F(0xfed1, 0xfed2, 0xfed3, 0xfed4),                                // feh
  0x0642: F(0xfed5, 0xfed6, 0xfed7, 0xfed8),                                // qaf
  0x0643: F(0xfed9, 0xfeda, 0xfedb, 0xfedc),                                // kaf
  0x0644: F(0xfedd, 0xfede, 0xfedf, 0xfee0),                                // lam
  0x0645: F(0xfee1, 0xfee2, 0xfee3, 0xfee4),                                // meem
  0x0646: F(0xfee5, 0xfee6, 0xfee7, 0xfee8),                                // noon
  0x0647: F(0xfee9, 0xfeea, 0xfeeb, 0xfeec),                                // heh
  0x0648: F(0xfeed, 0xfeee),                                                // waw
  0x0649: F(0xfeef, 0xfef0),                                                // alef maksura
  0x064a: F(0xfef1, 0xfef2, 0xfef3, 0xfef4),                                // yeh
  0x0679: F(0xfb66, 0xfb67, 0xfb68, 0xfb69),                                // tteh
  0x067e: F(0xfb58, 0xfb59, 0xfb5a, 0xfb5b),                                // peh (پ)
  0x0686: F(0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d),                                // tcheh (چ)
  0x0688: F(0xfb88, 0xfb89),                                                // ddal
  0x0698: F(0xfb8a, 0xfb8b, 0xfb8c, 0xfb8d),                                // jeh (ژ)
  0x06a9: F(0xfb8e, 0xfb8f, 0xfb90, 0xfb91),                                // keheh (ک)
  0x06af: F(0xfb92, 0xfb93, 0xfb94, 0xfb95),                                // gaf (گ)
  0x06ba: F(0xfb9e, 0xfb9f),                                                // noon ghunna
  0x06be: F(0xfbaa, 0xfbab, 0xfbac, 0xfbad),                                // heh doachashmee
  0x06c0: F(0xfba4, 0xfba5),                                                // heh with yeh above
  0x06c1: F(0xfba6, 0xfba7, 0xfba8, 0xfba9),                                // heh goal
  0x06cc: F(0xfbfc, 0xfbfd, 0xfbfe, 0xfbff),                                // farsi yeh (ی)
  0x06d2: F(0xfbae, 0xfbaf),                                                // yeh barree
  0x06d3: F(0xfbb0, 0xfbb1),                                                // yeh barree with hamza
};

/** Alef-like letters that form a mandatory ligature with a preceding lam. */
const LAM_ALEF: Record<number, { iso: number; fin: number }> = {
  0x0622: { iso: 0xfef5, fin: 0xfef6 },
  0x0623: { iso: 0xfef7, fin: 0xfef8 },
  0x0625: { iso: 0xfef9, fin: 0xfefa },
  0x0627: { iso: 0xfefb, fin: 0xfefc },
};

const LAM = 0x0644;
const ZWNJ = 0x200c;
const TATWEEL = 0x0640;

/** Harakat (diacritics) are transparent for joining: they never break a connection. */
const isTransparent = (code: number) => (code >= 0x064b && code <= 0x065f) || code === 0x0670 || code === 0x06d6 || code === 0x06dc;

const isArabic = (code: number) =>
  (code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f) || (code >= 0xfb50 && code <= 0xfeff);

/** Digits (ASCII, Arabic-Indic, Extended Arabic-Indic) always read left-to-right. */
const isDigit = (code: number) =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x0660 && code <= 0x0669) || (code >= 0x06f0 && code <= 0x06f9);

/** Arabic punctuation / separators are neutral for bidi purposes. */
const NEUTRAL_ARABIC = new Set([0x060c, 0x061b, 0x061f, 0x066a, 0x066b, 0x066c, 0x066d, 0x06d4]);

/** A character that carries Arabic direction (letters and their presentation forms). */
const isArabicLetter = (code: number) => isArabic(code) && !isDigit(code) && !NEUTRAL_ARABIC.has(code) && !isTransparent(code);

const canJoin = (code: number): Joining => {
  if (code === TATWEEL) return 'dual';
  const forms = LETTER_FORMS[code];
  if (!forms) return 'none';
  if (forms.init !== undefined) return 'dual';
  return forms.fin !== undefined ? 'right' : 'none';
};

/**
 * Convert a logical-order Arabic/Persian string into its contextual forms.
 * ZWNJ (نیم‌فاصله) is removed but keeps the two letters unconnected.
 * Returns the logically ordered shaped string (caller applies bidi reordering).
 */
export function shapeLogical(input: string): string {
  const codes = [...input].map((char) => char.codePointAt(0) ?? 0);
  const output: number[] = [];
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === ZWNJ) continue;
    if (isTransparent(code)) { output.push(code); continue; }

    const previous = findNeighbour(codes, index, -1);
    const next = findNeighbour(codes, index, 1);
    const joinsPrevious = previous !== null && canJoin(previous) === 'dual' && canJoin(code) !== 'none';
    const joinsNext = canJoin(code) === 'dual' && next !== null && canJoin(next) !== 'none';

    // Mandatory lam-alef ligature (one glyph replaces both letters).
    if (code === LAM && next !== null && LAM_ALEF[next] && joinsNext) {
      const ligature = LAM_ALEF[next]!;
      output.push(joinsPrevious ? ligature.fin : ligature.iso);
      index = skipTransparent(codes, index + 1) - 1; // consume the alef (and its harakat)
      continue;
    }

    const forms = LETTER_FORMS[code];
    if (!forms) { output.push(code); continue; }
    const glyph = joinsPrevious && joinsNext ? forms.med
      : joinsPrevious ? forms.fin
        : joinsNext ? forms.init
          : forms.iso;
    output.push(glyph ?? forms.iso);
  }
  return String.fromCodePoint(...output);
}

function findNeighbour(codes: number[], index: number, step: number): number | null {
  for (let cursor = index + step; cursor >= 0 && cursor < codes.length; cursor += step) {
    const code = codes[cursor]!;
    if (isTransparent(code)) continue;
    if (code === ZWNJ) return null; // a zero-width non-joiner deliberately breaks the connection
    return code;
  }
  return null;
}

function skipTransparent(codes: number[], index: number): number {
  let cursor = index;
  while (cursor < codes.length && isTransparent(codes[cursor]!)) cursor++;
  return cursor;
}

type Run = { text: string; rtl: boolean; separator?: boolean };

/** Split a logical string into directional runs (minimal bidi: Arabic vs. everything else). */
export function directionalRuns(input: string): Run[] {
  const chars = [...input].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    // Numbers keep their own left-to-right run even inside Persian text.
    const dir: 'rtl' | 'ltr' | 'neutral' = isArabicLetter(code) ? 'rtl'
      : isDigit(code) || /[\p{L}\p{N}]/u.test(char) ? 'ltr' : 'neutral';
    return { char, dir };
  });
  const runs: Run[] = [];
  let index = 0;
  while (index < chars.length) {
    const item = chars[index]!;
    if (item.dir !== 'neutral') {
      const rtl = item.dir === 'rtl';
      const last = runs[runs.length - 1];
      if (last && !last.separator && last.rtl === rtl) last.text += item.char;
      else runs.push({ text: item.char, rtl });
      index++;
      continue;
    }
    let next = index;
    while (next < chars.length && chars[next]!.dir === 'neutral') next++;
    const text = chars.slice(index, next).map((entry) => entry.char).join('');
    const before = runs[runs.length - 1];
    const after = next < chars.length ? chars[next]!.dir : null;
    const beforeDir = before ? (before.rtl ? 'rtl' : 'ltr') : null;
    if (!before || before.separator || after === null || beforeDir === after) {
      // Same direction on both sides (or an edge): the neutral belongs to the neighbour.
      if (before && !before.separator) before.text += text;
      else runs.push({ text, rtl: after !== 'ltr' });
    } else {
      // A separator between two different directions must stay between them in visual order.
      runs.push({ text, rtl: beforeDir === 'rtl', separator: true });
    }
    index = next;
  }
  return runs;
}

const MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<',
};

/** Reverse a run while keeping combining marks attached to their base letter. */
function reverseClusters(codes: number[]): number[] {
  const clusters: number[][] = [];
  for (const code of codes) {
    const last = clusters[clusters.length - 1];
    if (isTransparent(code) && last) last.push(code);
    else clusters.push([code]);
  }
  return clusters.reverse().flat();
}


/**
 * Paragraph base direction: Persian documents are RTL, so any Arabic-script
 * letter *or* Arabic-Indic digit makes the paragraph RTL. Latin-only strings
 * (codes, amounts) keep an LTR base and are left untouched.
 */
function baseRtlOf(runs: Run[]): boolean {
  if (runs.some((run) => run.rtl)) return true;
  return runs.some((run) => [...run.text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code >= 0x0660 && code <= 0x0669) || (code >= 0x06f0 && code <= 0x06f9);
  }));
}

/**
 * Visual-order rendering string — the order in which a PDF text operator must
 * place the glyphs so the line reads correctly left-to-right:
 *   - Arabic runs are shaped into their contextual presentation forms and
 *     emitted last-letter-first,
 *   - the run order is reversed for an RTL paragraph (so the logically-first
 *     word ends up rightmost),
 *   - Latin/digit islands keep their own left-to-right order,
 *   - parentheses and brackets are mirrored so an RTL span still reads as (…).
 */
export function toVisual(input: string): string {
  const runs = directionalRuns(input.replace(/\r?\n/g, ' '));
  if (!baseRtlOf(runs)) return runs.map((run) => run.text).join('');
  const shaped = runs.map((run) => {
    if (!run.rtl) return [...run.text].map((char) => MIRROR[char] ?? char).join('');
    const reversed = reverseClusters([...shapeLogical(run.text)].map((char) => char.codePointAt(0) ?? 0));
    return reversed.map((code) => MIRROR[String.fromCodePoint(code)] ?? String.fromCodePoint(code)).join('');
  });
  return [...shaped].reverse().join('');
}

/** Every codepoint the shaper can emit for the given text (used by coverage tests). */
export function requiredCodepoints(input: string): Set<number> {
  const visual = toVisual(input);
  return new Set([...visual].map((char) => char.codePointAt(0) ?? 0));
}

/**
 * The string handed to the PDF text operator.
 *
 * pdf-lib encodes text through fontkit, which reverses an RTL-base string as a
 * whole (it does not run a full bidi pass). Handing it the exact reverse of the
 * visual order therefore lands on the correct rendering — Latin codes and
 * numbers come back in their own left-to-right order, Persian in visual order.
 */
export function toPdfString(input: string): string {
  const runs = directionalRuns(input.replace(/\r?\n/g, ' '));
  const visual = toVisual(input);
  if (!baseRtlOf(runs)) return visual;
  return reverseClusters([...visual].map((char) => char.codePointAt(0) ?? 0))
    .map((code) => String.fromCodePoint(code)).join('');
}
