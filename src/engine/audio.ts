// The soundtrack: every Audio element's file, placed where its sequence starts, trimmed, looped and at its per-frame
// volume (from the page's dry run over every frame), summed into one 48 kHz stereo float WAV.
import { writeFile } from 'node:fs/promises';
import { decodeAudio, floatWav } from './ffmpeg.ts';
import type { AudioTrack } from './page.tsx';
import { fileOf } from './server.ts';

const RATE = 48000;

/** Writes the mix to `output`; returns false (and writes nothing) when there is no audio. */
export async function mixAudio(tracks: AudioTrack[], fps: number, durationInFrames: number, output: string): Promise<boolean> {
  if (!tracks.length) return false;
  const total = Math.round((durationInFrames / fps) * RATE);
  const mix = new Float32Array(total * 2);
  const perFrame = RATE / fps;
  const decoded = new Map<string, Float32Array>();

  for (const track of tracks) {
    const file = fileOf(track.src);
    if (!file) throw new Error(`audio outside the public folder: ${track.src}`);
    let pcm = decoded.get(file);
    if (!pcm) decoded.set(file, pcm = decodeAudio(file, RATE, 2));
    const length = pcm.length / 2;
    const trim = Math.round((track.trimBefore / fps) * RATE);
    const start = Math.round(track.start * perFrame);
    const volumes = new Map(track.frames);

    for (const [frame, v0] of track.frames) {
      // Volume glides to the next frame's, so ramps don't step 30 times a second.
      const v1 = volumes.get(frame + 1) ?? v0;
      const a = Math.round(frame * perFrame), b = Math.min(total, Math.round((frame + 1) * perFrame));
      for (let i = a; i < b; i++) {
        let p = i - start + trim;
        if (track.loop && length > trim) p = trim + ((p - trim) % (length - trim));
        if (p < 0 || p >= length) continue;
        const v = v0 + ((v1 - v0) * (i - a)) / (b - a);
        mix[2 * i] += pcm[2 * p] * v;
        mix[2 * i + 1] += pcm[2 * p + 1] * v;
      }
    }
  }
  await writeFile(output, floatWav(mix, RATE, 2));
  return true;
}
