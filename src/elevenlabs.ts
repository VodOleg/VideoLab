// ElevenLabs text-to-speech for the voice step (a paid voice): one request per beat, as 24 kHz PCM. Each result is
// cached under .cache/elevenlabs/ by everything that shapes the audio, so re-running the voice step only pays for
// changed beats. The key comes from ELEVENLABS_API_KEY (environment or .env); never log it or the request headers.
// Using library voices through the API needs a paid plan.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElevenVoice } from './types.ts';

const API = 'https://api.elevenlabs.io/v1';
const RATE = 24000;
const CACHE_DIR = path.resolve('.cache', 'elevenlabs');

export const describeEleven = (v: ElevenVoice) =>
  `ElevenLabs ${v.name ?? v.voiceId} (${v.model}${[['stability', v.stability], ['style', v.style], ['speed', v.speed]].filter(([, x]) => x !== undefined).map(([k, x]) => `, ${k} ${x}`).join('')})`;

/** The voice saying `text`, as mono samples. */
export async function speakEleven(text: string, voice: ElevenVoice, speed = voice.speed): Promise<{ samples: Float32Array; rate: number }> {
  const body = {
    text,
    model_id: voice.model,
    voice_settings: { stability: voice.stability, similarity_boost: voice.similarityBoost, style: voice.style, speed },
  };
  const file = path.join(CACHE_DIR, `${createHash('sha256').update(JSON.stringify([voice.voiceId, body])).digest('hex').slice(0, 24)}.pcm`);
  let pcm = await readFile(file).catch(() => null);
  if (!pcm) {
    if (!process.env.ELEVENLABS_API_KEY) {
      try { process.loadEnvFile(); } catch { /* no .env */ }
    }
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set (put it in .env, which git ignores)');
    const res = await fetch(`${API}/text-to-speech/${voice.voiceId}?output_format=pcm_${RATE}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    pcm = Buffer.from(await res.arrayBuffer());
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, pcm);
  }
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return { samples, rate: RATE };
}
