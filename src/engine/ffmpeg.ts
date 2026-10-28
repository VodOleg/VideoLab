// ffmpeg from the ffmpeg-static package (a full build: loudnorm, rubberband, fps, tile...). It's GPL, which only matters
// for distributing the software, not for the videos made with it.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const FFMPEG: string = createRequire(import.meta.url)('ffmpeg-static');
if (!FFMPEG) throw new Error('ffmpeg-static has no ffmpeg build for this platform');

/** Runs ffmpeg quietly, overwriting outputs; returns what it wrote to stdout. */
export function ffmpeg(args: string[], input?: Buffer): Buffer {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { input, maxBuffer: 2 ** 31 - 1 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed\n${r.stderr}`);
  return r.stdout;
}

/** ffmpeg loudnorm's first-pass measurement (input_i = integrated LUFS, input_tp, input_lra, input_thresh, target_offset). */
export function measureLoudness(file: string): Record<string, string> {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const json = r.stderr.slice(r.stderr.lastIndexOf('{'), r.stderr.lastIndexOf('}') + 1);
  if (r.status !== 0 || !json) throw new Error(`could not measure loudness of ${file}\n${r.stderr}`);
  return JSON.parse(json);
}

/** Any audio file as interleaved 32-bit float samples. */
export function decodeAudio(file: string, rate: number, channels: number): Float32Array {
  const bytes = ffmpeg(['-i', file, '-f', 'f32le', '-ac', String(channels), '-ar', String(rate), '-']);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** A WAV file of 32-bit float samples (no clipping, whatever the level). */
export function floatWav(samples: Float32Array, rate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}
