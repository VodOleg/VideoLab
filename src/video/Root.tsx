import { composition, staticFile, type CalculateMetadataFunction } from '../engine/index.ts';
import type { Format, MarkBox, Script, Timeline } from '../types.ts';
import { musicOf } from './music.ts';
import { carryScenes } from './carry.ts';
import { SCENE_LEAD_FRAMES } from './plan.ts';
import { beatScenes, estimateTimeline } from './timeline.ts';
import { Video, type Levels, type VideoProps } from './Video.tsx';

const FPS = 30;
const LEAD_IN_MS = 150;
const TAIL_MS = 1200;

export const SIZES: Record<Format, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

async function fetchJson<T>(file: string): Promise<T | null> {
  const res = await fetch(staticFile(file), { cache: 'no-store' });
  return res.ok ? ((await res.json()) as T) : null;
}

/** npm run render copies the script's music track to build/music.wav, with its loudness gain in build/music.json. */
async function loadMusic(dir: string, script: Pick<Script, 'music'>) {
  let musicFile: string | null = null;
  let musicLevel = 1;
  let musicDurationMs: number | undefined;
  const music = musicOf(script);
  if (music) {
    const { track } = music;
    const prepared = await fetchJson<{ track: string; gain: number; durationMs?: number }>(`${dir}/build/music.json`);
    if (prepared?.track === track) {
      musicFile = `${dir}/build/music.wav`;
      musicLevel = prepared.gain;
      musicDurationMs = prepared.durationMs;
    } else console.warn(`music/${track} isn't prepared in projects/${dir}/build: run npm run render to hear it`);
  }
  return { musicFile, musicLevel, musicDurationMs };
}

/** Natural sizes of the pictures the image scenes show (layouts fit them to the stage). */
async function imageSizes(dir: string, script: Script) {
  const sizes: Record<string, { w: number; h: number }> = {};
  await Promise.all(script.beats.map(b => b.scene).filter(s => s?.type === 'image').map(async s => {
    if (s.type !== 'image') return;
    const img = new Image();
    img.src = /^https?:/.test(s.src) ? s.src : staticFile(`${dir}/${s.src}`);
    try {
      await img.decode();
    } catch {
      throw new Error(`projects/${dir}/${s.src} can't be loaded (an image scene's src is relative to the project folder)`);
    }
    if (img.naturalWidth && img.naturalHeight) sizes[s.src] = { w: img.naturalWidth, h: img.naturalHeight };
  }));
  return sizes;
}

/** A project's script, voice timing and music; with `beats`, only those beats, moved up to start the video. */
const calculateVideo: CalculateMetadataFunction<VideoProps> = async ({ props }) => {
  const dir = props.project;
  const [loaded, voiced, levels] = await Promise.all([
    fetchJson<Script>(`${dir}/script.json`),
    fetchJson<Timeline>(`${dir}/build/timeline.json`),
    fetchJson<Levels>(`${dir}/build/levels.json`),
  ]);
  if (!loaded) throw new Error(`projects/${dir}/script.json missing`);
  // 3d scenes carried on from an earlier beat's get its objects and lights here.
  let script = carryScenes(loaded);
  let timeline = voiced ?? estimateTimeline(script);
  let offsetMs = 0;
  if (props.beats?.length) {
    const only = props.beats;
    const missing = only.filter(id => !timeline.beats.some(b => b.id === id));
    if (missing.length) throw new Error(`no beats ${missing.join(', ')} in projects/${dir} (${timeline.beats.map(b => b.id).join(', ')})`);
    const beats = timeline.beats.filter(b => only.includes(b.id));
    offsetMs = beats[0].startMs - LEAD_IN_MS;
    const shift = (ms: number) => ms - offsetMs;
    timeline = {
      ...timeline,
      durationMs: shift(beats.at(-1)!.endMs),
      beats: beats.map(b => ({ ...b, startMs: shift(b.startMs), endMs: shift(b.endMs), words: b.words.map(w => ({ ...w, startMs: shift(w.startMs), endMs: shift(w.endMs) })) })),
    };
    script = { ...script, beats: script.beats.filter(b => only.includes(b.id)) };
  }
  // Underlines found by OCR (npm run render writes build/marks.json when image scenes have marks).
  const hasMarks = script.beats.some(b => b.scene?.type === 'image' && b.scene.marks?.some(m => !m.box));
  const marks = hasMarks ? await fetchJson<Record<string, MarkBox[]>>(`${dir}/build/marks.json`) : null;
  if (hasMarks && !marks) console.warn(`projects/${dir}/build/marks.json missing: run npm run render to find the underlined words`);
  const format = script.format ?? '16:9';
  if (!SIZES[format]) throw new Error(`format "${format}" isn't one of ${Object.keys(SIZES).join(', ')}`);
  return {
    ...SIZES[format],
    // The last beat's hold keeps its picture up at the end too.
    durationInFrames: Math.ceil(((timeline.durationMs + TAIL_MS + (script.beats.at(-1)?.holdMs ?? 0)) / 1000) * FPS),
    scenes: beatScenes(timeline, FPS, SCENE_LEAD_FRAMES),
    props: {
      ...props, script, timeline, levels, images: await imageSizes(dir, script), marks: marks ?? {},
      ...(await loadMusic(dir, script)), musicStartMs: (musicOf(script)?.startMs ?? 0) + offsetMs,
    },
  };
};

export const compositions = [
  composition<VideoProps>({ id: 'Video', component: Video, ...SIZES['16:9'], fps: FPS, durationInFrames: FPS * 60, defaultProps: { project: 'example' }, calculateMetadata: calculateVideo }),
];
