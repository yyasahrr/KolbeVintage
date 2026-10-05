/* STATIC RESPONSIVE LINT — Prompt-1 product surfaces.
   Complements (does NOT replace) the browser sweep in qa-product-studio.mjs §40: when no
   Chromium binary is available in the environment, this gate still catches the single most
   common cause of document horizontal overflow at 360px — a fixed/minimum width that is NOT
   wrapped in a horizontal scroll container.

   Rule: any `min-w-[Npx]` / `w-[Npx]` with N >= 320 must sit inside (within LOOKBACK lines of)
   an `overflow-x-auto` / `kv-scroll-x` wrapper, or be a modal `max-w-[Npx]` (modals clamp with
   `w-full max-w-[…]` plus `p-4`, so they never push the document wider than the viewport).

   Run: cd backend && node scripts/qa-responsive-static.mjs */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const FILES = [
  'src/components/kolbe-products-hub.tsx',
  'src/components/initial-inventory-workspace.tsx',
  'src/components/product-360.tsx',
  'src/components/product-inventory.tsx',
  'src/portals/admin-product.tsx',
  'src/portals/admin.tsx',
  'src/portals/warehouse-hub.tsx',
  /* Prompt-1 final pass: the merged specs + size-guide step renders the shared table editor. */
  'src/components/dynamic-table-editor.tsx',
  /* Unified Studio delta: the embedded discount/festival editor and the structure manager are
     heavy surfaces — they must not push the document wider than a 360px viewport either. */
  'src/components/product-pricing-panel.tsx',
  'src/components/product-structure-panel.tsx',
  'src/components/product-series-editor.tsx',
  /* Prompt-4: the Wholesale Order Center (list + full-page detail workspace), the Orders Hub that
     hosts it and the VIP buyer order surface are wide tables/grids — same 360px no-overflow rule. */
  'src/portals/wholesale-order-center.tsx',
  'src/portals/orders-hub.tsx',
  'src/portals/vip.tsx',
];
const LOOKBACK = 6;
const MIN_PX = 320;
const WRAPPER = /overflow-x-auto|kv-scroll-x|overflow-x:\s*auto|overflow-auto/;
/* `max-w-[…]` on a Modal/Drawer clamps instead of pushing; `max-w-[…]` elsewhere is fine too. */
const CLAMPED = /max-w-\[\d+px\]|w-full|flex-1|max-w-full/;

const findings = [];
let scanned = 0;
for (const rel of FILES) {
  let src;
  try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { findings.push({ rel, line: 0, text: 'FILE NOT FOUND' }); continue; }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:min-)?w-\[(\d+)px\]/g)) {
      const px = Number(m[1]);
      if (px < MIN_PX) continue;
      scanned += 1;
      if (CLAMPED.test(line) && !/min-w-\[\d+px\]/.test(line)) continue;
      const window = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join('\n');
      if (WRAPPER.test(window)) continue;
      findings.push({ rel, line: i + 1, text: line.trim().slice(0, 120), px });
    }
  });
}

console.log(`static responsive lint — ${FILES.length} Prompt-1/Prompt-4 surfaces, ${scanned} fixed/min widths ≥ ${MIN_PX}px inspected`);
if (findings.length === 0) {
  console.log('PASS  every wide element is inside a horizontal scroll container or clamps with w-full/max-w');
} else {
  for (const f of findings) console.log(`FAIL  ${f.rel}:${f.line} — ${f.px}px unwrapped :: ${f.text}`);
}
console.log(`\n${findings.length === 0 ? 1 : 0}/1 PASS`);
process.exit(findings.length === 0 ? 0 : 1);
