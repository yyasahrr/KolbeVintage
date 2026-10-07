/* TEMP §19 helper: rasterize a PDF through pdf.js inside headless Chrome for visual QA. */
import { readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const pdfPath = process.argv[2] ?? '/tmp/invoice.pdf';
const outPrefix = process.argv[3] ?? '/tmp/pdf-page';
const pdfjs = readFileSync('/tmp/qa-browser/node_modules/pdfjs-dist/build/pdf.mjs', 'utf8');
const worker = readFileSync('/tmp/qa-browser/node_modules/pdfjs-dist/build/pdf.worker.mjs', 'utf8');
const data = readFileSync(pdfPath).toString('base64');

const browser = await puppeteer.launch({ executablePath: process.env.KV_CHROME_PATH ?? '/tmp/chromium', headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'] });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
const pages = await page.evaluate(async (pdfjsSrc, workerSrc, b64) => {
  const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const lib = await import(blobUrl(pdfjsSrc));
  lib.GlobalWorkerOptions.workerSrc = blobUrl(workerSrc);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const doc = await lib.getDocument({ data: bytes }).promise;
  const shots = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const p = await doc.getPage(n);
    const viewport = p.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await p.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    shots.push(canvas.toDataURL('image/png'));
  }
  return shots;
}, pdfjs, worker, data);
pages.forEach((dataUrl, i) => writeFileSync(`${outPrefix}-${i + 1}.png`, Buffer.from(dataUrl.split(',')[1], 'base64')));
console.log(`rendered ${pages.length} page(s) → ${outPrefix}-N.png`);
await browser.close();
