// Render: projects/<name> -> out/<name>.mp4 + a small out/<name>.preview.mp4 for checking on a phone.
// Usage: npm run render -- <name> [--sheet [--frames 30,240]] [--beats intro,why] [--scenes [why,how]] [--fresh]
// --sheet: only out/<name>.sheet.png, one frame of every scene (or the given frames) in a grid, in seconds: check this
// before rendering. --beats: only those beats, to out/<name>.<beats>.mp4 (a part to review).
// --scenes: scene by scene (one scene per beat), keeping each scene's clip in build/scenes/ and re-rendering only the
// scenes whose pictures changed; the scenes named after it are re-rendered anyway, and --fresh re-renders them all.
// The re-rendered scenes go to out/scenes/ (with their sound and text), for the review page.
// First the voiceover's loudness is measured for the narrator's mouth (build/levels.json), and the script's music track
// (music/<track>) is copied to build/music.wav, since the video only reads projects/, with the gain that brings it to
// MUSIC_LUFS (applied in the mix), so the default volume and ducking work for any track. The final mix goes to OUT_LUFS.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, measureLoudness } from './engine/ffmpeg.ts';
import { renderScenes, renderSheet, renderVideo, type SceneResult } from './engine/render.ts';
import type { Script, Timeline } from './types.ts';
import { musicOf } from './video/music.ts';

const MUSIC_LUFS = -20;
const OUT_LUFS = -14; // what YouTube, TikTok and Reels play at
const OUT_TRUE_PEAK = -1.5;
const LEVELS_RATE = 30; // mouth positions a second
/** Phone previews: 720 px on the shorter side. */
const PREVIEW = ['-vf', "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'", '-crf', '28'];

/**
 * The voiceover's loudness for the narrator's mouth: per beat, LEVELS_RATE values a second from 0 (silent) to 1 (as loud
 * as the beat gets), opening at once and closing over a few frames -> build/levels.json.
 */
async function writeLevels(dir: string) {
  const timeline = JSON.parse(await readFile(path.join(dir, 'build', 'timeline.json'), 'utf8').catch(() => 'null')) as Timeline | null;
  if (!timeline) return console.warn('No build/timeline.json yet (npm run voice): the narrator mouths estimated words in silence');
  const beats: Record<string, number[]> = {};
  for (const b of timeline.beats) {
    if (!b.audio) continue;
    // The voice step's own WAVs: 16-bit mono PCM (tts.ts).
    const bytes = await readFile(path.join(dir, b.audio));
    const rate = bytes.readUInt32LE(24), data = bytes.indexOf('data') + 8;
    const samples = Math.floor((bytes.length - data) / 2), window = rate / LEVELS_RATE;
    const db: number[] = [];
    for (let i = 0; i * window < samples; i++) {
      const from = Math.floor(i * window), to = Math.min(samples, Math.floor((i + 1) * window));
      let sum = 0;
      for (let j = from; j < to; j++) sum += (bytes.readInt16LE(data + 2 * j) / 32768) ** 2;
      db.push(10 * Math.log10(sum / Math.max(1, to - from) + 1e-10));
    }
    const loud = [...db].sort((x, y) => x - y)[Math.floor(db.length * 0.95)];
    let level = 0;
    beats[b.id] = db.map(x => {
      // Fully open only near the beat's loudest syllables: 24 dB below them is closed.
      level = Math.max(Math.min(1, Math.max(0, (x - loud + 24) / 24)) ** 1.5, level * 0.55);
      return +level.toFixed(2);
    });
  }
  await writeFile(path.join(dir, 'build', 'levels.json'), JSON.stringify({ rate: LEVELS_RATE, beats }));
}

/** The scenes this render re-rendered, cut from the finished video with their sound -> out/scenes/ + scenes.json (replaced each run). */
async function writeSceneClips(video: string, scenes: SceneResult[], script: Script, fps: number) {
  const dir = path.resolve('out', 'scenes');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const name = path.basename(video, '.mp4');
  const items = [];
  for (const [i, s] of scenes.entries()) {
    const file = s.rendered ? `${name}-${String(i + 1).padStart(2, '0')}-${s.id}.mp4` : null;
    if (file) ffmpeg(['-ss', String(s.from / fps), '-i', video, '-t', String((s.to - s.from) / fps), ...PREVIEW, '-c:a', 'aac', '-b:a', '128k', path.join(dir, file)]);
    const text = script.beats.find(b => b.id === s.id)?.text ?? '';
    items.push({ id: s.id, text, file, seconds: +((s.to - s.from) / fps).toFixed(1), rerendered: s.rendered });
  }
  await writeFile(path.join(dir, 'scenes.json'), JSON.stringify({ video: name, createdAt: new Date().toISOString(), scenes: items }, null, 2));
  console.log(`scenes for review: out/scenes/ (${scenes.filter(s => s.rendered).length} re-rendered, ${scenes.filter(s => !s.rendered).length} unchanged)`);
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => { const v = args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  const name = args.find((a, i) => !a.startsWith('--') && !['--beats', '--scenes', '--frames'].includes(args[i - 1]));
  if (!name) throw new Error('usage: npm run render -- <name> [--sheet [--frames 30,240]] [--beats a,b] [--scenes [a,b]] [--fresh]');
  const beatsArg = valueOf('--beats')?.split(',');
  const dir = path.resolve('projects', name);
  const script = JSON.parse(await readFile(path.join(dir, 'script.json'), 'utf8').catch(() => {
    throw new Error(`projects/${name}/script.json missing`);
  })) as Script;
  await mkdir(path.join(dir, 'build'), { recursive: true });
  await mkdir(path.resolve('out'), { recursive: true });
  await writeLevels(dir);
  const props = { project: name, beats: beatsArg };
  const outName = beatsArg ? `${name}.${beatsArg.join('-')}` : name;

  if (args.includes('--sheet')) {
    const png = path.resolve('out', `${outName}.sheet.png`);
    const frames = valueOf('--frames')?.split(',').map(Number);
    await renderSheet({ composition: 'Video', props, output: png, frames });
    console.log(`wrote ${png}`);
    return;
  }

  const music = musicOf(script);
  if (music) {
    const { track } = music;
    const src = path.resolve('music', track);
    // The WAV keeps the track's own level (turning a quiet track up in a 16-bit file could clip);
    // the gain to MUSIC_LUFS is applied in the mix instead.
    const gain = MUSIC_LUFS - Number(measureLoudness(src).input_i);
    const wav = path.join(dir, 'build', 'music.wav');
    ffmpeg(['-i', src, '-ac', '2', '-ar', '48000', wav]);
    // Track length (16-bit stereo 48 kHz), so the video knows whether to loop it or let it end.
    const bytes = await readFile(wav);
    const durationMs = Math.round(((bytes.length - (bytes.indexOf('data') + 8)) / (48000 * 4)) * 1000);
    await writeFile(path.join(dir, 'build', 'music.json'), JSON.stringify({ track, gain: 10 ** (gain / 20), durationMs }, null, 2));
    console.log(`music: ${track}, ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB to ${MUSIC_LUFS} LUFS`);
  }

  const byScene = args.includes('--scenes') || args.includes('--fresh');
  const force = args.includes('--fresh') ? 'all' as const : valueOf('--scenes')?.split(',');
  const out = path.resolve('out', `${outName}.mp4`);
  const raw = path.join(dir, 'build', 'render.mp4');
  const mix = path.join(dir, 'build', 'render.wav');
  const job = { composition: 'Video', props, output: raw, audioOutput: mix };
  // A part keeps its own scene clips: each run deletes the clips it doesn't use.
  const sceneDir = path.join(dir, 'build', beatsArg ? `scenes.${beatsArg.join('-')}` : 'scenes');
  const result = byScene ? await renderScenes({ ...job, dir: sceneDir, force }) : { ...await renderVideo(job), scenes: null };
  if (!result.hasAudio) throw new Error('the video has no sound: run npm run voice first');

  // Two-pass loudnorm: linear gain when the peaks allow it, otherwise ffmpeg falls back to its dynamic mode.
  const m = measureLoudness(mix);
  const norm = `loudnorm=I=${OUT_LUFS}:TP=${OUT_TRUE_PEAK}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
    + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  ffmpeg(['-i', raw, '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', norm, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
  console.log(`audio: ${m.input_i} LUFS -> ${OUT_LUFS} LUFS`);

  ffmpeg(['-i', out, ...PREVIEW, out.replace(/\.mp4$/, '.preview.mp4')]);
  console.log(`wrote ${out} and its .preview.mp4`);
  if (result.scenes) await writeSceneClips(out, result.scenes, script, result.config.fps);
}

main().catch(err => { console.error(err); process.exit(1); });
