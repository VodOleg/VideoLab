// What components use to draw a frame: the frame number, the video's size, time-shifted sequences, images, audio and fonts.
// The renderer (render.ts) and the studio drive the frame through page.tsx.
import type React from 'react';
import { createContext, useContext, useLayoutEffect } from 'react';

export interface VideoConfig { id: string; width: number; height: number; fps: number; durationInFrames: number }

export const ConfigContext = createContext<VideoConfig | null>(null);

/** The frame a component sees, and where its sequence starts on the video's timeline (audio needs both). */
export interface Timing { frame: number; offset: number; frozen: boolean }
export const TimingContext = createContext<Timing>({ frame: 0, offset: 0, frozen: false });

/** The current frame, counted from the start of the enclosing Sequence. */
export const useCurrentFrame = () => useContext(TimingContext).frame;

/**
 * How the composition is being drawn: 'video' (frames to capture, or the studio), 'still' (a contact sheet: many
 * frames on one page, each drawn once) or 'none' (the hidden run that only collects the soundtrack and fingerprints:
 * costly drawing can be skipped, as long as the DOM still tells the frames apart).
 */
export type DrawMode = 'video' | 'still' | 'none';
export const DrawModeContext = createContext<DrawMode>('video');
export const useDrawMode = () => useContext(DrawModeContext);

export function useVideoConfig(): VideoConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error('useVideoConfig outside a composition');
  return config;
}

const FILL: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' };

/** A div covering its parent, laying children out in a column. */
export const AbsoluteFill: React.FC<React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }> = ({ style, ...props }) => (
  <div {...props} style={{ ...FILL, ...style }} />
);

/**
 * Shows its children from frame `from` for `durationInFrames`, with their frame counted from `from`. Children fill
 * the parent like AbsoluteFill unless layout is 'none'.
 */
export const Sequence: React.FC<{ from?: number; durationInFrames?: number; layout?: 'absolute-fill' | 'none'; style?: React.CSSProperties; children?: React.ReactNode }> = ({
  from = 0, durationInFrames = Infinity, layout = 'absolute-fill', style, children,
}) => {
  const parent = useContext(TimingContext);
  const frame = parent.frame - from;
  if (frame < 0 || frame >= durationInFrames) return null;
  const inner = <TimingContext.Provider value={{ frame, offset: parent.offset + from, frozen: parent.frozen }}>{children}</TimingContext.Provider>;
  return layout === 'none' ? inner : <AbsoluteFill style={style}>{inner}</AbsoluteFill>;
};

/** Children see `frame` whatever the current frame is (stills of other moments, like the contact sheet). Their audio is silent. */
export const Freeze: React.FC<{ frame: number; children?: React.ReactNode }> = ({ frame, children }) => {
  const parent = useContext(TimingContext);
  return <TimingContext.Provider value={{ frame, offset: parent.offset, frozen: true }}>{children}</TimingContext.Provider>;
};

/** An image; frames are only captured once every image on them has loaded and decoded, and one that fails stops the render. */
export const Img: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = props => <img alt="" {...props} />;

/** A file in the public folder (projects/), as a URL. */
export const staticFile = (file: string) => `/static/${file.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;

// Work a frame waits for before it's captured (fonts, data). Like a lock: delayRender takes it, continueRender releases it.
// cancelRender fails the frame instead (work that went wrong where no one else would hear of it).
const pending = new Map<number, string>();
let nextHandle = 0;
const waiters = new Set<{ done: () => void; fail: (err: unknown) => void }>();
let failure: unknown = null;

export function delayRender(label = 'delayRender'): number {
  pending.set(++nextHandle, label);
  return nextHandle;
}

export function continueRender(handle: number) {
  pending.delete(handle);
  if (!pending.size) for (const w of waiters) w.done();
}

/** Stops the render: the frame being waited for (and every one after) fails with `err`. */
export function cancelRender(err: unknown) {
  failure ??= err instanceof Error ? err : new Error(String(err));
  for (const w of waiters) w.fail(failure);
}

/** Resolves once nothing holds delayRender; rejects after `timeoutMs`, naming what was still pending, or on cancelRender. */
export function whenNothingPending(timeoutMs: number): Promise<void> {
  if (failure) return Promise.reject(failure);
  if (!pending.size) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = {
      done: () => { clearTimeout(timer); waiters.delete(waiter); resolve(); },
      fail: (err: unknown) => { clearTimeout(timer); waiters.delete(waiter); reject(err); },
    };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`still waiting after ${timeoutMs / 1000}s for: ${[...pending.values()].join(', ')}`)); }, timeoutMs);
    waiters.add(waiter);
  });
}

/** Loads font files (one per weight, any format the browser reads) under `family`, which it returns for CSS. */
export function loadFont(family: string, weights: Record<number, string>, style: 'normal' | 'italic' = 'normal'): string {
  if (typeof document === 'undefined') return family;
  const handle = delayRender(`font ${family}`);
  Promise.all(Object.entries(weights).map(async ([weight, url]) => {
    const face = new FontFace(family, `url(${url})`, { weight, style });
    document.fonts.add(await face.load());
  })).then(() => continueRender(handle), err => { console.error(`font ${family} failed to load`, err); continueRender(handle); });
  return family;
}

/** What an Audio element reports for every frame it's on screen (render.ts mixes the soundtrack from these). */
export interface AudioReport { src: string; start: number; trimBefore: number; loop: boolean; frame: number; volume: number }

/** Set only in the hidden copy that collects the soundtrack (page.tsx), so what's on screen never reports twice. */
export const AudioSinkContext = createContext<((report: AudioReport) => void) | null>(null);

export interface AudioProps {
  src: string;
  /** Linear gain, or a function of the frame (counted from the sequence's start). */
  volume?: number | ((frame: number) => number);
  /** Frames to skip at the start of the file. */
  trimBefore?: number;
  /** Repeat the file (after trimBefore) until the sequence ends. */
  loop?: boolean;
}

/** Plays `src` from the start of the enclosing Sequence. Draws nothing; the renderer mixes it into the soundtrack. */
export const Audio: React.FC<AudioProps> = ({ src, volume = 1, trimBefore = 0, loop = false }) => {
  const { frame, offset, frozen } = useContext(TimingContext);
  const sink = useContext(AudioSinkContext);
  useLayoutEffect(() => {
    if (!sink || frozen) return;
    sink({ src, start: offset, trimBefore, loop, frame: offset + frame, volume: typeof volume === 'function' ? volume(frame) : volume });
  });
  return null;
};
