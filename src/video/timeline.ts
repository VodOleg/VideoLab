// Word timing: estimated until the voice step writes timeline.json; phrases looked up in it; scene cuts from it.
import type { Timeline, TimelineBeat, Word } from '../types.ts';

const LEAD_IN_MS = 150;
const BEAT_GAP_MS = 400;

/** Rough speech timing: ~2.7 words/s, longer for long words, pauses after punctuation. */
export function estimateTimeline(script: { beats: Array<{ id: string; text: string }> }): Timeline {
  let t = LEAD_IN_MS;
  const beats: TimelineBeat[] = script.beats.map(beat => {
    const startMs = t;
    const words: Word[] = beat.text.split(/\s+/).filter(Boolean).map(text => {
      const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
      const w = { text, startMs: t, endMs: t + 110 + 48 * letters };
      t = w.endMs + (/[.?!:]$/.test(text) ? 320 : /,$/.test(text) ? 160 : 40);
      return w;
    });
    const endMs = words.at(-1)?.endMs ?? startMs;
    t = endMs + BEAT_GAP_MS;
    return { id: beat.id, startMs, endMs, words };
  });
  return { estimated: true, durationMs: beats.at(-1)?.endMs ?? 0, beats };
}

const normalize = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Start time of the first occurrence of `phrase` in `words`, or null. */
export function findPhrase(words: Word[], phrase: string): number | null {
  const tokens = phrase.split(/\s+/).map(normalize).filter(Boolean);
  for (let i = 0; i + tokens.length <= words.length; i++) {
    if (tokens.every((tok, j) => normalize(words[i + j].text) === tok)) return words[i].startMs;
  }
  return null;
}

/** Scenes for rendering scene by scene (npm run render -- <name> --scenes): one per beat, from its voice (less `leadFrames`). */
export function beatScenes(timeline: Timeline, fps: number, leadFrames = 0) {
  return timeline.beats.map(b => ({ id: b.id, from: Math.max(0, Math.round((b.startMs / 1000) * fps) - leadFrames) }));
}
