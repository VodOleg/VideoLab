// whisper.cpp word timings: a 16 kHz mono WAV -> its words with start and end times. Runs the whisper.cpp 1.5 build in
// .cache/whisper (installed by hand, see README); the base.en model downloads on first use.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Word } from './types.ts';

const MODEL = 'base.en';
const DIR = path.resolve('.cache', 'whisper');
const EXE = path.join(DIR, process.platform === 'win32' ? 'main.exe' : 'main');
const MODEL_FILE = path.join(DIR, `ggml-${MODEL}.bin`);

export async function installWhisper() {
  if (!existsSync(EXE)) {
    throw new Error(`whisper.cpp isn't installed: ${EXE} is missing. Put a whisper.cpp 1.5 build in .cache/whisper `
      + '(Windows: unzip whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases/tag/v1.5.4 there; '
      + 'Linux/macOS: git clone --branch v1.5.4 https://github.com/ggml-org/whisper.cpp .cache/whisper && make -C .cache/whisper main).');
  }
  if (!existsSync(MODEL_FILE)) {
    console.log(`Downloading the whisper model ${MODEL}`);
    const res = await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin`);
    if (!res.ok) throw new Error(`whisper model download failed: ${res.status} ${res.statusText}`);
    await writeFile(MODEL_FILE, Buffer.from(await res.arrayBuffer()));
  }
}

interface WhisperJson { transcription: Array<{ text: string; offsets: { from: number; to: number } }> }

/** The words whisper hears in `wav` (one segment per word: --max-len 1 --split-on-word), without [sound] tags. */
export function transcribeWords(wav: string): Word[] {
  // Absolute: whisper.cpp runs in its own folder.
  const out = path.resolve(wav).replace(/\.wav$/, '') + '.whisper';
  const json = `${out}.json`;
  rmSync(json, { force: true });
  const r = spawnSync(EXE, ['-f', path.resolve(wav), '--output-file', out, '--output-json', '--output-json-full', '--max-len', '1', '--split-on-word', '-m', MODEL_FILE], { cwd: DIR, encoding: 'utf8' });
  // whisper.cpp sometimes exits with an error code after writing its output.
  if (!existsSync(json)) throw new Error(`whisper.cpp failed on ${wav} (exit ${r.status})\n${r.stderr}`);
  const { transcription } = JSON.parse(readFileSync(json, 'utf8')) as WhisperJson;
  rmSync(json);
  return transcription
    .filter(t => t.text.trim() && !/^\s*\[.*\]\s*$/.test(t.text))
    .map(t => ({ text: t.text.trim(), startMs: t.offsets.from, endMs: t.offsets.to }));
}
