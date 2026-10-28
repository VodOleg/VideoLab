// Music: background tracks for videos, generated locally with ACE-Step 1.5 -> music/<name>-<seed>.wav (short loops; the video loops them)
// Usage: npm run music -- [--style speed-metal] [--prompt "..."] [--name <name>] [--seconds 16] [--bpm 140] [--count 3] [--seed 42]
//                         [--dit turbo|sft] [--lm 0.6B]   (sft: 50 steps, more detail; --lm: the 5Hz LM plans the song first)
// Also writes out/music-<name>-<seed>.mp3 to listen to on the served page.
// First run clones ACE-Step into .cache/ace-step, installs its Python env with uv, and downloads the models (~10GB).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './engine/ffmpeg.ts';

const ACESTEP_REPO = 'https://github.com/ACE-Step/ACE-Step-1.5.git';
const ACESTEP_COMMIT = 'ca1e85fe9430179831e6bc6be790c332190a3866';
const ACESTEP_DIR = path.resolve('.cache', 'ace-step');
const MUSIC_DIR = path.resolve('music');

/**
 * Instrumental styles. ACE-Step follows long prose captions (instruments, playing, production) better than tag lists,
 * and section tags in the lyrics give the track a structure. Describe the sound; don't name artists or songs.
 */
const STYLES: Record<string, { caption: string; lyrics: string; bpm: number }> = {
  // Late-70s British speed metal / rock'n'roll: chorded overdriven bass up front, raw and fast.
  'speed-metal': {
    caption: 'A raw, fast and loud instrumental heavy metal rock and roll track with the sound of late 1970s British speed metal. '
      + 'An overdriven, distorted bass guitar is played like a rhythm guitar, strumming gritty chords that roar at the front of the mix. '
      + 'A crunchy, loud electric guitar hammers out a fast, bluesy power-chord boogie riff with punk energy. '
      + 'The drums gallop at a breakneck pace with relentless double kick drums, crashing cymbals and a pounding snare. '
      + 'The production is gritty, dirty and live-sounding, like a power trio playing at full volume in a small club. '
      + 'The full band plays one continuous, steady riff from the first second to the last, with no intro, no breaks and no ending.',
    lyrics: '[Main Riff - full band]',
    bpm: 150, // 16s = exactly 10 bars of 4/4, so the loop lands on a bar line
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const style = opt('style') ?? 'speed-metal';
  const preset = STYLES[style];
  const prompt = opt('prompt');
  if (!preset && !prompt) throw new Error(`unknown --style ${style}; pick one of ${Object.keys(STYLES).join(', ')} or pass --prompt`);
  const count = Number(opt('count') ?? 3);
  const seed = opt('seed');
  const dit = opt('dit') ?? 'turbo';
  const lm = opt('lm') ?? null;
  if (!['turbo', 'sft'].includes(dit)) throw new Error('--dit is turbo or sft');
  return {
    name: opt('name') ?? `${prompt ? 'custom' : style}-${dit}${lm ? '-lm' : ''}`,
    caption: prompt ?? preset.caption,
    lyrics: prompt ? undefined : preset.lyrics,
    dit,
    lm,
    bpm: opt('bpm') ? Number(opt('bpm')) : preset?.bpm,
    key: opt('key'),
    seconds: Number(opt('seconds') ?? 16),
    seeds: seed ? [Number(seed)] : Array.from({ length: count }, () => Math.floor(Math.random() * 2 ** 31)),
  };
}

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ''}`);
}

/** uv from PATH, or as a Python module (`pip install uv`). */
function uv(): string[] {
  if (spawnSync('uv', ['--version']).status === 0) return ['uv'];
  return [process.platform === 'win32' ? 'py' : 'python3', '-m', 'uv'];
}

function installAceStep(uvCmd: string[]) {
  if (!existsSync(ACESTEP_DIR)) {
    run('git', ['clone', ACESTEP_REPO, ACESTEP_DIR]);
    run('git', ['checkout', ACESTEP_COMMIT], ACESTEP_DIR);
  }
  if (!existsSync(path.join(ACESTEP_DIR, '.venv'))) run(uvCmd[0], [...uvCmd.slice(1), 'sync'], ACESTEP_DIR);
}

async function main() {
  const { name, ...req } = parseArgs();
  const uvCmd = uv();
  installAceStep(uvCmd);
  await mkdir(MUSIC_DIR, { recursive: true });
  await mkdir(path.resolve('out'), { recursive: true });
  const requestFile = path.join(ACESTEP_DIR, 'videolab-request.json');
  await writeFile(requestFile, JSON.stringify({ ...req, name, outDir: MUSIC_DIR }, null, 2));
  console.log(`generating ${req.seeds.length} x ${req.seconds}s "${name}" (${req.bpm ?? 'auto'} bpm)`);
  run(uvCmd[0], [...uvCmd.slice(1), 'run', 'python', path.resolve('src', 'music_gen.py'), requestFile], ACESTEP_DIR);
  for (const seed of req.seeds) {
    const wav = path.join(MUSIC_DIR, `${name}-${seed}.wav`);
    ffmpeg(['-i', wav, '-b:a', '192k', path.resolve('out', `music-${name}-${seed}.mp3`)]);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
