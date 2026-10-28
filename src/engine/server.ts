// Bundles the project's video code with esbuild and serves it: the page at /, the bundle at /bundle/, and the public
// folder (projects/) at /static/ (staticFile() URLs).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as esbuild from 'esbuild';

/** This project's video entry (it calls registerRoot) and the folder staticFile() reads from. */
export const ENTRY = path.resolve('src', 'video', 'index.ts');
export const PUBLIC_DIR = path.resolve('projects');
export const BUNDLE_DIR = path.resolve('.cache', 'engine', 'bundle');

export const buildOptions = (outdir = BUNDLE_DIR): esbuild.BuildOptions => ({
  entryPoints: { index: ENTRY },
  bundle: true,
  outdir,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  loader: { '.png': 'file', '.jpg': 'file', '.webp': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.wav': 'file', '.mp3': 'file' },
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/bundle',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  logLevel: 'warning',
});

export async function bundle(outdir = BUNDLE_DIR) {
  await esbuild.build(buildOptions(outdir));
}

/** The page's own CSS (layouts rely on border-box). */
export const PAGE_CSS = '* { box-sizing: border-box; } html, body { margin: 0; padding: 0; overflow: hidden; }';

const page = (title: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${PAGE_CSS}</style></head>
<body><div id="root"></div><script type="module" src="/bundle/index.js"></script></body></html>`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

/** The file behind a served URL (/static/... or /bundle/...), or null when it's outside those folders. */
export function fileOf(url: string, bundleDir = BUNDLE_DIR): string | null {
  const pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  const [root, rest] = pathname.startsWith('/static/') ? [PUBLIC_DIR, pathname.slice(8)]
    : pathname.startsWith('/bundle/') ? [bundleDir, pathname.slice(8)] : [null, ''];
  if (!root) return null;
  const file = path.resolve(root, rest);
  return file.startsWith(root + path.sep) ? file : null;
}

/** Sends a file, with byte ranges (the studio's audio player seeks with them). */
export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) { res.writeHead(404).end('not found'); return; }
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  createReadStream(file).pipe(res);
}

export interface Served { url: string; close(): Promise<void> }

/** Serves the page and files; `extra` handles other routes first (return true when it answered). */
export function serve({ bundleDir = BUNDLE_DIR, host = '127.0.0.1', port = 0, title = 'video', extra }: {
  bundleDir?: string; host?: string; port?: number; title?: string;
  extra?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
} = {}): Promise<Served> {
  const server = createServer(async (req, res) => {
    try {
      if (extra && await extra(req, res)) return;
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/') { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }).end(page(title)); return; }
      const file = fileOf(req.url ?? '/', bundleDir);
      if (!file) { res.writeHead(404).end('not found'); return; }
      await sendFile(req, res, file);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address() as AddressInfo;
      resolve({ url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
