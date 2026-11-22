// Kokoro synthesis shared by the voice step and the voice lab: a beat's phrases (split at "..." or "..") joined by
// exact pauses, spoken by a Kokoro voice or by a mix of voice packs.
// A voice pack (kokoro-js/voices/<name>.bin) holds 510 style vectors of 256 floats, one per input length in tokens.
// The first 128 floats of a vector set the timbre (Kokoro's decoder), the last 128 the delivery (its prosody predictor:
// phoneme durations, pitch, energy), so a mix can take each half from different voices.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Tensor } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { hasPhonemes, toPhonemes } from './phonemes.ts';
import type { VoiceMix } from './types.ts';

const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICES_DIR = new URL('../voices/', import.meta.resolve('kokoro-js'));
const ROWS = 510, STYLE = 256, HALF = 128;
export const PAUSE_MS = 450;
export const SHORT_PAUSE_MS = 250;
const SILENT = 1e-3; // a phrase's leading/trailing samples below this are Kokoro's padding

/** A Kokoro voice name (e.g. am_michael) or a mix of voice packs. */
export type Voice = string | VoiceMix;

/** The default narrator voice: Michael's timbre with Fenrir's livelier delivery (a script's "voice" overrides it). */
export const NARRATOR: { voice: VoiceMix; speed: number } = { voice: { timbre: { am_michael: 1 }, prosody: { am_fenrir: 1 } }, speed: 1.12 };

export const loadKokoro = () => KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu' });

export const describeVoice = (voice: Voice) => {
  if (typeof voice === 'string') return voice;
  const half = (w: Record<string, number>) => Object.entries(w).map(([v, x]) => `${v} ${Math.round(x * 100)}%`).join(' + ');
  const timbre = half(voice.timbre), prosody = half(voice.prosody);
  return timbre === prosody ? timbre : `timbre ${timbre} / delivery ${prosody}`;
};

const packs = new Map<string, Promise<Float32Array>>();
function cached(key: string, load: () => Promise<Float32Array>) {
  if (!packs.has(key)) packs.set(key, load());
  return packs.get(key)!;
}

const voicePack = (name: string) => cached(name, async () => {
  const file = fileURLToPath(new URL(`${name}.bin`, VOICES_DIR));
  const bytes = await readFile(file).catch(() => { throw new Error(`No Kokoro voice "${name}" (${file})`); });
  return new Float32Array(new Uint8Array(bytes).buffer);
});

/** Each half of every style vector is the weighted sum of the voices' halves (weights may be negative). */
const mixPack = (mix: VoiceMix) => cached(JSON.stringify(mix), async () => {
  const out = new Float32Array(ROWS * STYLE);
  for (const [offset, weights] of [[0, mix.timbre], [HALF, mix.prosody]] as const) {
    for (const [name, w] of Object.entries(weights)) {
      const pack = await voicePack(name);
      for (let r = 0; r < ROWS; r++) for (let i = r * STYLE + offset; i < r * STYLE + offset + HALF; i++) out[i] += w * pack[i];
    }
  }
  return out;
});

type Audio = { audio: Float32Array; sampling_rate: number };

async function speak(tts: KokoroTTS, phrase: string[], voice: Voice, speed: number): Promise<Audio> {
  // Kokoro all but drops an utterance's first sound when it's a hiss: with Fenrir's delivery the s of "Slap" and
  // "Smasher" came out ~0 (whisper heard "Lap", "Mash"). A leading "…" (silent) brings it back to normal level.
  const words = ['…', ...phrase];
  if (typeof voice === 'string' && !hasPhonemes(words)) return tts.generate(words.join(' '), { voice: voice as never, speed });
  // Same as tts.generate, with our phonemes instead of kokoro-js's own, and for a mix our own style vector.
  const tokenize = tts.tokenizer as unknown as (text: string, opts: object) => { input_ids: Tensor };
  const ids = tokenize(await toPhonemes(words), { truncation: true }).input_ids;
  if (typeof voice === 'string') return tts.generate_from_ids(ids as never, { voice: voice as never, speed });
  // kokoro-js picks the vector by token count, minus the two boundary tokens.
  const row = Math.min(Math.max(ids.dims.at(-1)! - 2, 0), ROWS - 1);
  const style = (await mixPack(voice)).slice(row * STYLE, (row + 1) * STYLE);
  const run = tts.model as unknown as (inputs: Record<string, Tensor>) => Promise<{ waveform: Tensor }>;
  const { waveform } = await run({ input_ids: ids, style: new Tensor('float32', style, [1, STYLE]), speed: new Tensor('float32', [speed], [1]) });
  return { audio: waveform.data as Float32Array, sampling_rate: 24000 };
}

const INNER_KEEP_MS = 20; // inside a beat, around a pause: just enough not to clip a sound
// After a beat's last word Kokoro leaves ~450 ms of silence; with the beat gap and the next beat's ~210 ms lead-in that
// made ~0.9 s of dead air at every beat change, twice a "..." pause. Keeping 150 ms makes it ~0.6 s.
export const TAIL_KEEP_MS = 150;

/**
 * Drop silent padding at a phrase's start and/or end down to that many ms (null: keep it all). `silent`: the level
 * below which a sample counts as padding (Kokoro's is digital silence; ElevenLabs' has a noise floor).
 */
export function trim(samples: Float32Array, rate: number, keepStartMs: number | null, keepEndMs: number | null, silent = SILENT): Float32Array {
  let a = 0, b = samples.length;
  if (keepStartMs !== null) { while (a < b && Math.abs(samples[a]) < silent) a++; a = Math.max(0, a - Math.round((rate * keepStartMs) / 1000)); }
  if (keepEndMs !== null) { while (b > a && Math.abs(samples[b - 1]) < silent) b--; b = Math.min(samples.length, b + Math.round((rate * keepEndMs) / 1000)); }
  return samples.subarray(a, b);
}

/** Silence after a word that ends a phrase: "..." a full pause, ".." a short one; 0 for any other word. */
export const pauseAfter = (word: string): number => (word.endsWith('...') ? PAUSE_MS : word.endsWith('..') ? SHORT_PAUSE_MS : 0);

/** [from, to) word ranges of a beat's phrases: each ends after a word with a pause (by default one ending in "..." or ".."). */
export function phrases(words: string[], pause = pauseAfter): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  words.forEach((w, i) => { if (pause(w) && i + 1 < words.length) { out.push([from, i + 1]); from = i + 1; } });
  out.push([from, words.length]);
  return out;
}

/**
 * What the narrator says for each script word: `say` respells words for Kokoro only (e.g. "keenwah"), or gives
 * exact phonemes between slashes (e.g. "/kˈiːnwɑː/"); the captions keep the script's spelling.
 */
export function spokenWords(words: string[], say: Record<string, string>): string[] {
  const respell = new Map(Object.entries(say).map(([word, spoken]) => [word.toLowerCase(), spoken]));
  // A word's core keeps inner hyphens and apostrophes, so "Jean-Luc" can be respelled as a whole.
  return words.map(w => w.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/u, core => respell.get(core.toLowerCase()) ?? core));
}

/**
 * A beat's voiceover: each phrase spoken on its own, its inner edges trimmed of Kokoro's padding (the beat keeps its
 * lead-in and TAIL_KEEP_MS at the end), joined by the pause that ends the phrase before (`pause`, by default pauseAfter).
 * Returns the audio and each phrase's word range and span in ms.
 */
export async function speakBeat(tts: KokoroTTS, display: string[], spoken: string[], voice: Voice, speed: number, pause = pauseAfter) {
  const ranges = phrases(display, pause);
  let rate = 24000;
  const parts: Float32Array[] = [], bounds: Array<[number, number]> = [];
  let length = 0;
  for (const [k, [from, to]] of ranges.entries()) {
    const audio = await speak(tts, spoken.slice(from, to), voice, speed);
    rate = audio.sampling_rate;
    const part = trim(audio.audio, rate, k > 0 ? INNER_KEEP_MS : null, k < ranges.length - 1 ? INNER_KEEP_MS : TAIL_KEEP_MS);
    if (k > 0) {
      parts.push(new Float32Array(Math.round((rate * pause(display[ranges[k - 1][1] - 1])) / 1000)));
      length += parts.at(-1)!.length;
    }
    bounds.push([(length / rate) * 1000, ((length + part.length) / rate) * 1000]);
    parts.push(part);
    length += part.length;
  }
  const samples = new Float32Array(length);
  parts.reduce((at, p) => (samples.set(p, at), at + p.length), 0);
  return { samples, rate, ranges, bounds };
}

/** 16-bit PCM mono WAV. */
export function wav(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return buf;
}
