// Voice: projects/<name>/script.json -> per-beat voiceover (Kokoro, or ElevenLabs with "voice": {"elevenlabs": ...}) +
// whisper.cpp word timings -> build/timeline.json
// Usage: npm run voice -- <name> [--voice am_michael] [--speed 1.12] [--only intro,why [--note "..."]]  (defaults: script.json "voice", else the stack's NARRATOR)
//        npm run voice -- <name> --only intro --try "Honey never spoils... ever." --try "..."   (options for one beat's text)
//        npm run voice -- <name> --final   (a script with an ElevenLabs voice: the paid voice; without --final, a free Kokoro draft paced like it)
// A "..." (or ".." for a short pause) ends a phrase: each phrase is spoken on its own and they're joined with exact silence, so a pause never
// cuts into a word (looking for Kokoro's own gap in the audio instead once split a word before its final s).
// --only: preview just those beats in out/previews/ (the served page's Review tab, with each beat's text and the --note),
// to check pronunciation, without touching build/. Each preview run replaces the last one. With --try (repeatable) and a
// single --only beat, the previews are alternative texts for that beat, numbered intro-1, intro-2... for the user to pick.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeEleven, speakEleven } from './elevenlabs.ts';
import { ffmpeg } from './engine/ffmpeg.ts';
import { describeVoice, loadKokoro, NARRATOR, pauseAfter, speakBeat, spokenWords, TAIL_KEEP_MS, trim, wav, type Voice } from './tts.ts';
import type { ElevenVoice, Script, Timeline, TimelineBeat, Word } from './types.ts';
import { installWhisper, transcribeWords } from './whisper.ts';

const LEAD_IN_MS = 150;
const BEAT_GAP_MS = 250;
// An ElevenLabs voice stops for ~0.5 s at a sentence end or colon (340-660 ms measured) where Kokoro runs on after
// ~0.2 s, so a draft also ends a phrase there and adds this much silence, keeping its length close to the final's.
const DRAFT_STOP_MS = 500;

function parseArgs() {
  const args = process.argv.slice(2);
  const valued = ['--voice', '--speed', '--only', '--note', '--try'];
  const name = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  if (!name) throw new Error('usage: npm run voice -- <name> [--final] [--voice am_michael] [--speed 1.12] [--only intro,why [--note "..."]]');
  const opt = (flag: string) => { const i = args.indexOf(`--${flag}`); return i >= 0 ? args[i + 1] : undefined; };
  const speed = opt('speed');
  const tries = args.flatMap((a, i) => (a === '--try' ? [args[i + 1]] : []));
  return {
    name, voice: opt('voice'), speed: speed === undefined ? undefined : Number(speed), only: opt('only')?.split(','), note: opt('note'), tries,
    final: args.includes('--final'),
  };
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
 * Whisper sometimes stretches one word over seconds and squeezes the next few into milliseconds (once a name spanned
 * 1.0-5.2 s and the eight words after it fell inside 0.3 s, bunching the captions and breaking phrase cues). A word
 * lasting at least max(900, 160 x its length) ms followed by 2+ words under 120 ms each has the whole run spread over
 * its span, in proportion to word length.
 */
function unsquash(heard: Word[]): Word[] {
  const out = heard.map(w => ({ ...w }));
  const len = (w: Word) => normalize(w.text).length || 1;
  for (let i = 0; i < out.length; i++) {
    if (out[i].endMs - out[i].startMs < Math.max(900, 160 * len(out[i]))) continue;
    let k = i + 1;
    while (k < out.length && out[k].endMs - out[k].startMs < 120) k++;
    if (k - i < 3) continue; // a long word alone is just a slow one
    const from = out[i].startMs, to = out[k - 1].endMs, total = out.slice(i, k).reduce((s, w) => s + len(w) + 1, 0);
    let t = from;
    for (let x = i; x < k; x++) { out[x].startMs = t; out[x].endMs = t += ((to - from) * (len(out[x]) + 1)) / total; }
    i = k - 1;
  }
  return out;
}

/**
 * Give each script word the time of the matching whisper word (edit-distance alignment).
 * Unmatched script words are spread over the gap between their matched neighbours.
 */
export function alignWords(scriptWords: string[], heardRaw: Word[], totalMs: number): Word[] {
  const heard = unsquash(heardRaw);
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
  // An ElevenLabs voice costs money per character, so it only speaks with --final: until then the script is drafted with
  // the free Kokoro narrator at the voice's draftSpeed, so the draft's timing (and the video's length) is close to the
  // final one. --voice / --speed pick a Kokoro voice over the script's ElevenLabs one.
  const scriptEleven = script.voice && 'elevenlabs' in script.voice ? script.voice.elevenlabs : undefined;
  if (args.final && !scriptEleven) throw new Error(`--final is for scripts with an ElevenLabs voice; ${dir}/script.json has none`);
  const eleven: ElevenVoice | undefined = args.final && args.voice === undefined && args.speed === undefined ? scriptEleven : undefined;
  const draft = !!scriptEleven && !eleven;
  const kokoro = script.voice && !('elevenlabs' in script.voice) ? script.voice : undefined;
  const voice: Voice = args.voice ?? kokoro?.mix ?? kokoro?.name ?? NARRATOR.voice;
  const speed = args.speed ?? kokoro?.speed ?? scriptEleven?.draftSpeed ?? NARRATOR.speed;
  // A beat's own speed is meant for the ElevenLabs voice: the draft scales its own speed by the same ratio.
  const beatSpeed = (s: number | undefined) => (s === undefined ? speed : draft && args.speed === undefined ? (speed * s) / (scriptEleven!.speed ?? 1) : s);
  // Titles aren't sentence ends: "Ms. Smith" gets no stop.
  const pause = draft ? (w: string) => pauseAfter(w) || (/[.?!:]$/.test(w) && !/^(Mr|Mrs|Ms|Dr|St)\.$/i.test(w) ? DRAFT_STOP_MS : 0) : pauseAfter;
  if (eleven) {
    const phonemes = Object.entries(script.say ?? {}).filter(([, s]) => s.startsWith('/'));
    if (phonemes.length) throw new Error(`ElevenLabs can't read phonemes: respell ${phonemes.map(([w]) => w).join(', ')} in "say"`);
  }
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
  const voiceName = eleven ? describeEleven(eleven)
    : `${draft ? `Kokoro draft for ${scriptEleven!.name ?? 'ElevenLabs'}: ` : ''}${describeVoice(voice)}, speed ${speed}`;
  console.log(eleven ? `Voice: ${voiceName}` : `Loading Kokoro (${voiceName})`);
  if (draft) console.log('Draft voice (free): run with --final for the ElevenLabs voice once the script is settled');
  const tts = eleven ? null : await loadKokoro();

  let cursor = LEAD_IN_MS;
  const beats: TimelineBeat[] = [];
  for (const beat of beatsToSay) {
    const display = beat.text.split(/\s+/).filter(Boolean);
    const spoken = spokenWords(display, script.say ?? {});
    // ElevenLabs speaks a beat in one go (its own pauses at punctuation), trimmed like Kokoro's: a short lead-in, TAIL_KEEP_MS after.
    const { samples, rate, ranges, bounds } = eleven
      ? await speakEleven(spoken.join(' '), { ...eleven, stability: beat.stability ?? eleven.stability, style: beat.style ?? eleven.style }, beat.speed ?? eleven.speed).then(({ samples, rate }) => {
        const audio = trim(samples, rate, 30, TAIL_KEEP_MS, 0.01);
        return { samples: audio, rate, ranges: [[0, display.length]], bounds: [[0, (audio.length / rate) * 1000]] };
      })
      : await speakBeat(tts!, display, spoken, voice, beatSpeed(beat.speed), pause);
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
    cursor += durationMs + BEAT_GAP_MS + (beat.holdMs ?? 0);
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
      project: args.name, voice: voiceName, note: args.note, createdAt: new Date().toISOString(), beats: previews,
    }, null, 2));
    return;
  }
  const timeline: Timeline = { estimated: false, voice: voiceName, ...(draft && { draft }), durationMs: beats.at(-1)!.endMs, beats };
  await writeFile(path.join(dir, 'build', 'timeline.json'), JSON.stringify(timeline, null, 2));
  console.log(`Wrote ${path.join(dir, 'build', 'timeline.json')} (${(timeline.durationMs / 1000).toFixed(1)}s of ${draft ? 'draft ' : ''}voiceover)`);
}

main().catch(err => { console.error(err); process.exit(1); });
