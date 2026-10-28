// The page a video is drawn in. registerRoot() takes the project's compositions; the renderer (render.ts) then drives it
// through window.engine (load a composition, draw frame n, collect the soundtrack), and with ?studio it opens the player.
import type React from 'react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AudioSinkContext, ConfigContext, TimingContext, whenNothingPending, type AudioReport, type VideoConfig } from './core.tsx';

/** Where a scene starts; it runs until the next one. Rendering scene by scene re-renders only the scenes that changed. */
export interface SceneCut { id: string; from: number }

export interface Metadata<P> {
  width: number; height: number; fps: number; durationInFrames: number; props: P;
  /** The video's scenes (default: one). */
  scenes?: SceneCut[];
}

/** Works out a composition's real size, length and props from its default ones (e.g. by fetching the project's files). */
export type CalculateMetadataFunction<P> = (args: { props: P }) => Promise<Partial<Metadata<P>>> | Partial<Metadata<P>>;

export interface CompositionDef<P> extends Omit<Metadata<P>, 'props'> {
  id: string;
  component: React.ComponentType<P>;
  defaultProps: P;
  calculateMetadata?: CalculateMetadataFunction<P>;
}

// The list given to registerRoot mixes compositions with different props.
export type AnyComposition = CompositionDef<any>;

/** A composition, typed by its props (the list given to registerRoot holds any). */
export const composition = <P extends object>(def: CompositionDef<P>): AnyComposition => def;

export interface Resolved { def: AnyComposition; config: VideoConfig; props: object; scenes: SceneCut[] }

/** One Audio element's part of the soundtrack: where it starts and its volume on every frame it's on. */
export interface AudioTrack { src: string; start: number; trimBefore: number; loop: boolean; frames: Array<[frame: number, volume: number]> }

/** What a run over every frame finds: the soundtrack, and (when asked) each frame's fingerprint and the files it shows. */
export interface DryRun {
  tracks: AudioTrack[];
  /** Per frame, a hash of its DOM: the same DOM draws the same pixels. */
  fingerprints: number[];
  /** Served files (/static/, /bundle/) the frames show, with the runs of frames that show them. */
  files: Array<[url: string, runs: Array<[first: number, last: number]>]>;
}

export interface EngineApi {
  compositions(): Array<Omit<AnyComposition, 'component' | 'calculateMetadata'>>;
  /** Mounts a composition at frame 0 and resolves (with its size, length and scenes) once that frame is ready to capture. */
  load(id: string, props?: object): Promise<{ config: VideoConfig; scenes: SceneCut[] }>;
  /** Draws frame n; resolves once it's ready to capture. */
  frame(n: number): Promise<void>;
  /** The loaded composition's soundtrack, and with `fingerprint` the frames' fingerprints. */
  dryRun(fingerprint: boolean): Promise<DryRun>;
  /** Replaces the frame with a contact sheet of these frames; resolves (with its size) once it's ready to capture. */
  sheet(cells: SheetCell[], cols: number, cellWidth: number): Promise<{ width: number; height: number }>;
}

export interface SheetCell { frame: number; label: string }
const SHEET_LABEL_H = 34;

declare global { interface Window { engine: EngineApi } }

const READY_TIMEOUT_MS = 60_000;

export async function resolve(def: AnyComposition, props: object = {}): Promise<Resolved> {
  const merged = { ...def.defaultProps, ...props };
  const meta = (await def.calculateMetadata?.({ props: merged })) ?? {};
  const { width = def.width, height = def.height, fps = def.fps, durationInFrames = def.durationInFrames } = meta;
  // Scenes in order, inside the video, the first from frame 0.
  const cuts = [...(meta.scenes ?? def.scenes ?? [])].sort((a, b) => a.from - b.from).filter(s => s.from < durationInFrames);
  const ids = new Set<string>();
  for (const s of cuts) {
    if (ids.has(s.id)) throw new Error(`two scenes called "${s.id}" in ${def.id}`);
    ids.add(s.id);
  }
  const scenes = cuts.filter((s, i) => cuts[i + 1]?.from !== s.from); // an empty scene gives way to the next
  if (scenes.length) scenes[0] = { ...scenes[0], from: 0 }; // the first scene starts the video (lead-in included)
  else scenes.push({ id: 'all', from: 0 });
  return { def, config: { id: def.id, width, height, fps, durationInFrames }, props: meta.props ?? merged, scenes };
}

/** cyrb53 (public domain): a fast 53-bit string hash, plenty to tell frames apart. */
function hash(text: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Served files in the DOM: <img src>, and url() in styles (escaped as &quot; inside the style attribute).
const FILE_URL = /\/(?:static|bundle)\/[^"'()\s&<>]+/g;

type Sink = (report: AudioReport) => void;

/** The composition at one frame, in a box of its own size. `sink` collects its audio. */
export const Stage: React.FC<{ resolved: Resolved; frame: number; sink?: Sink }> = ({ resolved: { def, config, props }, frame, sink = null }) => {
  const Component = def.component;
  return (
    <ConfigContext.Provider value={config}>
      <TimingContext.Provider value={{ frame, offset: 0, frozen: false }}>
        <AudioSinkContext.Provider value={sink}>
          <div style={{ position: 'relative', width: config.width, height: config.height, overflow: 'hidden' }}>
            <Component {...props} />
          </div>
        </AudioSinkContext.Provider>
      </TimingContext.Provider>
    </ConfigContext.Provider>
  );
};

/** A React root whose frame can be set from outside, synchronously; it throws what the components threw. */
export class FrameRoot {
  private root: Root;
  private setFrame: ((n: number) => void) | null = null;
  private error: unknown = null;

  constructor(readonly host: HTMLElement) {
    this.root = createRoot(host, { onUncaughtError: e => { this.error = e; } });
  }

  mount(resolved: Resolved, frame = 0, sink?: Sink) {
    const Driven = () => {
      const [n, setN] = useState(frame);
      this.setFrame = setN;
      return <Stage resolved={resolved} frame={n} sink={sink} />;
    };
    this.error = null;
    flushSync(() => this.root.render(<Driven />));
    this.check();
  }

  show(n: number) {
    flushSync(() => this.setFrame!(n));
    this.check();
  }

  /** A contact sheet instead: the composition at several frames, scaled into a labelled grid. Returns its size. */
  mountSheet(resolved: Resolved, cells: SheetCell[], cols: number, cellWidth: number) {
    const { width, height } = resolved.config;
    const scale = cellWidth / width, cellHeight = Math.round(height * scale);
    this.error = null;
    flushSync(() => this.root.render(
      <div style={{ display: 'flex', flexWrap: 'wrap', width: cols * cellWidth, background: '#1a1b22' }}>
        {cells.map(({ frame, label }) => (
          <div key={frame} style={{ position: 'relative', width: cellWidth, height: SHEET_LABEL_H + cellHeight, overflow: 'hidden' }}>
            <div style={{ height: SHEET_LABEL_H, padding: '7px 10px', font: '700 16px system-ui, sans-serif', color: '#ffd84d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {label}
            </div>
            <div style={{ position: 'absolute', top: SHEET_LABEL_H, left: 0, width, height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
              <Stage resolved={resolved} frame={frame} />
            </div>
          </div>
        ))}
      </div>,
    ));
    this.check();
    return { width: cols * cellWidth, height: Math.ceil(cells.length / cols) * (SHEET_LABEL_H + cellHeight) };
  }

  unmount() { this.root.unmount(); }

  private check() {
    if (this.error) throw this.error;
  }
}

const decoded = new WeakMap<HTMLImageElement, string>();

/** Waits for fonts, delayRender() locks, and every image in `host` to be loaded and decoded. */
export async function ready(host: HTMLElement) {
  await whenNothingPending(READY_TIMEOUT_MS);
  await document.fonts.ready;
  const images = [...host.querySelectorAll('img')].filter(img => img.getAttribute('src') && decoded.get(img) !== img.src);
  await Promise.all(images.map(img => img.decode().then(
    () => { decoded.set(img, img.src); },
    () => { throw new Error(`image failed to load: ${decodeURIComponent(img.src)}`); },
  )));
}

/**
 * A run over every frame in a hidden copy of the composition (the visible one keeps its frame): the soundtrack, and
 * with `fingerprint` each frame's DOM hash and the files it shows. Anything drawn outside the DOM (a canvas) or set
 * up in code (a font's files) isn't in the fingerprint.
 */
export async function dryRun(resolved: Resolved, fingerprint: boolean): Promise<DryRun> {
  const host = document.createElement('div');
  host.style.display = 'none';
  document.body.append(host);
  const tracks = new Map<string, AudioTrack>();
  const sink: Sink = r => {
    const key = `${r.src}|${r.start}|${r.trimBefore}|${r.loop}`;
    let track = tracks.get(key);
    if (!track) tracks.set(key, track = { src: r.src, start: r.start, trimBefore: r.trimBefore, loop: r.loop, frames: [] });
    track.frames.push([r.frame, r.volume]);
  };
  const fingerprints: number[] = [];
  const files = new Map<string, Array<[number, number]>>();
  const record = (f: number) => {
    if (!fingerprint) return;
    const html = host.innerHTML;
    fingerprints.push(hash(html));
    for (const url of new Set(html.match(FILE_URL))) {
      const runs = files.get(url) ?? [];
      const last = runs.at(-1);
      if (last && last[1] === f - 1) last[1] = f;
      else runs.push([f, f]);
      files.set(url, runs);
    }
  };
  const root = new FrameRoot(host);
  try {
    root.mount(resolved, 0, sink);
    record(0);
    for (let f = 1; f < resolved.config.durationInFrames; f++) {
      root.show(f);
      record(f);
      if (f % 200 === 0) await new Promise(r => setTimeout(r)); // let the page breathe
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return { tracks: [...tracks.values()], fingerprints, files: [...files] };
}

export function registerRoot(compositions: AnyComposition[]) {
  const find = (id: string) => {
    const def = compositions.find(c => c.id === id);
    if (!def) throw new Error(`no composition "${id}" (${compositions.map(c => c.id).join(', ')})`);
    return def;
  };
  const host = document.getElementById('root')!;
  let stage: FrameRoot | null = null;
  let loaded: Resolved | null = null;

  window.engine = {
    compositions: () => compositions.map(({ component, calculateMetadata, ...rest }) => rest),
    async load(id, props) {
      loaded = await resolve(find(id), props);
      stage?.unmount();
      stage = new FrameRoot(host);
      stage.mount(loaded, 0);
      await ready(host);
      return { config: loaded.config, scenes: loaded.scenes };
    },
    async frame(n) {
      stage!.show(n);
      await ready(host);
    },
    dryRun: fingerprint => dryRun(loaded!, fingerprint),
    async sheet(cells, cols, cellWidth) {
      const size = stage!.mountSheet(loaded!, cells, cols, cellWidth);
      await ready(host);
      return size;
    },
  };

  if (new URLSearchParams(location.search).has('studio')) {
    import('./player.tsx').then(m => m.startPlayer(compositions, host));
  }
}
