// Renders a composition: bundles the video code, opens it in headless Chromium (Playwright) and captures every frame
// as a screenshot, several pages at once, piped in order into ffmpeg (H.264). The soundtrack is mixed separately
// (audio.ts) into a WAV, for the caller to normalize and mux.
// renderScenes renders scene by scene, like shooting a film: each scene is a clip, re-rendered only when one of its
// frames changed (by the frames' DOM fingerprints), and the clips are joined without re-encoding.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import type { VideoConfig } from './core.tsx';
import { mixAudio } from './audio.ts';
import { FFMPEG, ffmpeg } from './ffmpeg.ts';
import type { DryRun, SceneCut } from './page.tsx';
import { BUNDLE_DIR, bundle, fileOf, PAGE_CSS, serve, type Served } from './server.ts';

export interface RenderOptions {
  composition: string;
  props?: object;
  /** Pages rendering at once (default: half the CPU threads, at most 8). */
  concurrency?: number;
  crf?: number;
  jpegQuality?: number;
  log?: (line: string) => void;
}

/** Bump when frames would come out differently for the same DOM (capture or encoding changes): every clip re-renders. */
const CLIP_FORMAT = 1;

interface Session { served: Served; browser: Browser; close(): Promise<void> }

async function openSession(): Promise<Session> {
  await bundle();
  const served = await serve();
  const browser = await chromium.launch();
  return { served, browser, close: async () => { await browser.close(); await served.close(); } };
}

interface FramePage { page: Page; cdp: CDPSession; config: VideoConfig; scenes: SceneCut[] }

/** A page with the composition loaded at frame 0 and the viewport at its size. `relay`: print the page's warnings and errors. */
async function openPage(session: Session, opts: RenderOptions, relay: boolean): Promise<FramePage> {
  const page = await session.browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  const log = opts.log ?? console.log;
  if (relay) {
    page.on('console', msg => { if (msg.type() === 'warning' || msg.type() === 'error') log(`[page ${msg.type()}] ${msg.text()}`); });
    page.on('pageerror', err => log(`[page error] ${err.message}`));
  }
  await page.goto(session.served.url);
  await page.waitForFunction(() => 'engine' in window);
  const { config, scenes } = await page.evaluate(([id, props]) => window.engine.load(id, props), [opts.composition, opts.props ?? {}] as const);
  await page.setViewportSize({ width: config.width, height: config.height });
  return { page, cdp: await page.context().newCDPSession(page), config, scenes };
}

/** The first page and the rest, `concurrency` in all. */
async function openPages(session: Session, opts: RenderOptions): Promise<FramePage[]> {
  const first = await openPage(session, opts, true);
  const concurrency = Math.max(1, Math.min(first.config.durationInFrames, opts.concurrency ?? Math.min(8, Math.floor(os.cpus().length / 2))));
  return [first, ...await Promise.all(Array.from({ length: concurrency - 1 }, () => openPage(session, opts, false)))];
}

async function capture({ cdp, config }: FramePage, format: 'png' | 'jpeg', quality?: number): Promise<Buffer> {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format, quality: format === 'jpeg' ? quality : undefined, clip: { x: 0, y: 0, width: config.width, height: config.height, scale: 1 },
    captureBeyondViewport: false, optimizeForSpeed: true,
  });
  return Buffer.from(data, 'base64');
}

const drawFrame = (p: FramePage, n: number) => p.page.evaluate(f => window.engine.frame(f), n);
const dryRun = (p: FramePage, fingerprint: boolean): Promise<DryRun> => p.page.evaluate(f => window.engine.dryRun(f), fingerprint);

/**
 * Frames [from, to) into `output` (.mp4, no sound). Each page captures the next frame not yet taken; a page given as a
 * promise joins once it resolves (the first page may be busy with the soundtrack).
 */
async function encodeFrames(pages: Array<FramePage | Promise<FramePage>>, config: VideoConfig, from: number, to: number, output: string, opts: RenderOptions) {
  const log = opts.log ?? console.log;
  const encoder = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(config.fps), '-c:v', 'mjpeg', '-i', '-',
    // Chrome's JPEGs are full-range BT.601 YUV already: encoded as they are (and tagged so), the colours stay exact.
    // Converting to the more common limited-range BT.709 measured 1.5-2.5 levels off.
    '-c:v', 'libx264', '-crf', String(opts.crf ?? 18), '-preset', 'medium', '-pix_fmt', 'yuvj420p',
    '-colorspace', 'bt470bg', '-color_range', 'pc',
    '-movflags', '+faststart', output,
  ], { stdio: ['pipe', 'inherit', 'pipe'] });
  let encoderErr = '';
  encoder.stderr.on('data', d => { encoderErr += d; });
  const encoded = once(encoder, 'exit');

  // Frames finish out of order; they're written in order.
  const finished = new Map<number, Buffer>();
  let written = from;
  let writing = Promise.resolve();
  const flush = () => {
    writing = writing.then(async () => {
      while (finished.has(written)) {
        const frame = finished.get(written)!;
        finished.delete(written++);
        if (!encoder.stdin.write(frame)) await once(encoder.stdin, 'drain');
      }
    });
  };

  const started = Date.now();
  let next = from, lastLog = started;
  const work = async (pending: FramePage | Promise<FramePage>) => {
    const p = await pending;
    for (let n = next++; n < to; n = next++) {
      await drawFrame(p, n);
      finished.set(n, await capture(p, 'jpeg', opts.jpegQuality ?? 90));
      flush();
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        log(`  frame ${written}/${to}, ${((written - from) / ((lastLog - started) / 1000)).toFixed(1)} fps`);
      }
    }
  };
  await Promise.all(pages.map(work));
  await writing;
  encoder.stdin.end();
  const [code] = await encoded;
  if (code !== 0) throw new Error(`ffmpeg failed encoding ${output}\n${encoderErr}`);
  return (Date.now() - started) / 1000;
}

/** One frame as a PNG or JPEG. */
export async function renderStill(opts: RenderOptions & { output: string; frame?: number; format?: 'png' | 'jpeg'; quality?: number }): Promise<VideoConfig> {
  const session = await openSession();
  try {
    const p = await openPage(session, opts, true);
    const frame = opts.frame ?? 0;
    if (frame < 0 || frame >= p.config.durationInFrames) throw new Error(`frame ${frame} is outside ${opts.composition} (0-${p.config.durationInFrames - 1})`);
    if (frame) await drawFrame(p, frame);
    await writeFile(opts.output, await capture(p, opts.format ?? 'png', opts.quality ?? 92));
    return p.config;
  } finally {
    await session.close();
  }
}

/**
 * A contact sheet (PNG): one frame of each scene, 70% into it (or the given frames), labelled, in a grid. A whole
 * video at a glance in seconds, to check layouts before rendering.
 */
export async function renderSheet(opts: RenderOptions & { output: string; frames?: number[] }) {
  const session = await openSession();
  try {
    const p = await openPage(session, opts, true);
    const { config, scenes } = p;
    const { fps, width, height, durationInFrames: total } = config;
    const at = (f: number) => `${(f / fps).toFixed(1)}s`;
    const cells = opts.frames
      ? opts.frames.map(f => ({ frame: Math.max(0, Math.min(total - 1, f)), label: `frame ${f} · ${at(f)}` }))
      : scenes.map((s, i) => {
        const to = scenes[i + 1]?.from ?? total;
        const frame = Math.min(to - 1, s.from + Math.round(0.7 * (to - s.from)));
        return { frame, label: `${s.id} · ${at(frame)}` };
      });
    const shape = height > width ? 'portrait' : width === height ? 'square' : 'wide';
    const cols = Math.min(cells.length, { portrait: 6, square: 4, wide: 3 }[shape]);
    const cellWidth = { portrait: 360, square: 480, wide: 640 }[shape];
    const size = await p.page.evaluate(([c, n, w]) => window.engine.sheet(c, n, w), [cells, cols, cellWidth] as const);
    await p.page.setViewportSize(size);
    const { data } = await p.cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...size, scale: 1 }, captureBeyondViewport: false });
    await writeFile(opts.output, Buffer.from(data, 'base64'));
    return { config, cells };
  } finally {
    await session.close();
  }
}

/**
 * The video, without sound, to `output` (.mp4), and its soundtrack to `audioOutput` (.wav). Returns the composition's
 * config and whether there was any audio.
 */
export async function renderVideo(opts: RenderOptions & { output: string; audioOutput: string }) {
  const log = opts.log ?? console.log;
  const session = await openSession();
  try {
    const pages = await openPages(session, opts);
    const [first] = pages;
    const { config } = first;
    log(`${opts.composition}: ${config.durationInFrames} frames at ${config.width}x${config.height}, ${config.fps} fps, ${pages.length} pages`);
    // The first page works out the soundtrack while the others start on the frames.
    let hasAudio = false;
    const firstReady = dryRun(first, false).then(async ({ tracks }) => {
      hasAudio = await mixAudio(tracks, config.fps, config.durationInFrames, opts.audioOutput);
      return first;
    });
    const seconds = await encodeFrames([firstReady, ...pages.slice(1)], config, 0, config.durationInFrames, opts.output, opts);
    log(`  ${config.durationInFrames} frames in ${seconds.toFixed(1)}s`);
    return { config, hasAudio };
  } finally {
    await session.close();
  }
}

export interface SceneResult { id: string; from: number; to: number; rendered: boolean }

/**
 * Scene by scene: each scene's clip goes to `dir` (named by a fingerprint of everything that decides its pixels: its
 * frames' DOM, the files they show, the bundle's assets, Chromium, the encoder settings), so a scene is re-rendered
 * only when something in it changed, and a scene that only moved in time is reused. `force`: scene ids to re-render
 * anyway ('all' for every one). The clips are joined into `output` without re-encoding; the soundtrack is mixed
 * whole into `audioOutput`, so music and ducking never seam at a cut. Clips no scene uses any more are deleted.
 */
export async function renderScenes(opts: RenderOptions & { output: string; audioOutput: string; dir: string; force?: string[] | 'all' }) {
  const log = opts.log ?? console.log;
  const session = await openSession();
  try {
    const pages = await openPages(session, opts);
    const [first] = pages;
    const { config, scenes: cuts } = first;
    const total = config.durationInFrames;
    const unknown = opts.force === 'all' ? [] : (opts.force ?? []).filter(id => !cuts.some(c => c.id === id));
    if (unknown.length) throw new Error(`no scene ${unknown.join(', ')} in ${opts.composition} (${cuts.map(c => c.id).join(', ')})`);
    log(`${opts.composition}: ${total} frames at ${config.width}x${config.height}, ${config.fps} fps, ${cuts.length} scenes, ${pages.length} pages`);

    const t0 = Date.now();
    const run = await dryRun(first, true);
    const hasAudio = await mixAudio(run.tracks, config.fps, total, opts.audioOutput);
    log(`  fingerprinted ${total} frames and mixed the sound in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // What every clip depends on beyond its own frames.
    const assets = existsSync(path.join(BUNDLE_DIR, 'assets')) ? (await readdir(path.join(BUNDLE_DIR, 'assets'))).sort() : [];
    // Not the video's length: a scene that only moved (an earlier one got longer) keeps its clip.
    const { width, height, fps } = config;
    const base = JSON.stringify({ CLIP_FORMAT, chromium: session.browser.version(), PAGE_CSS, assets, crf: opts.crf ?? 18, jpeg: opts.jpegQuality ?? 90, width, height, fps });
    const fileHashes = new Map<string, string>();
    const contentOf = async (url: string) => {
      if (!fileHashes.has(url)) {
        const file = fileOf(url);
        const bytes = file ? await readFile(file).catch(() => null) : null;
        fileHashes.set(url, bytes ? createHash('sha1').update(bytes).digest('hex') : 'missing');
      }
      return fileHashes.get(url)!;
    };

    await mkdir(opts.dir, { recursive: true });
    const results: Array<SceneResult & { file: string }> = [];
    for (const [i, cut] of cuts.entries()) {
      const from = cut.from, to = cuts[i + 1]?.from ?? total;
      const used = run.files.filter(([, runs]) => runs.some(([a, b]) => a < to && b >= from)).map(([url]) => url).sort();
      const key = createHash('sha1').update(base).update(JSON.stringify(run.fingerprints.slice(from, to)));
      for (const url of used) key.update(`${url}=${await contentOf(url)}`);
      const file = path.join(opts.dir, `${key.digest('hex').slice(0, 20)}.mp4`);
      const rendered = !existsSync(file) || opts.force === 'all' || !!opts.force?.includes(cut.id);
      if (rendered) {
        const seconds = await encodeFrames(pages, config, from, to, file + '.part.mp4', opts);
        await rename(file + '.part.mp4', file);
        log(`  scene ${cut.id}: ${to - from} frames rendered in ${seconds.toFixed(1)}s`);
      } else {
        log(`  scene ${cut.id}: unchanged`);
      }
      results.push({ id: cut.id, from, to, rendered, file });
    }

    // Join, then drop clips no scene uses.
    const list = path.join(opts.dir, 'join.txt');
    await writeFile(list, results.map(r => `file '${r.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', opts.output]);
    const keep = new Set(results.map(r => path.basename(r.file)));
    for (const name of await readdir(opts.dir)) {
      if (name.endsWith('.mp4') && !keep.has(name)) await rm(path.join(opts.dir, name));
    }
    return { config, hasAudio, scenes: results.map(({ file, ...r }) => r) };
  } finally {
    await session.close();
  }
}
