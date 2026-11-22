// A three.js view (react-three-fiber) drawn in step with the video: each frame's 3D content is drawn before the frame
// is captured, and whatever it waits for (models, fonts) holds the frame back like an image does. The content must be
// worked out from the frame like everything else (no clocks, no randomness, no useFrame animation), so that every page
// draws the same pixels. In the hidden fingerprinting run the view draws nothing and leaves its fingerprint in the DOM
// instead; on a contact sheet each view draws once, becomes a picture and gives back its WebGL context (a page can
// only keep about 16).
import React, { Suspense, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, extend, flushSync, useThree, type ReconcilerRoot, type RenderProps } from '@react-three/fiber';
import * as THREE from 'three';
import { cancelRender, continueRender, delayRender, useDrawMode } from './core.tsx';

// Every three.js class as an element (<mesh>, <color>...), as r3f's <Canvas> would do.
extend(THREE as unknown as Parameters<typeof extend>[0]);

/** An error in the 3D content (it renders in its own React root, out of the page's sight) stops the render with it. */
class Failed extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { cancelRender(err); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Contact-sheet views drawing at once: each holds a WebGL context until it has become a picture. */
const STILL_SLOTS = 4;
let freeSlots = STILL_SLOTS;
const waiting: Array<() => void> = [];
const takeSlot = () => new Promise<void>(resolve => {
  if (freeSlots > 0) { freeSlots--; resolve(); } else waiting.push(resolve);
});
const giveSlot = () => {
  const next = waiting.shift();
  if (next) next(); else freeSlots++;
};

/** Draws the scene once the content (and everything it suspended on) has committed, and says which version it drew. */
const Draw: React.FC<{ version: string; onDrawn: (version: string, canvas: HTMLCanvasElement) => void }> = ({ version, onDrawn }) => {
  const advance = useThree(s => s.advance);
  const gl = useThree(s => s.gl);
  useLayoutEffect(() => {
    advance(0);
    onDrawn(version, gl.domElement);
  });
  return null;
};

export interface ThreeViewProps {
  width: number;
  height: number;
  /**
   * Changes whenever the picture would (the frame's camera, objects, their looks): it's what tells the view to draw
   * again, and the frame's fingerprint for rendering scene by scene. Name the files the content loads (as staticFile
   * URLs) in it, so a changed file re-renders the scene.
   */
  fingerprint: string;
  /** Renderer settings, fixed for the view's life (shadows, colour handling). */
  setup?: Omit<RenderProps<HTMLCanvasElement>, 'size' | 'dpr' | 'frameloop' | 'gl' | 'events'>;
  style?: React.CSSProperties;
  /** react-three-fiber elements: the scene as it is on this frame. */
  children: React.ReactNode;
}

export const ThreeView: React.FC<ThreeViewProps> = ({ width, height, fingerprint, setup, style, children }) => {
  const mode = useDrawMode();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // What's on screen: a picture of the canvas. A WebGL canvas reaches the screen (and the capture) whenever the
  // browser next presents it, which in headless Chromium can be a frame late; a picture is waited for like any image.
  const [picture, setPicture] = useState<{ url: string; version: string } | null>(null);
  const s = useRef({
    root: null as ReconcilerRoot<HTMLCanvasElement> | null,
    opened: Promise.resolve() as Promise<unknown>,
    lock: null as number | null,
    wanted: '',
    slot: false,
    /** A contact sheet's view has its picture and has closed. */
    done: false,
    shown: null as string | null,
  }).current;
  const release = () => {
    if (s.lock !== null) continueRender(s.lock);
    s.lock = null;
  };
  const close = () => {
    s.root?.unmount();
    s.root = null;
    if (s.slot) giveSlot();
    s.slot = false;
  };

  // The r3f root on the canvas (on a contact sheet once a slot is free), for the view's life.
  useLayoutEffect(() => {
    if (mode === 'none') return;
    let closed = false;
    const canvas = canvasRef.current!;
    s.opened = (mode === 'still' ? takeSlot().then(() => { s.slot = true; }) : Promise.resolve()).then(() => {
      if (closed) return;
      s.root = createRoot(canvas);
      return s.root.configure({
        ...setup, size: { width, height, top: 0, left: 0 }, dpr: 1, frameloop: 'never',
        gl: { antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' },
      });
    });
    return () => {
      closed = true;
      s.opened.then(close);
      release();
      if (s.shown) URL.revokeObjectURL(s.shown);
      s.shown = null;
    };
  }, [mode, width, height]);

  // This frame's content, drawn and pictured before the frame can be captured.
  useLayoutEffect(() => {
    // Nothing to do when this frame is already the picture on screen (putting it up re-renders the view).
    if (mode === 'none' || s.done || picture?.version === fingerprint) return;
    s.wanted = fingerprint;
    if (s.lock === null) s.lock = delayRender('3D view');
    const onDrawn = (version: string, canvas: HTMLCanvasElement) => {
      if (version !== s.wanted) return;
      canvas.toBlob(blob => {
        if (!blob) return cancelRender(new Error('3D view: the canvas could not be read'));
        if (version === s.wanted) setPicture({ url: URL.createObjectURL(blob), version });
      }, 'image/png');
    };
    const content = <Failed><Suspense fallback={null}>{children}<Draw version={fingerprint} onDrawn={onDrawn} /></Suspense></Failed>;
    s.opened.then(() => { if (s.root) flushSync(() => s.root!.render(content)); });
  });

  // The picture is up: the frame can be captured (the page then waits for the image to decode).
  useLayoutEffect(() => {
    if (!picture) return;
    if (s.shown && s.shown !== picture.url) URL.revokeObjectURL(s.shown);
    s.shown = picture.url;
    if (picture.version !== s.wanted) return;
    if (mode === 'still') {
      s.done = true;
      s.opened.then(close);
    }
    release();
  }, [picture]);

  if (mode === 'none') {
    // The fingerprinting run: no WebGL, just a mark that changes with the picture. The bundle is named in it, so a code
    // change re-renders scenes with 3D in them (their pixels aren't in the DOM to compare).
    return <div data-three={fingerprint} data-code="/bundle/index.js" style={{ width, height, ...style }} />;
  }
  return (
    <div style={{ position: 'relative', width, height, ...style }}>
      <canvas ref={canvasRef} width={width} height={height} style={{ display: 'none' }} />
      {picture && <img src={picture.url} alt="" style={{ position: 'absolute', left: 0, top: 0, width, height }} />}
    </div>
  );
};
