// The video: one scene per beat (scenes.tsx) whose elements pop in on the script's cues, a narrator character that hops
// over to what's being said and points at it (plan.ts, Narrator.tsx), optional word-by-word captions, the voiceover and
// background music. Any frame shape: 16:9, 9:16 or 1:1.
import type React from 'react';
import { useMemo } from 'react';
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from '../engine/index.ts';
import type { MarkBox, Script, Timeline } from '../types.ts';
import { Captions } from './Captions.tsx';
import { fontFamily } from './fonts.ts';
import { musicGain, musicOf } from './music.ts';
import { blinkAt, Cab, Narrator } from './Narrator.tsx';
import { lookAt, narratorAt, planVideo, stageFor } from './plan.ts';
import { Alerts, DEFAULT_THEME, Notes, sceneOf, type Stage } from './scenes.tsx';

/** build/levels.json (written by npm run render): each beat's voiceover loudness, `rate` values a second, 0-1. */
export interface Levels { rate: number; beats: Record<string, number[]> }

export type VideoProps = {
  /** Folder under projects/. */
  project: string;
  /** Only these beats, back to back (a part to preview); default all. */
  beats?: string[];
  // Filled in by calculateMetadata from the folder.
  script?: Script;
  timeline?: Timeline;
  levels?: Levels | null;
  /** Natural sizes of the pictures image scenes show, by src. */
  images?: Stage['images'];
  /** Underline boxes found by OCR (build/marks.json), by "<src>|<text>". */
  marks?: Record<string, MarkBox[]>;
  musicFile?: string | null;
  musicLevel?: number;
  musicDurationMs?: number;
  /** Where in the track the video starts: the script's startMs, plus the skipped beats in a part. */
  musicStartMs?: number;
};

/** Scenes crossfade over this many frames: the next one fades in while the last one fades out, with no empty gap. */
const FADE_FRAMES = 8;

/** How open the mouth is at `ms`: the voice's loudness, or (before the voice step has run) a flap during each word. */
function mouthAt(timeline: Timeline, levels: Levels | null | undefined, ms: number) {
  const beat = timeline.beats.find(b => ms >= b.startMs && ms < b.endMs);
  if (!beat) return 0;
  const values = levels?.beats[beat.id];
  if (values) return values[Math.floor(((ms - beat.startMs) / 1000) * levels!.rate)] ?? 0;
  return beat.words.some(w => ms >= w.startMs && ms < w.endMs) ? 0.35 + 0.35 * Math.abs(Math.sin(ms / 50)) : 0;
}

export const Video: React.FC<VideoProps> = ({ project, script, timeline, levels, images = {}, marks = {}, musicFile, musicLevel = 1, musicDurationMs, musicStartMs = 0 }) => {
  if (!script || !timeline) throw new Error('Video data not loaded (calculateMetadata)');
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const character = script.narrator === 'cab' ? 'cab' : script.narrator === false ? null : 'ball';
  const baseImage = typeof script.narrator === 'object' ? script.narrator.image : undefined;
  const narrator = character !== null;
  const captions = script.captions ?? height > width;
  const theme = { ...DEFAULT_THEME, ...script.theme };
  const stage = useMemo(() => stageFor(width, height, { narrator, captions, images }), [width, height, narrator, captions, images]);
  const plan = useMemo(() => planVideo(script, timeline, fps, stage, durationInFrames), [script, timeline, fps, stage, durationInFrames]);
  const videoMs = (durationInFrames / fps) * 1000;
  const musicMs = musicDurationMs === undefined ? Infinity : musicDurationMs - musicStartMs;
  const loopMusic = musicMs < 0.75 * videoMs;
  const gain = useMemo(
    () => musicGain(script, timeline, videoMs, musicLevel, loopMusic ? Infinity : musicMs),
    [script, timeline, videoMs, musicLevel, loopMusic, musicMs],
  );
  const pose = narratorAt(plan.stops, frame, fps, plan.size.R);
  const scene = plan.beats.findLast(b => frame >= b.startFrame) ?? plan.beats[0];
  // The mouth moves a frame ahead of the sound, which reads as in sync.
  const mouth = mouthAt(timeline, levels, ((frame + 1) / fps) * 1000);
  const grid = Math.min(width, height) / 18;
  // Notifications come down under the scene's heading (its plate reaches a little past its box), else at the top.
  const alertTop = (heading?: { y: number; h: number }) => (heading ? heading.y + heading.h + 50 * stage.u : stage.content.y);

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: `${grid}px ${grid}px`, backgroundPosition: 'center',
        }}
      />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.45) 100%)' }} />

      {plan.beats.map((b, i) => {
        const { Component } = sceneOf(b.beat.scene);
        // Each scene but the last runs FADE_FRAMES past its end, fading out while the next fades in.
        const last = i === plan.beats.length - 1, length = b.endFrame - b.startFrame;
        const f = frame - b.startFrame;
        const fadeIn = b.instant ? 1 : interpolate(f, [0, FADE_FRAMES], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = last ? 1 : interpolate(f, [length, length + FADE_FRAMES], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <Sequence key={b.beat.id} from={b.startFrame} durationInFrames={length + (last ? 0 : FADE_FRAMES)}>
            <Component
              scene={b.beat.scene}
              beat={b.beat}
              layout={b.layout}
              stage={stage}
              theme={theme}
              project={project}
              shown={id => b.shown[id] ?? 0}
              cued={id => id in b.shown}
              look={id => lookAt(b, id, f, pose.target === `${i}:${id}` ? Math.min(1, pose.ext) : 0, fadeIn, fadeOut)}
              at={(phrase, fallback) => (phrase && phrase in b.phrases ? b.phrases[phrase] : fallback)}
              fade={fadeIn * fadeOut}
              marks={marks}
            />
            <Notes notes={b.notes} anchors={b.layout.anchors} theme={theme} u={stage.u} fade={fadeIn * fadeOut} />
            <Alerts alerts={b.alerts} top={alertTop(b.layout.anchors.heading)} stage={stage} theme={theme} fade={fadeIn * fadeOut} />
          </Sequence>
        );
      })}

      {/* Blinks restart each scene, so a scene that only moved in time looks the same (and keeps its rendered clip). */}
      {character && (() => {
        const Character = character === 'cab' ? Cab : Narrator;
        const image = baseImage && (plan.looks.findLast(l => frame >= l.frame)?.image ?? baseImage);
        return <Character pose={pose} R={plan.size.R} mouth={mouth} blink={blinkAt(frame - (scene?.startFrame ?? 0), fps, scene?.beat.id)} image={image && staticFile(`${project}/${image}`)} />;
      })()}
      {captions && <Captions timeline={timeline} />}

      {musicFile && musicOf(script) && (
        <Audio
          src={staticFile(musicFile)}
          trimBefore={Math.round((musicStartMs / 1000) * fps)}
          volume={f => gain((f / fps) * 1000)}
          loop={loopMusic}
        />
      )}
      {timeline.beats.map(b => b.audio && (
        <Sequence key={b.id} from={Math.round((b.startMs / 1000) * fps)}>
          <Audio src={staticFile(`${project}/${b.audio}`)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
