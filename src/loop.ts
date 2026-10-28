// Loop: cut a generated track into a seamless loop of whole bars, optionally at a new tempo (pitch unchanged).
// Usage: npm run loop -- music/<track>.wav [--bpm 165] [--bars 8]  -> music/<track>-<bpm>bpm-loop.wav
// Also writes out/music-<name>.mp3 (the loop played 3 times) to listen to on the served page.
// ACE-Step writes an ending even into short clips, so the loop is taken from the steady part before it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FFMPEG, ffmpeg } from './engine/ffmpeg.ts';

const RATE = 48000;
const HOP = 240; // 5 ms analysis frames
const XFADE_S = 0.03;

/** Rubberband stretches tempo better than atempo; the ffmpeg-static builds for Windows and Linux have it. */
const hasRubberband = (spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '').includes('rubberband');

/** Interleaved stereo float samples. */
const decode = (args: string[], input?: Buffer) => {
  const b = ffmpeg([...args, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-'], input);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const raw = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
const RAW_IN = ['-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-i', '-'];

/** Onset strength per 5 ms frame: rectified rise in high-passed log energy (snare and cymbals stand out). */
function onsets(x: Float32Array): Float64Array {
  const n = Math.floor(x.length / 2 / HOP), e = new Float64Array(n), o = new Float64Array(n);
  let prev = 0, hp = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) {
      const m = (x[2 * j] + x[2 * j + 1]) / 2;
      hp = 0.9 * (hp + m - prev); prev = m; s += hp * hp;
    }
    e[i] = Math.log(1e-9 + s / HOP);
    if (i > 0) o[i] = Math.max(0, e[i] - e[i - 1]);
  }
  return o;
}

/** Beat period and phase (s) that best line up with the onsets; tempo searched around `nearBpm`, or 90-220 BPM. */
function beatGrid(o: Float64Array, endS: number, nearBpm?: number) {
  const at = (t: number) => { const f = (t * RATE) / HOP, i = Math.floor(f), a = f - i; return i + 1 < o.length ? o[i] * (1 - a) + o[i + 1] * a : 0; };
  const comb = (P: number, phi: number) => { let s = 0, k = 0; for (let t = phi; t < endS; t += P, k++) s += at(t); return s / k; };
  let best = { score: -1, bpm: 0, phi: 0 };
  const [lo, hi, step] = nearBpm ? [nearBpm * 0.98, nearBpm * 1.02, 0.01] : [90, 220, 0.05];
  for (let bpm = lo; bpm <= hi; bpm += step) {
    const P = 60 / bpm;
    for (let phi = 0; phi < P; phi += 0.0025) {
      const score = comb(P, phi);
      if (score > best.score) best = { score, bpm, phi };
    }
  }
  // Rock backbeat: the snare (beats 2 and 4) has the strongest onsets, so the bar starts one beat before it.
  const P = 60 / best.bpm, strength = [0, 0, 0, 0];
  for (let k = 0, t = best.phi; t < endS; k++, t += P) strength[k % 4] += at(t);
  const snare = strength.indexOf(Math.max(...strength));
  return { bpm: best.bpm, beat: P, downbeat: best.phi + (((snare + 3) % 4) * P) };
}

/** Mean power (dB) of each beat, to find where the steady part ends. */
function beatLevels(x: Float32Array, start: number, beat: number): number[] {
  const out: number[] = [];
  for (let t = start; (t + beat) * RATE * 2 <= x.length; t += beat) {
    let s = 0;
    const a = Math.round(t * RATE), z = Math.round((t + beat) * RATE);
    for (let i = a; i < z; i++) s += x[2 * i] ** 2 + x[2 * i + 1] ** 2;
    out.push(10 * Math.log10(s / (2 * (z - a)) + 1e-12));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const src = args.find(a => !a.startsWith('--') && !/^\d/.test(a));
  if (!src) throw new Error('usage: npm run loop -- music/<track>.wav [--bpm 165] [--bars 8]');
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

  const x = decode(['-i', src]);
  const grid = beatGrid(onsets(x), x.length / 2 / RATE);
  const levels = beatLevels(x, grid.downbeat, grid.beat);
  const median = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)];
  const steadyBeats = levels.findIndex(l => l < median - 3);
  const fitBars = Math.floor(((steadyBeats < 0 ? levels.length : steadyBeats) - 1) / 4); // keep a beat for the crossfade
  const bars = Number(opt('bars') ?? 2 ** Math.floor(Math.log2(fitBars)));
  if (bars > fitBars) throw new Error(`only ${fitBars} steady bars in ${src}`);
  console.log(`${src}: ${grid.bpm.toFixed(2)} bpm, downbeat at ${grid.downbeat.toFixed(3)}s, ${fitBars} steady bars; looping ${bars}`);

  // Seamless loop at the source tempo: the audio just after the loop end is crossfaded into its start.
  const s = Math.round(grid.downbeat * RATE), len = Math.round(bars * 4 * grid.beat * RATE), xf = Math.round(XFADE_S * RATE);
  const loop = new Float32Array(len * 2);
  for (let i = 0; i < len; i++) {
    const w = i < xf ? i / xf : 1;
    for (let c = 0; c < 2; c++) loop[2 * i + c] = x[2 * (s + i) + c] * w + (i < xf ? x[2 * (s + len + i) + c] * (1 - w) : 0);
  }

  // New tempo: stretch three copies and keep one period from the middle, so the stretcher's edges never show.
  const bpm = Number(opt('bpm') ?? grid.bpm);
  let out = loop;
  if (Math.abs(bpm - grid.bpm) > 0.01) {
    const ratio = bpm / grid.bpm;
    const filter = hasRubberband ? `rubberband=tempo=${ratio}:transients=crisp:detector=percussive` : `atempo=${ratio}`;
    const three = new Float32Array(loop.length * 3);
    for (let k = 0; k < 3; k++) three.set(loop, k * loop.length);
    const y = decode([...RAW_IN, '-af', filter], raw(three));
    const period = Math.round(len / ratio);
    const mid = y.subarray(period * 2, period * 4);
    // Rotate so the loop starts on a downbeat again (the stretcher may delay its output).
    const g = beatGrid(onsets(mid), period / RATE, bpm);
    const shift = Math.round((g.downbeat % ((4 * 60) / bpm)) * RATE);
    out = new Float32Array(period * 2);
    out.set(mid.subarray(shift * 2), 0);
    out.set(mid.subarray(0, shift * 2), (period - shift) * 2);
    console.log(`stretched to ${bpm} bpm with ${hasRubberband ? 'rubberband' : 'atempo'}`);
  }

  const name = `${path.basename(src, path.extname(src))}-${Math.round(bpm)}bpm-loop`;
  const wav = path.join(path.dirname(src), `${name}.wav`);
  ffmpeg([...RAW_IN, '-c:a', 'pcm_s16le', wav], raw(out));
  const mp3 = path.resolve('out', `music-${name}.mp3`);
  ffmpeg(['-stream_loop', '2', '-i', wav, '-b:a', '192k', mp3]);
  console.log(`wrote ${wav} (${(out.length / 2 / RATE).toFixed(2)}s) and ${mp3}`);
}

main();
