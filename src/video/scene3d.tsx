// 3d: objects in a lit 3D space (three.js, drawn by react-three-fiber through the engine's ThreeView), a camera that
// frames them by meaning and glides from shot to shot, objects that move, spin and float, figures built from parts,
// screens showing slides, and a theatre spotlight. Everything on a frame is worked out here from the frame, outside
// three.js (the camera, where things are, how they look), and the same numbers place what's drawn in HTML on top: the
// heading, name tags, and the boxes the narrator and notes go by.
import type React from 'react';
import { use, useLayoutEffect, useMemo, useRef } from 'react';
import { Environment, Lightformer, RoundedBox, useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { parse as parseFont, type Font as OpenTypeFont } from 'opentype.js';
import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { Font, type FontData } from 'three/addons/loaders/FontLoader.js';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';
import fontUrl from '@fontsource/montserrat/files/montserrat-latin-900-normal.woff';
import { Easing, spring, staticFile, ThreeView, useCurrentFrame, useVideoConfig } from '../engine/index.ts';
import type { Box, Scene, Shot, Slide, Theme, Thing } from '../types.ts';
import { fontFamily, monoFamily } from './fonts.ts';
import { El, headed, Heading, STEP_COLORS, Text, toneColor, withAlpha, type Look, type SceneDef, type Stage } from './scenes.tsx';

// Screens light what's in front of them with rect-area lights.
RectAreaLightUniformsLib.init();

type Scene3D = Extract<Scene, { type: '3d' }>;
type V3 = [number, number, number];
/** The frame (within the scene) the voice reaches a phrase; 0 without one. */
type FrameOf = (phrase?: string) => number;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(...a);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const rad = (deg: number) => (deg * Math.PI) / 180;
const ease = Easing.inOut(Easing.cubic);
/** Numbers in fingerprints: rounded, so float noise doesn't count as a change. */
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** When something timed by a phrase starts: the phrase's frame, plus `wait` seconds. */
const startOf = (item: { at?: string; wait?: number }, frameOf: FrameOf, fps: number) => frameOf(item.at) + Math.round((item.wait ?? 0) * fps);

/** An object's size in metres, [width, height, depth] (text's is estimated from its letters; it's drawn from the font). */
export function sizeOf(o: Thing): V3 {
  if (Array.isArray(o.size)) return o.size;
  if (o.shape === 'screen' && o.size === undefined) return [3.2, 1.8, 0.08];
  const n = o.size ?? (o.shape === 'text' ? 0.5 : o.shape === 'group' ? 0.5 : 1);
  switch (o.shape) {
    case 'cylinder': case 'cone': return [0.8 * n, n, 0.8 * n];
    case 'torus': return [n, n, 0.24 * n];
    case 'capsule': return [0.42 * n, n, 0.42 * n];
    case 'text': return [0.68 * n * (o.text ?? '').length, 0.72 * n, 0.25 * n];
    case 'screen': return [n, (n * 9) / 16, 0.08];
    default: return [n, n, n];
  }
}

const turnOf = (t: Thing['turn']): V3 => (t === undefined ? [0, 0, 0] : typeof t === 'number' ? [0, t, 0] : t);

interface Pose { at: V3; turn: V3; scale: number }

/** Where an object is on frame `f`, in its parent's frame: its moves so far (eased, each from wherever the ones before had it), spin and float. */
function poseAt(o: Thing, f: number, fps: number, frameOf: FrameOf): Pose {
  let pose: Pose = { at: o.at ?? [0, 0, 0], turn: turnOf(o.turn), scale: o.scale ?? 1 };
  const moves = (o.moves ?? []).map(m => ({ m, start: startOf(m, frameOf, fps) })).sort((a, b) => a.start - b.start);
  for (const { m, start } of moves) {
    if (f < start) break;
    const p = ease(clamp01((f - start) / Math.max(1, (m.seconds ?? 1) * fps)));
    pose = {
      at: m.to ? lerp3(pose.at, m.to, p) : pose.at,
      turn: m.turn !== undefined ? lerp3(pose.turn, turnOf(m.turn), p) : pose.turn,
      scale: m.scale !== undefined ? lerp(pose.scale, m.scale, p) : pose.scale,
    };
  }
  const t = f / fps;
  if (o.spin) pose.turn = [pose.turn[0], pose.turn[1] + o.spin * t, pose.turn[2]];
  if (o.float) pose.at = [pose.at[0], pose.at[1] + 0.06 * sizeOf(o)[1] * (1 + Math.sin((2 * Math.PI * t) / 2.6)), pose.at[2]];
  return pose;
}

/** How far an object has walked by frame `f` (across the floor), and how fast it's going (metres a second). */
function walked(o: Thing, f: number, fps: number, frameOf: FrameOf): { distance: number; speed: number } {
  let distance = 0, step = 0, prev = poseAt(o, 0, fps, frameOf).at;
  for (let i = 1; i <= f; i++) {
    const p = poseAt(o, i, fps, frameOf).at;
    step = Math.hypot(p[0] - prev[0], p[2] - prev[2]);
    distance += step;
    prev = p;
  }
  return { distance, speed: step * fps };
}

/** One stride (two steps) of a walking figure, in metres. */
const STRIDE_M = 1.3;

interface Placed {
  thing: Thing;
  pose: Pose;
  size: V3;
  color: string;
  look: Look;
  /** 0-1: how far it has risen into place (1 when no cue names it). */
  pop: number;
  /** Its frame in the world: base at the origin, turned about its pivot, scaled (by its scale and pop). */
  matrix: THREE.Matrix4;
}

const NO_LOOK: Look = { appear: 0, instant: true, glow: 0, dim: 0, spent: 0, bump: 0, fade: 1, from: null, glide: 1 };

/**
 * Every object on frame `f`, parents before their parts, each with its frame in the world. `popOf` says how far each
 * has risen into place (framing uses 1: things are framed at full size).
 */
function placeAll(s: Scene3D, f: number, fps: number, frameOf: FrameOf, popOf: (o: Thing) => number, lookOf: (o: Thing) => Look, theme: Theme): Placed[] {
  const byId = new Map(s.objects.map(o => [o.id, o]));
  const placed = new Map<string, Placed>();
  const walks = new Map<string, ReturnType<typeof walked>>();
  const place = (o: Thing, path: string[]): Placed => {
    const done = placed.get(o.id);
    if (done) return done;
    if (path.includes(o.id)) throw new Error(`3d objects can't be parts of each other: ${[...path, o.id].join(' > ')}`);
    const parent = o.parent ? byId.get(o.parent) : undefined;
    if (o.parent && !parent) throw new Error(`3d object "${o.id}" has parent "${o.parent}", which isn't in the scene`);
    const base = parent ? place(parent, [...path, o.id]).matrix : new THREE.Matrix4();
    const pose = poseAt(o, f, fps, frameOf);
    if (o.stride && parent) {
      // Legs and arms swing with the parent's steps, and come to rest when it stops.
      if (!walks.has(parent.id)) walks.set(parent.id, walked(parent, f, fps, frameOf));
      const { distance, speed } = walks.get(parent.id)!;
      pose.turn = [pose.turn[0] + o.stride * Math.sin((2 * Math.PI * distance) / STRIDE_M) * clamp01(speed / 0.35), pose.turn[1], pose.turn[2]];
    }
    const size = sizeOf(o), pop = popOf(o), k = pose.scale * pop;
    const pivot = (o.pivot === 'top' ? size[1] : o.pivot === 'base' ? 0 : size[1] / 2) * k;
    const matrix = base.clone()
      .multiply(new THREE.Matrix4().makeTranslation(pose.at[0], pose.at[1] + pivot, pose.at[2]))
      .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rad(pose.turn[0]), rad(pose.turn[1]), rad(pose.turn[2]))))
      .multiply(new THREE.Matrix4().makeTranslation(0, -pivot, 0))
      .multiply(new THREE.Matrix4().makeScale(k, k, k));
    const index = s.objects.indexOf(o);
    const p: Placed = { thing: o, pose, size, color: o.color ?? toneColor(theme, o.tone, STEP_COLORS[index % STEP_COLORS.length]), look: lookOf(o), pop, matrix };
    placed.set(o.id, p);
    return p;
  };
  return s.objects.map(o => place(o, []));
}

/** A point in an object's own frame (unscaled metres from its base), in the world. */
const toWorld = (p: Placed, local: V3): V3 => {
  const v = new THREE.Vector3(...local).applyMatrix4(p.matrix);
  return [v.x, v.y, v.z];
};

/** The corners of the box an object fills, in the world. */
function cornersOf(p: Placed): V3[] {
  const [w, h, d] = p.size, corners: V3[] = [];
  for (const x of [-w / 2, w / 2]) for (const y of [0, h]) for (const z of [-d / 2, d / 2]) corners.push(toWorld(p, [x, y, z]));
  return corners;
}

const middleOf = (p: Placed): V3 => toWorld(p, [0, p.size[1] / 2, 0]);

/** The frame and where the subject goes in it: the stage's content, under the heading. */
interface View { w: number; h: number; area: Box }
interface Cam { position: V3; target: V3; fov: number }

/** Directions from what's framed to the camera (before scaling to the distance). */
const ANGLES: Record<NonNullable<Shot['angle']>, V3> = {
  'three-quarter': [0.62, 0.36, 1], front: [0, 0.16, 1], side: [1, 0.16, 0], back: [0, 0.2, -1], top: [0, 1, 0.12], high: [0.45, 1.05, 1], low: [0.4, -0.06, 1],
};
/** How much of the free area the framed objects fill: close fills it, wide leaves room round them. */
const FILL = { close: 0.92, medium: 0.72, wide: 0.45 };

const focal = (cam: Cam, view: View) => view.h / 2 / Math.tan(rad(cam.fov) / 2);

/** A shot's camera, framing its objects where they are on frame `f`. */
function shotCamera(shot: Shot, s: Scene3D, f: number, fps: number, frameOf: FrameOf, view: View, theme: Theme): Cam {
  const fov = shot.fov ?? 35;
  if (shot.position && shot.target) return { position: shot.position, target: shot.target, fov };
  const ids = shot.frame ? [shot.frame].flat() : s.objects.filter(o => !o.parent).map(o => o.id);
  for (const id of ids) if (!s.objects.some(o => o.id === id)) throw new Error(`a 3d shot frames "${id}", which isn't in the scene (${s.objects.map(o => o.id).join(', ')})`);
  const all = placeAll(s, f, fps, frameOf, () => 1, () => NO_LOOK, theme);
  const corners = all.filter(p => ids.includes(p.thing.id)).flatMap(cornersOf);
  if (!corners.length) corners.push([-0.5, 0, -0.5], [0.5, 1, 0.5]);
  const lo = [0, 1, 2].map(i => Math.min(...corners.map(c => c[i]))) as V3, hi = [0, 1, 2].map(i => Math.max(...corners.map(c => c[i]))) as V3;
  const target = shot.target ?? mul(add(lo, hi), 0.5);
  const dir = unit(ANGLES[shot.angle ?? 'three-quarter']), fill = FILL[shot.distance ?? 'medium'];
  const from = (d: number): V3 => { const p = add(target, mul(dir, d)); return [p[0], Math.max(0.15, p[1]), p[2]]; };
  // Back off (or come in) until the corners fill the free area as asked: sizes on screen go as 1 / distance, so a few
  // steps settle it.
  let distance = Math.max(1, 1.5 * len(sub(hi, lo)));
  if (!shot.position) {
    const cx = view.area.x + view.area.w / 2, cy = view.area.y + view.area.h / 2;
    for (let i = 0; i < 8; i++) {
      const cam = { position: from(distance), target, fov };
      let need = 0;
      for (const c of corners) {
        const p = project(cam, view, c);
        need = p.depth <= 0.05 ? 3 : Math.max(need, Math.abs(p.x - cx) / ((fill * view.area.w) / 2), Math.abs(p.y - cy) / ((fill * view.area.h) / 2));
        if (need === 3) break;
      }
      distance *= Math.min(3, Math.max(0.3, need));
    }
  }
  return { position: shot.position ?? from(distance), target, fov };
}

/** Camera to target as distance, bearing and elevation, so moves between shots swing round instead of cutting through. */
function polar(cam: Cam) {
  const v = sub(cam.position, cam.target), d = len(v) || 1;
  return { d, bearing: Math.atan2(v[0], v[2]), elevation: Math.asin(Math.max(-1, Math.min(1, v[1] / d))) };
}
function fromPolar(target: V3, d: number, bearing: number, elevation: number): V3 {
  return add(target, [d * Math.cos(elevation) * Math.sin(bearing), d * Math.sin(elevation), d * Math.cos(elevation) * Math.cos(bearing)]);
}

/** The camera on frame `f`: the opening shot, gliding to each shot from its `at`, and the orbit. */
function cameraAt(s: Scene3D, f: number, fps: number, frameOf: FrameOf, view: View, theme: Theme): Cam {
  const shots = [{ shot: s.camera ?? {}, start: 0 }, ...(s.shots ?? []).map(shot => ({ shot, start: startOf(shot, frameOf, fps) }))].sort((a, b) => a.start - b.start);
  let cam = shotCamera(shots[0].shot, s, 0, fps, frameOf, view, theme);
  for (const { shot, start } of shots.slice(1)) {
    if (f < start) break;
    const to = shotCamera(shot, s, start, fps, frameOf, view, theme);
    const p = ease(clamp01((f - start) / Math.max(1, (shot.seconds ?? 1.2) * fps)));
    const a = polar(cam), b = polar(to);
    let turn = b.bearing - a.bearing;
    turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI)); // the short way round
    const target = lerp3(cam.target, to.target, p);
    cam = { target, position: fromPolar(target, lerp(a.d, b.d, p), a.bearing + turn * p, lerp(a.elevation, b.elevation, p)), fov: lerp(cam.fov, to.fov, p) };
  }
  if (s.orbit) {
    const { d, bearing, elevation } = polar(cam);
    cam = { ...cam, position: fromPolar(cam.target, d, bearing + rad(s.orbit * (f / fps)), elevation) };
  }
  return cam;
}

/** The camera's axes: forward, right and up. */
function axes(cam: Cam): [V3, V3, V3] {
  const forward = unit(sub(cam.target, cam.position));
  let right = cross(forward, [0, 1, 0]);
  if (len(right) < 1e-4) right = [1, 0, 0]; // looking straight down
  right = unit(right);
  return [forward, right, cross(right, forward)];
}

/** Where a point lands on screen (the free area's middle is the picture's centre), and how far in front it is. */
function project(cam: Cam, view: View, p: V3): { x: number; y: number; depth: number } {
  const [forward, right, up] = axes(cam), v = sub(p, cam.position), depth = dot(v, forward), f = focal(cam, view);
  return { x: view.area.x + view.area.w / 2 + (dot(v, right) / depth) * f, y: view.area.y + view.area.h / 2 - (dot(v, up) / depth) * f, depth };
}

/** Where a set of points lands on screen: the box round them. */
function screenBox(cam: Cam, view: View, points: V3[]): Box {
  const pts = points.map(p => project(cam, view, p)).filter(p => p.depth > 0);
  if (!pts.length) return { x: -1, y: -1, w: 0, h: 0 };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function viewOf(s: Scene3D, stage: Stage): View {
  return { w: stage.w, h: stage.h, area: headed(s.heading, stage.content, stage.u, 30).area };
}

/** The spotlight on frame `f`: where it points (following its object), how wide, how dark the rest is. */
function spotAt(s: Scene3D, f: number, fps: number, frameOf: FrameOf, placed: Placed[]): { target: V3; angle: number; dim: number } | null {
  const spot = s.spotlight;
  if (!spot) return null;
  const on = (id: string): V3 => {
    const p = placed.find(x => x.thing.id === id);
    if (!p) throw new Error(`the spotlight is on "${id}", which isn't in the scene`);
    const c = middleOf(p);
    return [c[0], Math.min(c[1], 1.2), c[2]];
  };
  let state = { target: spot.on ? on(spot.on) : [0, 1, 0] as V3, angle: spot.angle ?? 16, dim: spot.dim ?? 0 };
  const changes = (spot.changes ?? []).map(c => ({ c, start: startOf(c, frameOf, fps) })).sort((a, b) => a.start - b.start);
  for (const { c, start } of changes) {
    if (f < start) break;
    const p = ease(clamp01((f - start) / Math.max(1, (c.seconds ?? 1) * fps)));
    state = { target: c.on ? lerp3(state.target, on(c.on), p) : state.target, angle: lerp(state.angle, c.angle ?? state.angle, p), dim: lerp(state.dim, c.dim ?? state.dim, p) };
  }
  return state;
}

// Raised text: Montserrat Black, read with opentype.js into the outlines three.js extrudes.

let font3d: Promise<Font> | null = null;
function loadFont3d(): Promise<Font> {
  font3d ??= fetch(fontUrl).then(r => r.arrayBuffer()).then(buffer => {
    const font: OpenTypeFont = parseFont(buffer);
    const glyphs: FontData['glyphs'] = {};
    const chars = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ...'ÀÁÂÄÇÈÉÊËÌÍÎÏÑÒÓÔÖÙÚÛÜßàáâäçèéêëìíîïñòóôöùúûü‘’“”–—…•€£'];
    for (const ch of chars) {
      const g = font.charToGlyph(ch);
      if (!g || (g.index === 0 && ch !== ' ')) continue;
      // three.js outlines: m/l/q/b (cubic) commands, the end point first.
      let o = '';
      for (const c of g.path.commands) {
        if (c.type === 'M' || c.type === 'L') o += `${c.type.toLowerCase()} ${c.x} ${c.y} `;
        else if (c.type === 'Q') o += `q ${c.x} ${c.y} ${c.x1} ${c.y1} `;
        else if (c.type === 'C') o += `b ${c.x} ${c.y} ${c.x1} ${c.y1} ${c.x2} ${c.y2} `;
      }
      glyphs[ch] = { ha: g.advanceWidth ?? 0, x_min: g.xMin ?? 0, x_max: g.xMax ?? 0, o };
    }
    const head = font.tables.head as unknown as { yMin: number; yMax: number }, post = font.tables.post as unknown as { underlineThickness: number };
    // Resolution = units per em: a geometry's size is then its em.
    return new Font({ glyphs, familyName: 'Montserrat', resolution: font.unitsPerEm, boundingBox: { yMin: head.yMin, yMax: head.yMax }, underlineThickness: post.underlineThickness } as FontData);
  });
  return font3d;
}

const TextShape: React.FC<{ text: string; size: number; height: number; children: React.ReactNode }> = ({ text, size, height, children }) => {
  const font = use(loadFont3d());
  const geometry = useMemo(() => {
    const g = new TextGeometry(text, { font, size, depth: 0.25 * size, curveSegments: 8, bevelEnabled: true, bevelThickness: 0.03 * size, bevelSize: 0.018 * size, bevelSegments: 3 });
    g.computeBoundingBox();
    const b = g.boundingBox!;
    // Centred across and in depth, the baseline at the bottom of the object's box (capitals fill it).
    g.translate(-(b.min.x + b.max.x) / 2, -height / 2, -(b.min.z + b.max.z) / 2);
    return g;
  }, [font, text, size, height]);
  return <mesh geometry={geometry} castShadow receiveShadow>{children}</mesh>;
};

// Models: a .glb/.gltf, copied per object (rigs too), scaled into its size and stood on its base.

/** An animation a model plays from `start` (seconds into the scene): for `length` seconds, looping, or once (null). */
interface Clip { name: string; start: number; length: number | null }
/** Seconds a model takes to blend from one animation into another. */
const BLEND_S = 0.25;

const ModelShape: React.FC<{ url: string; size: V3; fit: 'largest' | 'box'; base?: string; clips: Clip[]; time: number; glow: number; accent: string }> = ({ url, size, fit, base, clips, time, glow, accent }) => {
  const gltf = useGLTF(url, false);
  const names = [...new Set([base, ...clips.map(c => c.name)].filter((n): n is string => !!n))];
  const { object, mixer, actions } = useMemo(() => {
    const object = cloneRigged(gltf.scene);
    object.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone();
      }
    });
    // Rigged meshes are measured through their bones, so every node's place must be worked out first.
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object), dims = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const k = fit === 'box' ? Math.min(size[0] / (dims.x || 1), size[1] / (dims.y || 1), size[2] / (dims.z || 1)) : size[1] / (Math.max(dims.x, dims.y, dims.z) || 1);
    // Scaled, centred across, its lowest point on the bottom of the object's box.
    const holder = new THREE.Group();
    object.scale.setScalar(k);
    object.position.set(-mid.x * k, -box.min.y * k - size[1] / 2, -mid.z * k);
    holder.add(object);
    const all: THREE.AnimationClip[] = gltf.animations;
    const mixer = new THREE.AnimationMixer(object);
    const actions = new Map<string, { action: THREE.AnimationAction; clip: THREE.AnimationClip }>();
    for (const name of names) {
      const clip = name === '*' ? all[0] : all.find(a => a.name === name);
      if (!clip) throw new Error(`${url} has no animation "${name}" (${all.map(a => a.name).join(', ') || 'none'})`);
      const action = mixer.clipAction(clip);
      action.play();
      actions.set(name, { action, clip });
    }
    return { object: holder, mixer, actions };
  }, [gltf, size[0], size[1], size[2], fit, names.join('|')]);
  useLayoutEffect(() => {
    // The clip playing now over the model's own animation, blending in and out; times set directly, so any frame is
    // the same however it's reached.
    let playing: { clip: Clip; length: number } | null = null;
    for (const c of clips) {
      const length = c.length ?? actions.get(c.name)!.clip.duration;
      if (time >= c.start && time < c.start + length) playing = { clip: c, length };
    }
    for (const { action } of actions.values()) action.setEffectiveWeight(0);
    let weight = 0;
    if (playing) {
      const { action, clip } = actions.get(playing.clip.name)!, local = time - playing.clip.start;
      weight = clamp01(Math.min(local / BLEND_S, (playing.length - local) / BLEND_S));
      action.time = playing.clip.length === null ? Math.min(local, clip.duration - 1e-4) : local % clip.duration;
      action.setEffectiveWeight(weight);
    }
    if (base && base !== playing?.clip.name) {
      const { action, clip } = actions.get(base)!;
      action.time = time % clip.duration;
      action.setEffectiveWeight(1 - weight);
    }
    mixer.update(0);
    object.traverse(child => {
      const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && 'emissive' in m) { m.emissive.set(accent); m.emissiveIntensity = 0.25 * glow; }
    });
  });
  return <primitive object={object} />;
};

// Screens: slides drawn on a canvas, shown as the screen's picture.

/** Frames a slide takes to fade in over the one before. */
const SLIDE_FADE = 10;

interface ScreenState { cur: number; prev: number; fade: number; age: number }

/** Which slide is up on frame `f`, the one it's fading in over, and how long it has been up (frames). */
function screenAt(o: Thing, f: number, fps: number, frameOf: FrameOf): ScreenState {
  const starts = (o.slides ?? []).map((slide, i) => ({ i, start: startOf(slide, frameOf, fps) })).sort((a, b) => a.start - b.start);
  let cur = -1, prev = -1, start = 0;
  for (const s of starts) if (s.start <= f) { prev = cur; cur = s.i; start = s.start; }
  return { cur, prev, fade: clamp01((f - start) / SLIDE_FADE), age: f - start };
}

/** Text split into words, *starred* ones marked for the accent colour. */
function richWords(text: string): Array<{ word: string; accent: boolean }> {
  const out: Array<{ word: string; accent: boolean }> = [];
  text.split(/(\*[^*]+\*)/).forEach(part => {
    const accent = /^\*.*\*$/.test(part);
    for (const word of (accent ? part.slice(1, -1) : part).split(/\s+/).filter(Boolean)) out.push({ word, accent });
  });
  return out;
}

/** Words wrapped into lines no wider than `width` at the context's font. */
function wrap(ctx: CanvasRenderingContext2D, words: Array<{ word: string; accent: boolean }>, width: number) {
  const lines: Array<typeof words> = [[]];
  const widthOf = (line: typeof words) => ctx.measureText(line.map(w => w.word).join(' ')).width;
  for (const w of words) {
    const line = lines.at(-1)!;
    if (line.length && widthOf([...line, w]) > width) lines.push([w]); else line.push(w);
  }
  return lines;
}

/** Draws wrapped rich lines centred (or from the left) round `y`, in the largest size up to `max` that fits. */
function richBlock(ctx: CanvasRenderingContext2D, text: string, opts: { x: number; y: number; width: number; height: number; max: number; weight: number; color: string; accent: string; align: 'center' | 'left'; family?: string }) {
  const words = richWords(text);
  let size = opts.max, lines = [] as ReturnType<typeof wrap>;
  for (; size > 20; size -= 4) {
    ctx.font = `${opts.weight} ${size}px ${opts.family ?? fontFamily}`;
    lines = wrap(ctx, words, opts.width);
    if (lines.length * size * 1.18 <= opts.height && lines.every(l => ctx.measureText(l.map(w => w.word).join(' ')).width <= opts.width)) break;
  }
  const lineH = size * 1.18, top = opts.y - (lines.length * lineH) / 2 + lineH / 2;
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    const full = ctx.measureText(line.map(w => w.word).join(' ')).width;
    let x = opts.align === 'center' ? opts.x - full / 2 : opts.x;
    line.forEach((w, j) => {
      const piece = (j ? ' ' : '') + w.word;
      ctx.fillStyle = w.accent ? opts.accent : opts.color;
      ctx.fillText(piece, x, top + i * lineH);
      x += ctx.measureText(piece).width;
    });
  });
  return { size, bottom: top + (lines.length - 0.5) * lineH };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A slide, drawn into a W x H canvas; `age`: frames since it appeared (stamps and strike-throughs animate). */
function drawSlide(ctx: CanvasRenderingContext2D, W: number, H: number, slide: Slide, age: number, theme: Theme) {
  const accent = theme.accent, layout = slide.layout ?? 'plain', u = W / 1920;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, slide.color && (layout === 'plain' || layout === 'quote') ? slide.color : '#161a2b');
  g.addColorStop(1, '#0b0d16');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (layout === 'plain') {
    const t = slide.title ? richBlock(ctx, slide.title, { x: W / 2, y: slide.text ? H * 0.42 : H / 2, width: W * 0.84, height: H * 0.55, max: 150 * u, weight: 900, color: '#ffffff', accent, align: 'center' }) : null;
    if (slide.text) richBlock(ctx, slide.text, { x: W / 2, y: t ? t.bottom + 110 * u : H / 2, width: W * 0.8, height: H * 0.25, max: 64 * u, weight: 700, color: '#aab2cc', accent, align: 'center' });
  } else if (layout === 'quote') {
    ctx.fillStyle = accent;
    ctx.font = `900 ${380 * u}px ${fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('“', 120 * u, 420 * u);
    const t = richBlock(ctx, slide.title ?? '', { x: 210 * u, y: H * 0.47, width: W * 0.74, height: H * 0.5, max: 130 * u, weight: 900, color: '#ffffff', accent, align: 'left' });
    if (slide.text) richBlock(ctx, slide.text, { x: 214 * u, y: t.bottom + 100 * u, width: W * 0.7, height: 120 * u, max: 60 * u, weight: 700, color: accent, accent, align: 'left' });
  } else {
    // A window: a terminal (code, band) or a chat.
    const x = 110 * u, y = 90 * u, w = W - 220 * u, h = H - 180 * u;
    roundRect(ctx, x, y, w, h, 28 * u);
    ctx.fillStyle = layout === 'chat' ? '#1c1f2b' : '#0d1017';
    ctx.fill();
    ctx.strokeStyle = '#2c3245';
    ctx.lineWidth = 4 * u;
    ctx.stroke();
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(x + (50 + i * 44) * u, y + 46 * u, 13 * u, 0, 2 * Math.PI);
      ctx.fillStyle = c;
      ctx.fill();
    });
    let top = y + 110 * u;
    const lines = (slide.text ?? '').split('\n');
    if (layout === 'band') {
      // The status band across the top of the terminal, then the prompt lines with a blinking cursor.
      ctx.fillStyle = slide.color ?? accent;
      ctx.fillRect(x, top, w, 150 * u);
      ctx.fillStyle = '#10121a';
      ctx.font = `700 ${62 * u}px ${monoFamily}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(slide.title ?? '', x + 60 * u, top + 75 * u);
      top += 240 * u;
    } else if (layout === 'chat' && slide.title) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 ${60 * u}px ${fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(slide.title, x + 60 * u, top);
      top += 120 * u;
    }
    const mono = layout !== 'chat', size = (mono ? 62 : 66) * u, lineH = mono ? size * 1.5 : size * 2.3;
    lines.forEach((raw, i) => {
      const struck = raw.startsWith('~'), line = struck ? raw.slice(1) : raw, ly = top + i * lineH;
      ctx.textBaseline = 'middle';
      if (layout === 'chat') {
        // A message: an avatar and the words; a struck one is greyed and crossed out as it appears.
        ctx.beginPath();
        ctx.arc(x + 90 * u, ly, 36 * u, 0, 2 * Math.PI);
        ctx.fillStyle = struck ? '#3a3f52' : accent;
        ctx.fill();
        ctx.font = `700 ${size}px ${fontFamily}`;
        ctx.fillStyle = struck ? '#6b7086' : '#ffffff';
        ctx.fillText(line, x + 160 * u, ly);
        if (struck) {
          const width = ctx.measureText(line).width * Easing.out(Easing.cubic)(clamp01((age - 6) / 14));
          ctx.fillStyle = '#ff4d4d';
          ctx.fillRect(x + 150 * u, ly - 4 * u, width + 20 * u, 9 * u);
        }
        return;
      }
      ctx.font = `${line.startsWith('$ ') ? 700 : 400} ${size}px ${monoFamily}`;
      if (line.startsWith('$ ')) {
        ctx.fillStyle = '#7ce0c3';
        ctx.fillText('$', x + 60 * u, ly);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line.slice(2), x + 60 * u + ctx.measureText('$ ').width, ly);
      } else {
        ctx.fillStyle = '#c9cfe2';
        ctx.fillText(line, x + 60 * u, ly);
      }
      if (layout === 'band' && i === lines.length - 1 && Math.floor(age / 15) % 2 === 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x + 60 * u + ctx.measureText(line).width + 14 * u, ly - size * 0.5, size * 0.55, size);
      }
    });
  }
  if (slide.stamp && age >= 8) {
    // A rubber stamp slamming down: big and faint, then in place.
    const p = Easing.out(Easing.cubic)(clamp01((age - 8) / 7));
    ctx.save();
    ctx.translate(W / 2, H * 0.6);
    ctx.rotate(rad(-10));
    ctx.scale(1.8 - 0.8 * p, 1.8 - 0.8 * p);
    ctx.globalAlpha = p;
    ctx.font = `900 ${170 * u}px ${fontFamily}`;
    const tw = ctx.measureText(slide.stamp).width;
    roundRect(ctx, -tw / 2 - 50 * u, -125 * u, tw + 100 * u, 250 * u, 30 * u);
    ctx.strokeStyle = '#ff3b3b';
    ctx.lineWidth = 18 * u;
    ctx.stroke();
    ctx.fillStyle = '#ff3b3b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(slide.stamp, 0, 8 * u);
    ctx.restore();
  }
  ctx.textAlign = 'left';
}

/** What a screen shows on a frame, as a key: it's drawn again only when this changes. */
function screenKey(o: Thing, st: ScreenState) {
  const slide = o.slides?.[st.cur];
  const busy = slide && ((slide.stamp && st.age < 16) || (slide.layout === 'chat' && st.age < 22));
  const blink = slide?.layout === 'band' ? Math.floor(st.age / 15) % 2 : 0;
  return JSON.stringify([st.cur, st.prev, r4(st.fade), busy ? st.age : -1, blink]);
}

const ScreenShape: React.FC<{ thing: Thing; size: V3; state: ScreenState; theme: Theme }> = ({ thing, size, state, theme }) => {
  const [w, h, d] = size;
  const W = 2048, H = Math.round((W * h) / w);
  const { canvas, texture } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { canvas, texture };
  }, [W, H]);
  const key = screenKey(thing, state);
  useLayoutEffect(() => {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);
    const slides = thing.slides ?? [];
    if (state.prev >= 0 && state.fade < 1) drawSlide(ctx, W, H, slides[state.prev], 1000, theme);
    if (state.cur >= 0) {
      ctx.globalAlpha = state.fade;
      drawSlide(ctx, W, H, slides[state.cur], state.age, theme);
      ctx.globalAlpha = 1;
    }
    texture.needsUpdate = true;
  }, [key]);
  return (
    <group>
      <mesh castShadow receiveShadow><boxGeometry args={[w, h, d]} /><meshStandardMaterial color="#0b0c10" roughness={0.6} /></mesh>
      <mesh position={[0, 0, d / 2 + 0.002]}><planeGeometry args={[w * 0.965, h * 0.94]} /><meshBasicMaterial map={texture} toneMapped={false} /></mesh>
      {/* The picture's light on what's in front of it. */}
      <rectAreaLight args={['#b9c6ff', 2.2, w, h]} position={[0, 0, d / 2 + 0.05]} rotation={[0, Math.PI, 0]} />
    </group>
  );
};

/** The surface: plastic (a clear coat), matte, metal, glass, or glow; lit up while pointed at, darker while dimmed. */
const Surface: React.FC<{ kind: Thing['material']; color: string; glow: number; dim: number; accent: string }> = ({ kind = 'plastic', color, glow, dim, accent }) => {
  const base = new THREE.Color(color).multiplyScalar(1 - 0.55 * dim);
  if (kind === 'glow') return <meshStandardMaterial color={base} emissive={color} emissiveIntensity={1.6 + glow} toneMapped={false} />;
  const lit = { emissive: new THREE.Color(accent), emissiveIntensity: 0.25 * glow };
  if (kind === 'matte') return <meshStandardMaterial color={base} roughness={0.92} metalness={0} {...lit} />;
  if (kind === 'metal') return <meshStandardMaterial color={base} roughness={0.22} metalness={1} {...lit} />;
  if (kind === 'glass') return <meshPhysicalMaterial color={base} transmission={1} roughness={0.06} thickness={0.6} ior={1.45} {...lit} />;
  return <meshPhysicalMaterial color={base} roughness={0.32} clearcoat={0.6} clearcoatRoughness={0.25} {...lit} />;
};

/** One object on this frame: its shape in its frame, glowing, dimmed or spent. */
const ThingMesh: React.FC<{ p: Placed; project: string; time: number; clips: Clip[]; screen: ScreenState | null; theme: Theme }> = ({ p, project, time, clips, screen, theme }) => {
  const { thing, size: [w, h, d], color, look, pop } = p;
  if (thing.shape === 'group' || pop * p.pose.scale <= 0.001) return null;
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  p.matrix.decompose(position, quaternion, scale);
  const extra = (1 + 0.05 * look.glow + 0.08 * look.bump) * (1 - 0.2 * look.spent);
  const surface = <Surface kind={thing.material} color={color} glow={look.glow} dim={look.dim} accent={theme.accent} />;
  const shape = (() => {
    switch (thing.shape) {
      case 'box': return <RoundedBox args={[w, h, d]} radius={0.08 * Math.min(w, h, d)} smoothness={4} castShadow receiveShadow>{surface}</RoundedBox>;
      case 'sphere': return <mesh scale={[w, h, d]} castShadow receiveShadow><sphereGeometry args={[0.5, 64, 32]} />{surface}</mesh>;
      case 'cylinder': return <mesh scale={[w, h, d]} castShadow receiveShadow><cylinderGeometry args={[0.5, 0.5, 1, 64]} />{surface}</mesh>;
      case 'cone': return <mesh scale={[w, h, d]} castShadow receiveShadow><coneGeometry args={[0.5, 1, 64]} />{surface}</mesh>;
      // A unit capsule is 0.5 across and 1 tall; a unit ring 1 across, 0.24 thick, standing up facing the camera.
      case 'capsule': return <mesh scale={[w / 0.5, h, d / 0.5]} castShadow receiveShadow><capsuleGeometry args={[0.25, 0.5, 8, 32]} />{surface}</mesh>;
      case 'torus': return <mesh scale={[w, h, d / 0.24]} castShadow receiveShadow><torusGeometry args={[0.38, 0.12, 32, 96, rad(thing.arc ?? 360)]} />{surface}</mesh>;
      case 'text': return <TextShape text={thing.text ?? ''} size={typeof thing.size === 'number' ? thing.size : 0.5} height={h}>{surface}</TextShape>;
      case 'screen': return <ScreenShape thing={thing} size={[w, h, d]} state={screen!} theme={theme} />;
      case 'model': {
        if (!thing.src) throw new Error(`3d object "${thing.id}" is a model: give it a src (a .glb in the project folder)`);
        const url = /^https?:/.test(thing.src) ? thing.src : staticFile(`${project}/${thing.src}`);
        return <ModelShape url={url} size={[w, h, d]} fit={Array.isArray(thing.size) ? 'box' : 'largest'} base={thing.animation} clips={clips} time={time} glow={look.glow} accent={theme.accent} />;
      }
    }
  })();
  return (
    <group position={position} quaternion={quaternion} scale={scale}>
      <group position={[0, h / 2, 0]} rotation={[0, 0, rad(90 * look.spent)]} scale={extra}>
        {shape}
        {thing.material === 'glow' && <pointLight color={color} intensity={3 * pop} distance={4 * Math.max(w, h, d)} />}
      </group>
    </group>
  );
};

/** Puts three.js's camera where ours is, with the picture's centre moved to the free area's middle. */
const CameraRig: React.FC<{ cam: Cam; view: View; far: number }> = ({ cam, view, far }) => {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  useLayoutEffect(() => {
    camera.fov = cam.fov;
    camera.near = 0.05;
    camera.far = far;
    camera.aspect = view.w / view.h;
    camera.position.set(...cam.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(...cam.target);
    camera.setViewOffset(view.w, view.h, -(view.area.x + view.area.w / 2 - view.w / 2), -(view.area.y + view.area.h / 2 - view.h / 2), view.w, view.h);
    camera.updateProjectionMatrix();
  });
  return null;
};

/** Stars for the night: the same few hundred points every time. */
const Stars: React.FC = () => {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i < 600; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5453, b = Math.sin(i * 78.233) * 12543.1234;
      const u = a - Math.floor(a), v = b - Math.floor(b);
      const bearing = 2 * Math.PI * u, elevation = Math.asin(0.08 + 0.92 * v);
      pts.push(...fromPolar([0, 0, 0], 900, bearing, elevation));
    }
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }, []);
  return <points geometry={geometry}><pointsMaterial color="#dfe6ff" size={2} sizeAttenuation={false} fog={false} /></points>;
};

/** A sky dome from the horizon's colour (the fog fades the floor into it, so there's no seam) to the zenith, with a glow round the sun. */
const SkyDome: React.FC<{ zenith: string; horizon: string; glow: string; sun: V3 }> = ({ zenith, horizon, glow, sun }) => {
  const material = useMemo(() => new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { zenith: { value: new THREE.Color(zenith) }, horizon: { value: new THREE.Color(horizon) }, glow: { value: new THREE.Color(glow) }, sun: { value: new THREE.Vector3(...unit(sun)) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 zenith; uniform vec3 horizon; uniform vec3 glow; uniform vec3 sun; varying vec3 vDir;',
      'void main() {',
      '  vec3 d = normalize(vDir);',
      '  vec3 c = mix(horizon, zenith, pow(clamp(d.y, 0.0, 1.0), 0.55));',
      '  float s = max(dot(d, sun), 0.0);',
      '  c += glow * (2.5 * pow(s, 900.0) + 0.35 * pow(s, 14.0));',
      '  gl_FragColor = vec4(c, 1.0);',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  }), [zenith, horizon, glow, sun[0], sun[1], sun[2]]);
  return <mesh material={material} scale={3000} renderOrder={-1}><sphereGeometry args={[1, 48, 24]} /></mesh>;
};

/** The light presets: a sky (or the background), the floor, the sun or house light, fill light, and how bright the reflections are. */
const LIGHTS: Record<NonNullable<Scene3D['light']>, {
  sky: { zenith: string; horizon: string; glow: string } | null; background?: string; floor: string | null; sun: V3; sunColor: string; sunPower: number;
  ambient: number; hemisphere: [string, string, number] | null; reflected: string; formers: number;
}> = {
  studio: { sky: null, floor: null, sun: [0.5, 1.4, 0.8], sunColor: '#ffffff', sunPower: 2.2, ambient: 0.35, hemisphere: null, reflected: '#4a4e5a', formers: 1 },
  day: {
    sky: { zenith: '#2f7fe0', horizon: '#cfe2f2', glow: '#fff3d6' }, floor: '#9c978a', sun: [0.6, 0.9, 0.45], sunColor: '#fff4e0', sunPower: 2.2,
    ambient: 0.15, hemisphere: ['#cfe6ff', '#6b6152', 0.5], reflected: '#9db8d0', formers: 1,
  },
  sunset: {
    sky: { zenith: '#2c2f66', horizon: '#ffae78', glow: '#ffd2a0' }, floor: '#6e5a4e', sun: [0.8, 0.16, -0.55], sunColor: '#ffad6b', sunPower: 2.6,
    ambient: 0.12, hemisphere: ['#ffcf9e', '#3a2c40', 0.45], reflected: '#6a4a52', formers: 0.8,
  },
  night: {
    sky: { zenith: '#01030a', horizon: '#0c1530', glow: '#9db4ff' }, floor: '#0e1424', sun: [-0.4, 0.8, 0.5], sunColor: '#9db4ff', sunPower: 0.7,
    ambient: 0.08, hemisphere: null, reflected: '#0b1020', formers: 0.15,
  },
  // A hall with the house lights low: the spotlight does the work.
  stage: {
    sky: null, background: '#040409', floor: '#17131c', sun: [0.15, 1.2, 1], sunColor: '#c9d2ff', sunPower: 0.95, ambient: 0.16,
    hemisphere: ['#3a4060', '#0a0a10', 0.55], reflected: '#1c1f2a', formers: 0.45,
  },
};

/**
 * How far from the middle the scene reaches on the floor, wherever its objects go: what the shadows cover. Fixed for the
 * scene (from its data, not the frame), since three.js keeps a shadow's projection from whenever it was last worked out.
 */
function sceneExtent(s: Scene3D): number {
  return Math.max(2, ...s.objects.filter(o => !o.parent).flatMap(o => {
    const [w, , d] = sizeOf(o), scale = Math.max(o.scale ?? 1, ...(o.moves ?? []).map(m => m.scale ?? 1));
    return [o.at ?? [0, 0, 0], ...(o.moves ?? []).flatMap(m => (m.to ? [m.to] : []))].map(p => Math.hypot(p[0], p[2]) + 0.5 * Math.hypot(w, d) * scale);
  }));
}

/** Puts a directional light's shadow camera to work with its current bounds (r3f sets them, three.js doesn't apply them). */
const ShadowSun: React.FC<React.ComponentProps<'directionalLight'>> = props => {
  const ref = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => { ref.current?.shadow.camera.updateProjectionMatrix(); });
  return <directionalLight ref={ref} {...props} />;
};

/** The beam a spotlight makes in the air: a soft cone, brightest near the lamp. */
const beamMaterial = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { color: { value: new THREE.Color('#ffe9c9') }, strength: { value: 0.3 } },
  vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vView; void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform vec3 color; uniform float strength; varying vec2 vUv; varying vec3 vN; varying vec3 vView; void main() { float edge = abs(dot(normalize(vN), normalize(vView))); float a = strength * pow(edge, 2.0) * mix(0.15, 1.0, vUv.y); gl_FragColor = vec4(color * a, 1.0); }',
});

/** The spotlight: from above and in front of what it's on, with its beam. */
const Spotlight: React.FC<{ state: { target: V3; angle: number } }> = ({ state }) => {
  const light = useRef<THREE.SpotLight>(null);
  const material = useMemo(beamMaterial, []);
  const lamp = add(state.target, [1.2, 7.5, 5.5]);
  const dir = unit(sub(state.target, lamp));
  const floor = add(lamp, mul(dir, lamp[1] / -dir[1]));
  const length = len(sub(floor, lamp)), radius = Math.tan(rad(state.angle)) * length;
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...unit(sub(lamp, floor))));
  useLayoutEffect(() => {
    const l = light.current!;
    l.target.position.set(...state.target);
    l.target.updateMatrixWorld();
  });
  return (
    <>
      <spotLight
        ref={light} position={lamp} angle={rad(state.angle)} penumbra={0.45} intensity={320} decay={2} color="#fff1dc" castShadow
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0002} shadow-normalBias={0.02}
      />
      <mesh position={mul(add(lamp, floor), 0.5)} quaternion={quaternion} renderOrder={2} material={material}>
        <coneGeometry args={[radius, length, 48, 1, true]} />
      </mesh>
    </>
  );
};

/** Sets how strongly the reflections light the scene (the house lights dimming). */
const Reflections: React.FC<{ intensity: number }> = ({ intensity }) => {
  const scene = useThree(s => s.scene);
  useLayoutEffect(() => { scene.environmentIntensity = intensity; });
  return null;
};

/** Lights, sky or background, floor and fog for a preset, sized to the scene (`extent`: its radius) and the camera's distance. */
const Setting: React.FC<{ s: Scene3D; theme: Theme; extent: number; distance: number; dim: number }> = ({ s, theme, extent, distance, dim }) => {
  const light = s.light ?? 'studio', preset = LIGHTS[light], sky = preset.sky;
  const background = sky?.horizon ?? s.background ?? preset.background ?? theme.bg;
  // A studio floor is the background's colour, a touch lighter, fading into it with distance (an endless backdrop).
  const floor = s.floor === false ? null : s.floor ?? preset.floor ?? new THREE.Color(background).lerp(new THREE.Color('#ffffff'), 0.03).getStyle();
  const sun = mul(unit(preset.sun), extent * 4);
  const shadow = extent * 1.6;
  const house = 1 - dim;
  // Under a sky the floor runs on to the horizon; in the studio it fades out close behind the objects.
  const fog: [number, number] = sky ? [distance * 1.5, distance * 6 + extent * 3] : [distance * 1.1, distance * 3 + extent * 2];
  return (
    <>
      <color attach="background" args={[background]} />
      {sky && <SkyDome {...sky} sun={preset.sun} />}
      {light === 'night' && <Stars />}
      <fog attach="fog" args={[background, ...fog]} />
      <ambientLight intensity={preset.ambient * house} />
      {preset.hemisphere && <hemisphereLight args={[preset.hemisphere[0], preset.hemisphere[1], preset.hemisphere[2] * house]} />}
      <ShadowSun
        position={sun} color={preset.sunColor} intensity={preset.sunPower * house} castShadow
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.02} shadow-radius={5}
        shadow-camera-left={-shadow} shadow-camera-right={shadow} shadow-camera-top={shadow} shadow-camera-bottom={-shadow}
        shadow-camera-near={0.1} shadow-camera-far={extent * 10}
      />
      <Reflections intensity={0.15 + 0.85 * house} />
      {/* Reflections: soft boxes all round, dimmer at night and on a stage. */}
      <Environment resolution={256} frames={1}>
        {/* What metal and glass reflect between the lights. */}
        <color attach="background" args={[preset.reflected]} />
        <Lightformer form="rect" intensity={2.5 * preset.formers} position={[0, 6, 2]} scale={[10, 4, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.2 * preset.formers} position={[-6, 2, 1]} scale={[6, 2, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={preset.formers} color={preset.sunColor} position={[6, 1.5, -2]} scale={[6, 2, 1]} target={[0, 0, 0]} />
        <Lightformer form="ring" intensity={0.6 * preset.formers} position={[0, 2, -8]} scale={4} target={[0, 0, 0]} />
      </Environment>
      {floor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[Math.max(300, distance * 40), 96]} />
          <meshStandardMaterial color={floor} roughness={light === 'stage' ? 0.55 : 0.95} metalness={0} />
        </mesh>
      )}
    </>
  );
};

/** A model's animations on a scene: its moves that switch animation, as clips from their start. */
function clipsOf(o: Thing, frameOf: FrameOf, fps: number): Clip[] {
  return (o.moves ?? []).filter(m => m.animation).map(m => ({ name: m.animation!, start: startOf(m, frameOf, fps) / fps, length: m.seconds ?? null }));
}

export const scene3d: SceneDef<Scene3D> = {
  layout: (s, beat, stage) => {
    if (!s.objects.length) throw new Error(`[${beat.id}] a 3d scene needs objects`);
    const { anchors, fonts } = headed(s.heading, stage.content, stage.u, 30);
    const view = viewOf(s, stage);
    // The opening shot, before anything moves: what the narrator and notes go by.
    const opening = (at?: string) => (at ? Infinity : 0);
    const cam = cameraAt(s, 0, 30, opening, view, LAYOUT_THEME);
    for (const p of placeAll(s, 0, 30, opening, () => 1, () => NO_LOOK, LAYOUT_THEME)) anchors[p.thing.id] = screenBox(cam, view, cornersOf(p));
    return { anchors, fonts };
  },
  Component: props => {
    const { scene: s, stage, theme, look, cued, at, fade, project } = props;
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const view = viewOf(s, stage);
    const frameOf = (phrase?: string) => (phrase ? at(phrase, 0) : 0);
    const cam = cameraAt(s, frame, fps, frameOf, view, theme);
    // Objects no cue names are simply there (a stage carried on from the beat before stays put); cued ones rise in.
    const popOf = (o: Thing) => {
      if (!cued(o.id)) return 1;
      const l = look(o.id);
      return frame < l.appear ? 0 : l.instant ? 1 : spring({ frame: frame - l.appear, fps, config: { damping: 13, stiffness: 140, mass: 0.8 } });
    };
    const placed = placeAll(s, frame, fps, frameOf, popOf, o => look(o.id), theme);
    const extent = useMemo(() => sceneExtent(s), [s]);
    const distance = len(sub(cam.position, cam.target));
    const spot = spotAt(s, frame, fps, frameOf, placed);
    const screens = new Map(placed.filter(p => p.thing.shape === 'screen').map(p => [p.thing.id, screenAt(p.thing, frame, fps, frameOf)]));
    const time = frame / fps;
    // Everything that decides the picture, for the engine to tell frames apart.
    const fingerprint = JSON.stringify({
      v: 2, w: stage.w, h: stage.h, area: view.area, theme, light: s.light, background: s.background, floor: s.floor,
      cam: [...cam.position, ...cam.target, cam.fov].map(r4), spot: spot && [...spot.target, spot.angle, spot.dim].map(r4),
      things: placed.map(p => [p.thing.shape, p.thing.text, p.thing.src && staticFile(`${project}/${p.thing.src}`), p.thing.size, p.thing.material, p.thing.arc,
        p.thing.animation, clipsOf(p.thing, frameOf, fps), p.color, p.thing.slides && screenKey(p.thing, screens.get(p.thing.id)!),
        ...p.matrix.elements, p.pop, p.look.glow, p.look.dim, p.look.spent, p.look.bump].map(x => (typeof x === 'number' ? r4(x) : x))),
      time: placed.some(p => p.thing.shape === 'model' && (p.thing.animation || p.thing.moves?.some(m => m.animation))) ? r4(time) : 0,
    });
    return (
      <>
        <ThreeView width={stage.w} height={stage.h} fingerprint={fingerprint} setup={{ shadows: 'percentage' }} style={{ position: 'absolute', left: 0, top: 0, opacity: fade }}>
          <CameraRig cam={cam} view={view} far={Math.max(5000, distance * 20)} />
          <Setting s={s} theme={theme} extent={extent} distance={distance} dim={spot?.dim ?? 0} />
          {spot && <Spotlight state={spot} />}
          {placed.map(p => <ThingMesh key={p.thing.id} p={p} project={project} time={time} clips={clipsOf(p.thing, frameOf, fps)} screen={screens.get(p.thing.id) ?? null} theme={theme} />)}
        </ThreeView>
        {LIGHTS[s.light ?? 'studio'].sky && s.light !== 'night' && s.heading ? (
          // Over a bright sky the heading sits on a plate.
          <El box={props.layout.anchors.heading} look={look('heading')} rise>
            {() => (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ padding: `${10 * stage.u}px ${28 * stage.u}px`, borderRadius: 18 * stage.u, background: withAlpha(theme.bg, 0.62) }}>
                  <Text size={props.layout.fonts.heading} color={theme.text} weight={900}>{s.heading}</Text>
                </div>
              </div>
            )}
          </El>
        ) : <Heading text={s.heading} props={props} />}
        <Labels placed={placed} cam={cam} view={view} stage={stage} theme={theme} fade={fade} />
      </>
    );
  },
};

/** Colours for laying out (only sizes and places matter there). */
const LAYOUT_THEME: Theme = { bg: '#000000', panel: '#000000', line: '#000000', text: '#ffffff', muted: '#888888', accent: '#ffffff', yes: '#ffffff', no: '#ffffff' };

/**
 * Name tags over the objects that have a label, in HTML, placed with the same camera. They fade in without CSS
 * transforms: Chromium may scale an earlier raster of a transformed element instead of drawing it again, which makes a
 * frame's pixels depend on what the page drew before it.
 */
const Labels: React.FC<{ placed: Placed[]; cam: Cam; view: View; stage: Stage; theme: Theme; fade: number }> = ({ placed, cam, view, stage, theme, fade }) => {
  const { u } = stage, size = 34 * u, room = 1200 * u;
  return (
    <>
      {placed.filter(p => p.thing.label && p.pop > 0.01).map(p => {
        const pt = project(cam, view, toWorld(p, [0, p.size[1] + 0.08 / Math.max(0.05, p.pose.scale * p.pop), 0]));
        if (pt.depth <= 0) return null;
        // A wide box centred on the point, the tag at its bottom middle.
        return (
          <div key={p.thing.id} style={{ position: 'absolute', left: pt.x - room / 2, width: room, top: pt.y - 0.9 * size - 3 * size + 0.3 * size * (1 - clamp01(p.pop)), height: 3 * size, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            <div
              style={{
                padding: `${0.18 * size}px ${0.55 * size}px`, borderRadius: 999, background: withAlpha(theme.bg, 0.82), border: `${2 * u}px solid ${withAlpha(p.color, 0.8)}`,
                fontFamily, fontWeight: 800, fontSize: size, lineHeight: 1.2, color: theme.text, whiteSpace: 'nowrap', opacity: clamp01(p.pop) * fade * (1 - 0.6 * p.look.dim),
              }}
            >
              {p.thing.label}
            </div>
          </div>
        );
      })}
    </>
  );
};
