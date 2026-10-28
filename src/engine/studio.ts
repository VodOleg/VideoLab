// Studio: a live preview of the compositions in the browser. Pick one, set its props, scrub or play it with sound; the
// page reloads (keeping its place) whenever the video code changes. The player itself is player.tsx.
// Usage: npm run studio [-- --port 3000] [--host 0.0.0.0 (reachable from other devices, e.g. a phone over Tailscale)]
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { mixAudio } from './audio.ts';
import type { AudioTrack } from './page.tsx';
import { buildOptions, sendFile, serve } from './server.ts';

const STUDIO_DIR = path.resolve('.cache', 'engine', 'studio');
const AUDIO_DIR = path.resolve('.cache', 'engine', 'studio-audio');

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  await mkdir(AUDIO_DIR, { recursive: true });

  const listeners = new Set<ServerResponse>();
  const ctx = await esbuild.context({
    ...buildOptions(STUDIO_DIR),
    plugins: [{
      name: 'reload',
      setup(build) {
        build.onEnd(result => {
          if (result.errors.length) return;
          console.log(`rebuilt at ${new Date().toLocaleTimeString()}`);
          for (const res of listeners) res.write('data: reload\n\n');
        });
      },
    }],
  });
  await ctx.watch();

  const served = await serve({
    bundleDir: STUDIO_DIR, host: opt('host') ?? '127.0.0.1', port: Number(opt('port') ?? 3000), title: 'Studio',
    extra: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/' && !url.searchParams.has('studio')) {
        res.writeHead(302, { Location: '/?studio' }).end();
        return true;
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return true;
      }
      // The player's soundtrack: it sends the tracks (from its dry run over the frames), this mixes them.
      if (url.pathname === '/audio' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { tracks, fps, durationInFrames } = JSON.parse(body) as { tracks: AudioTrack[]; fps: number; durationInFrames: number };
        const name = `${createHash('sha1').update(body).digest('hex').slice(0, 16)}.wav`;
        const has = await mixAudio(tracks, fps, durationInFrames, path.join(AUDIO_DIR, name));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ url: has ? `/studio-audio/${name}` : null }));
        return true;
      }
      if (url.pathname.startsWith('/studio-audio/')) {
        await sendFile(req, res, path.join(AUDIO_DIR, path.basename(url.pathname)));
        return true;
      }
      return false;
    },
  });
  console.log(`Studio: ${served.url}/?studio  (Ctrl+C to stop)`);
}

main().catch(err => { console.error(err); process.exit(1); });
