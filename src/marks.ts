// Marks: underlines under words printed in a picture (image scenes' "marks"), found by OCR (tesseract.js). Each picture
// is drawn at its natural size in headless Chromium (so PNG, JPEG, WebP and SVG all work), then read twice: gray, and
// inverted gray at 2x, so light-on-dark text reads too. Words are cached per picture in build/ocr/; the boxes go to
// build/marks.json as { "<src>|<text>": one box per printed line, as fractions of the picture }. OCR misreads a
// letter here and there, so words match by similarity; if a phrase still isn't found, give the mark a "box" by hand.
// npm run render runs it; `node src/marks.ts <name>` alone shows what it finds.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createWorker, type Worker } from 'tesseract.js';
import type { MarkBox, Script } from './types.ts';

interface OcrWord { text: string; line: number; box: MarkBox }

const MIN_SCORE = 0.75; // mean word similarity for a phrase to count as found
const SCALE = 2; // OCR reads the picture at twice its size
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

/** Gray, optionally inverted, SCALE times bigger. */
function prepare(png: PNG, invert: boolean): Buffer {
  const out = new PNG({ width: png.width * SCALE, height: png.height * SCALE });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const i = (Math.floor(y / SCALE) * png.width + Math.floor(x / SCALE)) * 4;
    const g = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
    const o = (y * out.width + x) * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = invert ? 255 - g : g;
    out.data[o + 3] = 255;
  }
  return PNG.sync.write(out);
}

/** A picture file drawn at its natural size (white behind transparency), as a PNG. */
async function rasterize(file: string): Promise<Buffer> {
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`marks: can't read ${file} (PNG, JPEG, WebP or SVG)`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<body style="margin:0;background:#fff"><img id="i" src="data:${type};base64,${(await readFile(file)).toString('base64')}"></body>`);
    const size = await page.evaluate(async () => {
      const img = document.getElementById('i') as HTMLImageElement;
      await img.decode();
      return { width: img.naturalWidth || 1200, height: img.naturalHeight || 800 };
    });
    await page.setViewportSize(size);
    return await page.locator('#i').screenshot();
  } finally {
    await browser.close();
  }
}

/** The picture's words as OCR reads them, once per variant (gray, inverted gray), cached by the file's content. */
async function readPicture(worker: () => Promise<Worker>, file: string, cacheDir: string): Promise<OcrWord[][]> {
  const id = createHash('sha1').update(await readFile(file)).digest('hex').slice(0, 16);
  const cached = path.join(cacheDir, `${id}.json`);
  try { return JSON.parse(await readFile(cached, 'utf8')); } catch { /* not read yet */ }
  const png = PNG.sync.read(await rasterize(file));
  const variants: OcrWord[][] = [];
  for (const invert of [false, true]) {
    const { data } = await (await worker()).recognize(prepare(png, invert), {}, { blocks: true });
    const words: OcrWord[] = [];
    let line = 0;
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      line++;
      for (const w of l.words) {
        const { x0, y0, x1, y1 } = w.bbox;
        const [w0, h0] = [png.width * SCALE, png.height * SCALE];
        words.push({ text: w.text, line, box: { x0: x0 / w0, y0: y0 / h0, x1: x1 / w0, y1: y1 / h0 } });
      }
    }
    variants.push(words);
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cached, JSON.stringify(variants));
  return variants;
}

/**
 * The best run of consecutive words matching `phrase`, or null. An OCR word may be split in two, and specks read as
 * 1-2 character junk are skipped.
 */
function findPhrase(words: OcrWord[], phrase: string): { score: number; words: OcrWord[] } | null {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  const ws = words.filter(w => norm(w.text));
  let best: { score: number; words: OcrWord[] } | null = null;
  for (let i = 0; i < ws.length; i++) {
    let j = i, total = 0;
    const hit: OcrWord[] = [];
    for (const [k, tok] of want.entries()) {
      while (k > 0 && j + 1 < ws.length && norm(ws[j].text).length <= 2 && similarity(tok, norm(ws[j].text)) < 0.5) j++;
      if (j >= ws.length) { total = -Infinity; break; }
      const one = similarity(tok, norm(ws[j].text));
      const two = ws[j + 1]?.line === ws[j].line ? similarity(tok, norm(ws[j].text) + norm(ws[j + 1].text)) : 0;
      if (two > one) { hit.push(ws[j], ws[j + 1]); j += 2; total += two; }
      else { hit.push(ws[j]); j += 1; total += one; }
    }
    const score = total / want.length;
    if (!best || score > best.score) best = { score, words: hit };
  }
  return best && best.score >= MIN_SCORE ? best : null;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * One box per printed line the words span. OCR sometimes stretches a word's box over a flourish next to it, so each
 * word is cut to the width its letters take on that line (`all`: every word OCR read), and the line's top and bottom
 * are its words' medians.
 */
function lineBoxes(hit: OcrWord[], all: OcrWord[]): MarkBox[] {
  return [...new Set(hit.map(w => w.line))].map(line => {
    const words = hit.filter(w => w.line === line);
    const charW = median(all.filter(w => w.line === line && norm(w.text).length >= 2).map(w => (w.box.x1 - w.box.x0) / norm(w.text).length));
    return {
      x0: Math.min(...words.map(w => w.box.x0)),
      y0: median(words.map(w => w.box.y0)),
      x1: Math.max(...words.map(w => Math.min(w.box.x1, w.box.x0 + charW * w.text.trim().length * 1.25))),
      y1: median(words.map(w => w.box.y1)),
    };
  }).sort((a, b) => a.y0 - b.y0);
}

/** Finds every mark in the project's image scenes and writes build/marks.json; returns how many there are. */
export async function prepareMarks(name: string): Promise<number> {
  const dir = path.resolve('projects', name);
  const script = JSON.parse(await readFile(path.join(dir, 'script.json'), 'utf8')) as Script;
  let tesseract: Worker | undefined;
  const worker = async () => (tesseract ??= await createWorker('eng', 1, { cachePath: path.resolve('.cache', 'tesseract') }));
  const found: Record<string, MarkBox[]> = {};
  try {
    for (const scene of script.beats.map(b => b.scene)) {
      if (scene.type !== 'image' || !scene.marks?.length) continue;
      for (const mark of scene.marks) {
        const key = `${scene.src}|${mark.text}`;
        if (mark.box) { const [x0, y0, x1, y1] = mark.box; found[key] = [{ x0, y0, x1, y1 }]; continue; }
        if (/^https?:/.test(scene.src)) throw new Error(`mark "${mark.text}": OCR reads only pictures in the project folder; give it a "box"`);
        const variants = await readPicture(worker, path.join(dir, scene.src), path.join(dir, 'build', 'ocr'));
        const best = variants.map(v => ({ all: v, ...findPhrase(v, mark.text) }))
          .filter((m): m is { all: OcrWord[]; score: number; words: OcrWord[] } => m.words !== undefined)
          .sort((a, b) => b.score - a.score)[0];
        if (!best) {
          const lines = [...new Set(variants[0].map(w => w.line))].map(l => variants[0].filter(w => w.line === l).map(w => w.text).join(' '));
          throw new Error(`"${mark.text}" not found in ${scene.src} by OCR. Give the mark a "box": [x0, y0, x1, y1] (fractions of the picture). OCR read:\n  ${lines.join('\n  ')}`);
        }
        found[key] = lineBoxes(best.words, best.all);
        console.log(`mark "${mark.text}" in ${scene.src}: ${found[key].length} line(s), match ${(best.score * 100).toFixed(0)}%`);
      }
    }
  } finally {
    await tesseract?.terminate();
  }
  await mkdir(path.join(dir, 'build'), { recursive: true });
  await writeFile(path.join(dir, 'build', 'marks.json'), JSON.stringify(found, null, 2));
  return Object.keys(found).length;
}

if (process.argv[1]?.endsWith('marks.ts')) {
  const name = process.argv[2];
  if (!name) { console.error('usage: node src/marks.ts <name>'); process.exit(1); }
  prepareMarks(name).then(n => console.log(`${n} mark(s) -> projects/${name}/build/marks.json`)).catch(err => { console.error(err.message ?? err); process.exit(1); });
}
