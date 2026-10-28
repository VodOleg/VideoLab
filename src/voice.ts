// Voice: projects/<name>/script.json -> per-beat Kokoro voiceover + whisper.cpp word timings -> build/timeline.json
// Usage: npm run voice -- <name> [--voice am_michael] [--speed 1.12] [--only intro,why [--note "..."]]  (defaults: script.json "voice", else the stack's NARRATOR)
//        npm run voice -- <name> --only intro --try "Honey never spoils... ever." --try "..."   (options for one beat's text)
// A "..." (or ".." for a short pause) ends a phrase: each phrase is spoken on its own and they're joined with exact silence, so a pause never
// cuts into a word (looking for Kokoro's own gap in the audio split "Bolas" and "roads" before their final s).
// --only: preview just those beats in out/previews/ (the served page's Review tab, with each beat's text and the --note),
// to check pronunciation, without touching build/. Each preview run replaces the last one. With --try (repeatable) and a
// single --only beat, the previews are alternative texts for that beat, numbered intro-1, intro-2... for the user to pick.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './engine/ffmpeg.ts';
import { describeVoice, loadKokoro, NARRATOR, speakBeat, spokenWords, wav, type Voice } from './tts.ts';
import type { Script, Timeline, TimelineBeat, Word } from './types.ts';
import { installWhisper, transcribeWords } from './whisper.ts';

const LEAD_IN_MS = 150;
const BEAT_GAP_MS = 250;

function parseArgs() {
  const args = process.argv.slice(2);
  const name = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  if (!name) throw new Error('usage: npm run voice -- <name> [--voice am_michael] [--speed 1.12] [--only intro,why [--note "..."]]');
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const speed = opt('speed');
  const tries = args.flatMap((a, i) => (a === '--try' ? [args[i + 1]] : []));
  return { name, voice: opt('voice'), speed: speed === undefined ? undefined : Number(speed), only: opt('only')?.split(','), note: opt('note'), tries };
}

/** Linear resampling; good enough for whisper (which needs 16 kHz). */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to, j = Math.floor(x), f = x - j;
    out[i] = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? 0) * f;
  }
  return out;
}

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const normalize = (w: string) => w.toLowerCase().replace(/\d+/g, n => NUMBERS[Number(n)] ?? n).replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Give each script word the time of the matching whisper word (edit-distance alignment).
 * Unmatched script words are spread over the gap between their matched neighbours.
 */
export function alignWords(scriptWords: string[], heard: Word[], totalMs: number): Word[] {
  const a = scriptWords.map(normalize), b = heard.map(w => normalize(w.text));
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  const match = new Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { if (a[i - 1] === b[j - 1]) match[i - 1] = j - 1; i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }

  const words: Word[] = scriptWords.map((text, i) => (match[i] >= 0 ? { text, startMs: heard[match[i]].startMs, endMs: heard[match[i]].endMs } : { text, startMs: NaN, endMs: NaN }));
  for (let i = 0; i < n;) {
    if (!Number.isNaN(words[i].startMs)) { i++; continue; }
    let k = i; while (k < n && Number.isNaN(words[k].startMs)) k++;
    const from = i > 0 ? words[i - 1].endMs : 0, to = k < n ? words[k].startMs : totalMs;
    const chars = words.slice(i, k).map(w => w.text.length), total = chars.reduce((s, c) => s + c, 0);
    let t = from;
    for (let x = i; x < k; x++) { const dur = ((to - from) * chars[x - i]) / total; words[x].startMs = t; words[x].endMs = t += dur; }
    i = k;
  }
  return words;
}

async function hear(samples: Float32Array, rate: number, file: string): Promise<Word[]> {
  await writeFile(file, wav(resample(samples, rate, 16000), 16000));
  return transcribeWords(file);
}

async function main() {
  const args = parseArgs();
  const dir = path.join('projects', args.name);
  const script = JSON.parse(await readFile(path.join(dir, 'script.json'), 'utf8')) as Script;
  const voice: Voice = args.voice ?? script.voice?.mix ?? script.voice?.name ?? NARRATOR.voice;
  const speed = args.speed ?? script.voice?.speed ?? NARRATOR.speed;
  let beatsToSay = args.only ? script.beats.filter(b => args.only!.includes(b.id)) : script.beats;
  if (!beatsToSay.length) throw new Error(`no beats ${args.only?.join(', ')} in ${dir}/script.json`);
  if (args.tries.length) {
    if (!args.only || beatsToSay.length !== 1) throw new Error('--try needs exactly one --only beat');
    beatsToSay = args.tries.map((text, i) => ({ ...beatsToSay[0], id: `${beatsToSay[0].id}-${i + 1}`, text }));
  }
  // Previews go to a scratch folder and out/, so build/ keeps the last full run.
  const voiceDir = args.only ? path.resolve('.cache', 'voice-preview') : path.join(dir, 'build', 'voice');
  await mkdir(voiceDir, { recursive: true });

  await installWhisper();
  console.log(`Loading Kokoro (${describeVoice(voice)}, speed ${speed})`);
  const tts = await loadKokoro();

  let cursor = LEAD_IN_MS;
  const beats: TimelineBeat[] = [];
  for (const beat of beatsToSay) {
    const display = beat.text.split(/\s+/).filter(Boolean);
    const spoken = spokenWords(display, script.say ?? {});
    const { samples, rate, ranges, bounds } = await speakBeat(tts, display, spoken, voice, speed);
    const durationMs = (samples.length / rate) * 1000;

    const heard = await hear(samples, rate, path.join(voiceDir, `${beat.id}.16k.wav`));
    const words = alignWords(display, heard, durationMs);
    // Keep every word inside its own phrase, so captions pause with the voice.
    ranges.forEach(([from, to], k) => {
      for (let i = from; i < to; i++) {
        words[i].startMs = Math.min(Math.max(words[i].startMs, bounds[k][0]), bounds[k][1]);
        words[i].endMs = Math.min(Math.max(words[i].endMs, words[i].startMs), bounds[k][1]);
      }
    });
    await writeFile(path.join(voiceDir, `${beat.id}.wav`), wav(samples, rate));

    const pauses = ranges.slice(0, -1).map(([, to]) => `"${display[to - 1]}"`).join(', ');
    console.log(`  ${beat.id}: ${(durationMs / 1000).toFixed(1)}s, heard "${heard.map(w => w.text).join(' ')}"${pauses ? `; pauses after ${pauses}` : ''}`);
    beats.push({
      id: beat.id,
      startMs: Math.round(cursor),
      endMs: Math.round(cursor + durationMs),
      audio: `build/voice/${beat.id}.wav`,
      words: words.map(w => ({ ...w, startMs: Math.round(cursor + w.startMs), endMs: Math.round(cursor + w.endMs) })),
    });
    cursor += durationMs + BEAT_GAP_MS;
  }

  if (args.only) {
    const previewDir = path.resolve('out', 'previews');
    await rm(previewDir, { recursive: true, force: true });
    await mkdir(previewDir, { recursive: true });
    const previews = [];
    for (const [i, b] of beats.entries()) {
      const file = `${args.name}-${b.id}.mp3`;
      ffmpeg(['-i', path.join(voiceDir, `${b.id}.wav`), '-b:a', '128k', path.join(previewDir, file)]);
      previews.push({ id: b.id, text: beatsToSay[i].text, file, seconds: +((b.endMs - b.startMs) / 1000).toFixed(1) });
      console.log(`Preview: ${path.join(previewDir, file)}`);
    }
    await writeFile(path.join(previewDir, 'previews.json'), JSON.stringify({
      project: args.name, voice: describeVoice(voice), note: args.note, createdAt: new Date().toISOString(), beats: previews,
    }, null, 2));
    return;
  }
  const timeline: Timeline = { estimated: false, durationMs: beats.at(-1)!.endMs, beats };
  await writeFile(path.join(dir, 'build', 'timeline.json'), JSON.stringify(timeline, null, 2));
  console.log(`Wrote ${path.join(dir, 'build', 'timeline.json')} (${(timeline.durationMs / 1000).toFixed(1)}s of voiceover)`);
}

main().catch(err => { console.error(err); process.exit(1); });
