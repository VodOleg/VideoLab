// Background music gain: a steady bed that ducks under the voiceover and fades in/out at the ends.
import type { Script, Timeline } from '../types.ts';

const MERGE_MS = 700; // speech gaps shorter than this stay ducked (beat gaps, "..." pauses)
const ATTACK_MS = 150; // duck down this long before a word
const RELEASE_MS = 500; // and come back up over this long after the last one
const FADE_IN_MS = 400;
const FADE_OUT_MS = 1500;

export const MUSIC_DEFAULTS = { volume: 0.3, duck: 0.35 };

/** The script's background track, or null for none. */
export const musicOf = (script: Pick<Script, 'music'>) => script.music ?? null;

/** Spans of continuous speech, in ms. */
function speechSpans(timeline: Timeline): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const w of timeline.beats.flatMap(b => b.words)) {
    const last = spans.at(-1);
    if (last && w.startMs - last[1] < MERGE_MS) last[1] = Math.max(last[1], w.endMs);
    else spans.push([w.startMs, w.endMs]);
  }
  return spans;
}

/**
 * Returns gain(ms) for the music track over a video of `totalMs`; `level` brings the track to a standard loudness.
 * `endMs`: when a track that isn't looped runs out (the fade-out ends there if that's before the video ends).
 */
export function musicGain(script: Pick<Script, 'music'>, timeline: Timeline, totalMs: number, level = 1, endMs = Infinity) {
  const fadeEnd = Math.min(totalMs, endMs);
  const music = musicOf(script);
  const volume = Math.min(1, (music?.volume ?? MUSIC_DEFAULTS.volume) * level);
  const duck = music?.duck ?? MUSIC_DEFAULTS.duck;
  const spans = speechSpans(timeline);
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

  return (ms: number) => {
    // How ducked we are: 1 inside speech, ramping to 0 around it.
    let d = 0;
    for (const [a, b] of spans) {
      if (ms < a - ATTACK_MS) break;
      d = Math.max(d, ms < a ? 1 - (a - ms) / ATTACK_MS : ms <= b ? 1 : 1 - (ms - b) / RELEASE_MS);
    }
    const fade = Math.min(clamp01(ms / FADE_IN_MS), clamp01((fadeEnd - ms) / FADE_OUT_MS));
    return volume * (1 - clamp01(d) * (1 - duck)) * fade;
  };
}
