// Voice lab: the same lines spoken by Kokoro voice mixes (src/tts.ts) -> out/voice-lab/<n>-<slug>.mp3 + samples.json,
// listed on the served page for listening side by side. Text, "say" and speed come from the project's script.json.
// Usage: npm run voicelab -- <name> [--beats intro,why]   (default: the first two beats)
// A sample the user picks goes into script.json as "voice": {"mix": {...}, "speed": ...}.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './engine/ffmpeg.ts';
import { describeVoice, loadKokoro, NARRATOR, speakBeat, spokenWords, wav, type Voice } from './tts.ts';
import type { Script, VoiceMix } from './types.ts';

const OUT_DIR = path.resolve('out', 'voice-lab');
const WORK_DIR = path.resolve('.cache', 'voice-lab');
const BEAT_GAP_MS = 250;

const AMERICAN_MEN = ['am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck'];
const both = (weights: Record<string, number>): VoiceMix => ({ timbre: weights, prosody: weights });
/** k × weights + (1 − k) × the average American male voice: k > 1 pushes a voice away from the average, i.e. less generic. */
function pushed(weights: Record<string, number>, k: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of AMERICAN_MEN) out[v] = (1 - k) / AMERICAN_MEN.length;
  for (const [v, w] of Object.entries(weights)) out[v] = (out[v] ?? 0) + k * w;
  return out;
}

const SAMPLES: Array<{ group: string; label: string; note: string; voice: Voice }> = [
  { group: 'Reference', label: 'Michael', note: 'The current narrator (am_michael).', voice: 'am_michael' },
  { group: 'Reference', label: 'Heart', note: "Kokoro's best-graded voice (af_heart, female), for comparison.", voice: 'af_heart' },

  { group: 'Blends', label: 'Michael 60 + Fenrir 40', note: 'The two best-graded American men.', voice: both({ am_michael: 0.6, am_fenrir: 0.4 }) },
  { group: 'Blends', label: 'Michael 50 + Puck 50', note: 'Puck is the third C+ man, lighter.', voice: both({ am_michael: 0.5, am_puck: 0.5 }) },
  { group: 'Blends', label: 'Fenrir 50 + Puck 50', note: 'No Michael at all.', voice: both({ am_fenrir: 0.5, am_puck: 0.5 }) },
  { group: 'Blends', label: 'Michael 65 + Onyx 35', note: 'Onyx is lower and darker (graded D on its own).', voice: both({ am_michael: 0.65, am_onyx: 0.35 }) },
  { group: 'Blends', label: 'Michael 60 + George 40', note: 'A touch of a British man.', voice: both({ am_michael: 0.6, bm_george: 0.4 }) },
  { group: 'Blends', label: 'Michael 60 + Fable 40', note: 'Fable: a British storyteller voice.', voice: both({ am_michael: 0.6, bm_fable: 0.4 }) },

  { group: 'One voice, another delivery', label: 'Michael voice, Puck delivery', note: "Michael's timbre, Puck's timing and pitch.", voice: { timbre: { am_michael: 1 }, prosody: { am_puck: 1 } } },
  { group: 'One voice, another delivery', label: 'Michael voice, Fenrir delivery', note: "Michael's timbre, Fenrir's timing and pitch.", voice: { timbre: { am_michael: 1 }, prosody: { am_fenrir: 1 } } },
  { group: 'One voice, another delivery', label: 'Fenrir voice, Puck delivery', note: "Fenrir's timbre, Puck's timing and pitch.", voice: { timbre: { am_fenrir: 1 }, prosody: { am_puck: 1 } } },
  { group: 'One voice, another delivery', label: 'Michael voice, Heart delivery', note: "Michael's timbre with Kokoro's most expressive (female) delivery.", voice: { timbre: { am_michael: 1 }, prosody: { af_heart: 1 } } },
  { group: 'One voice, another delivery', label: 'Michael voice, Bella delivery', note: "Michael's timbre with Bella's (female, A−) delivery.", voice: { timbre: { am_michael: 1 }, prosody: { af_bella: 1 } } },

  { group: 'Pushed away from the average voice', label: 'Michael ×1.5', note: "Everything that makes Michael differ from the average American man, 1.5 times as much.", voice: both(pushed({ am_michael: 1 }, 1.5)) },
  { group: 'Pushed away from the average voice', label: 'Michael, delivery ×1.8', note: "Michael's timbre unchanged; his delivery pushed 1.8 times away from the average.", voice: { timbre: { am_michael: 1 }, prosody: pushed({ am_michael: 1 }, 1.8) } },
  { group: 'Pushed away from the average voice', label: '(Fenrir 50 + Puck 50) ×1.4', note: 'The Fenrir/Puck blend, pushed 1.4 times away from the average.', voice: both(pushed({ am_fenrir: 0.5, am_puck: 0.5 }, 1.4)) },
];

/** Median pitch of the voiced parts, in Hz (autocorrelation at 8 kHz); a rough guide to how low or high a voice sits. */
function medianPitch(x24k: Float32Array): number {
  const rate = 8000;
  const x = new Float32Array(Math.floor(x24k.length / 3)).map((_, i) => (x24k[3 * i] + x24k[3 * i + 1] + x24k[3 * i + 2]) / 3);
  const frame = 320, hop = 80, minLag = rate / 400, maxLag = rate / 60;
  const f0s: number[] = [];
  for (let s = 0; s + frame + maxLag < x.length; s += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += x[s + i] ** 2;
    if (energy / frame < 1e-4) continue;
    const r: number[] = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, e = 0;
      for (let i = 0; i < frame; i++) { c += x[s + i] * x[s + i + lag]; e += x[s + i + lag] ** 2; }
      r.push(c / Math.sqrt(energy * e + 1e-12));
    }
    const best = Math.max(...r);
    if (best < 0.6) continue;
    // The shortest lag that's nearly as good as the best one, so subharmonics don't halve the pitch.
    const k = r.findIndex((v, i) => v >= 0.9 * best && (i === 0 || v >= r[i - 1]) && (i === r.length - 1 || v >= r[i + 1]));
    f0s.push(rate / (minLag + k));
  }
  f0s.sort((a, b) => a - b);
  return Math.round(f0s[Math.floor(f0s.length / 2)] ?? 0);
}

async function main() {
  const args = process.argv.slice(2);
  const name = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  if (!name) throw new Error('usage: npm run voicelab -- <name> [--beats intro,why]');
  const opt = args.indexOf('--beats');
  const script = JSON.parse(await readFile(path.join('projects', name, 'script.json'), 'utf8')) as Script;
  const beatIds = opt >= 0 ? args[opt + 1].split(',') : script.beats.slice(0, 2).map(b => b.id);
  const beats = beatIds.map(id => script.beats.find(b => b.id === id) ?? (() => { throw new Error(`no beat "${id}" in ${name}`); })());
  const voice = script.voice && 'elevenlabs' in script.voice ? undefined : script.voice;
  const speed = voice?.speed ?? NARRATOR.speed;

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  const tts = await loadKokoro();

  const results = [];
  for (const [i, sample] of SAMPLES.entries()) {
    const parts: Float32Array[] = [];
    let rate = 24000;
    for (const beat of beats) {
      const display = beat.text.split(/\s+/).filter(Boolean);
      const said = await speakBeat(tts, display, spokenWords(display, script.say ?? {}), sample.voice, speed);
      rate = said.rate;
      if (parts.length) parts.push(new Float32Array(Math.round((rate * BEAT_GAP_MS) / 1000)));
      parts.push(said.samples);
    }
    const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (samples.set(p, at), at + p.length), 0);

    const n = String(i + 1).padStart(2, '0');
    const file = `${n}-${sample.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.mp3`;
    const wavFile = path.join(WORK_DIR, `${n}.wav`);
    await writeFile(wavFile, wav(samples, rate));
    // Same loudness for every sample, so none sounds better just for being louder.
    ffmpeg(['-i', wavFile, '-af', 'loudnorm=I=-16:TP=-1.5', '-ar', '44100', '-b:a', '128k', path.join(OUT_DIR, file)]);

    const result = { n: i + 1, ...sample, recipe: describeVoice(sample.voice), file, seconds: +(samples.length / rate).toFixed(1), pitchHz: medianPitch(samples) };
    console.log(`${n} ${sample.label.padEnd(30)} ${result.seconds}s  ~${result.pitchHz} Hz`);
    results.push(result);
  }

  await writeFile(path.join(OUT_DIR, 'samples.json'), JSON.stringify({
    project: name, speed, text: beats.map(b => b.text).join(' '), createdAt: new Date().toISOString(),
    samples: results,
  }, null, 2));
  console.log(`Wrote ${SAMPLES.length} samples to ${OUT_DIR}`);
}

main().catch(err => { console.error(err); process.exit(1); });
