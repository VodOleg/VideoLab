// The engine from the command line (npm run still). Projects render with npm run render instead.
// Usage: node src/engine/cli.ts still <composition> <out.png|.jpg> [--frame=N] [--props='{"project":"..."}']
//        node src/engine/cli.ts render <composition> <out.mp4> [--props=...] [--concurrency=N]
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './ffmpeg.ts';
import { renderStill, renderVideo } from './render.ts';

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const [command, composition, output] = args.filter(a => !a.startsWith('--'));
  if (!['still', 'render'].includes(command) || !composition || !output) {
    throw new Error('usage: node src/engine/cli.ts still|render <composition> <output> [--frame=N] [--props=JSON] [--concurrency=N]');
  }
  const props = JSON.parse(opt('props') ?? '{}');
  const out = path.resolve(output);
  if (command === 'still') {
    const format = /\.jpe?g$/i.test(out) ? 'jpeg' : 'png';
    await renderStill({ composition, props, frame: Number(opt('frame') ?? 0), output: out, format });
  } else {
    const video = out.replace(/\.mp4$/i, '') + '.video.mp4', audio = out.replace(/\.mp4$/i, '') + '.wav';
    const concurrency = opt('concurrency');
    const { hasAudio } = await renderVideo({ composition, props, output: video, audioOutput: audio, concurrency: concurrency ? Number(concurrency) : undefined });
    if (hasAudio) ffmpeg(['-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
    else ffmpeg(['-i', video, '-c', 'copy', '-movflags', '+faststart', out]);
    await Promise.all([rm(video), rm(audio, { force: true })]);
  }
  console.log(`wrote ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
