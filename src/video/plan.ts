// Video timing: beats and cues resolved to frames, the stage each frame shape gives the scenes, and the narrator's path:
// where it stands for each thing it points at, when it hops there (it leaves early so it lands as the word is spoken),
// and its pose on any frame.
import { Easing } from '../engine/math.ts';
import type { Beat, Box, Cue, Scene, Script, Timeline } from '../types.ts';
import { captionBox } from './Captions.tsx';
import { sceneOf, type Layout, type Look, type Point, type Stage } from './scenes.tsx';
import { findPhrase } from './timeline.ts';

/** Narrator radius, usual stick length, longest reach (centre to stick tip) and the frame margin it keeps, for the frame's shorter side. */
export const narratorSize = (side: number) => {
  const R = 0.065 * side;
  return { R, stick: 2.1 * R, reach: 5 * R, margin: 0.03 * side };
};

/**
 * The stage for a frame shape: content inside the margins, above the captions' band (when on) and the narrator's strip
 * along the bottom (when on), where it rests.
 */
export function stageFor(w: number, h: number, opts: { narrator: boolean; captions: boolean; images: Stage['images'] }): Stage {
  const side = Math.min(w, h), { R } = narratorSize(side);
  const marginX = 0.05 * w, top = 0.07 * h;
  const bottom = opts.captions ? captionBox(w, h).top - 0.015 * h : h - 0.05 * h;
  const strip = opts.narrator ? 3.2 * R : 0;
  return {
    w, h, u: side / 1080, wide: w >= 1.2 * h,
    content: { x: marginX, y: top, w: w - 2 * marginX, h: bottom - strip - top },
    home: { x: w / 2, y: bottom - 1.6 * R },
    images: opts.images,
  };
}

/** Every element id a scene has (its fixed ones and those the script names), checked for duplicates. */
function elementIds(beat: Beat): string[] {
  const s: Scene = beat.scene;
  const heading = 'heading' in s && s.heading ? ['heading'] : [];
  const ids = s.type === 'title' ? ['title', ...(s.subtitle ? ['subtitle'] : [])]
    : s.type === 'text' ? ['text']
    : s.type === 'points' ? [...heading, ...s.items.map(i => i.id)]
    : s.type === 'compare' ? ['left', 'right', ...s.left.items.map(i => i.id), ...s.right.items.map(i => i.id)]
    : s.type === 'flow' ? [...heading, 'slots', ...s.steps.map(st => st.id)]
    : s.type === 'cycle' ? [...heading, ...s.nodes.map(n => n.id)]
    : s.type === 'timeline' ? [...heading, ...s.steps.map(st => st.id)]
    : s.type === 'typing' ? ['window']
    : s.type === 'figures' ? [...heading, ...s.items.map(it => it.id)]
    : s.type === 'road' ? [...heading, 'rider', ...(s.readouts ?? []).map(r => r.id)]
    : s.type === '3d' ? [...heading, ...s.objects.map(o => o.id)]
    : ['image', ...(s.caption ? ['caption'] : []), ...Object.keys(s.regions ?? {})];
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length) throw new Error(`[${beat.id}] element ids must be unique in a scene: ${[...new Set(twice)].join(', ')}`);
  return ids;
}

/** What an element shows, to tell whether the next scene has the same one (then it's carried over, not faded). */
function elementKey(beat: Beat, id: string): string | null {
  const s = beat.scene;
  const item = (items: Array<{ id: string; text: string; tone?: string; strike?: boolean }>) => {
    const it = items.find(i => i.id === id);
    return it ? JSON.stringify([it.text, it.tone, it.strike]) : null;
  };
  const text = s.type === 'title' ? (id === 'title' ? s.title : id === 'subtitle' ? s.subtitle : null)
    : s.type === 'text' ? s.text ?? beat.text
    : id === 'heading' && 'heading' in s ? s.heading
    : s.type === 'points' ? item(s.items)
    : s.type === 'compare' ? (id === 'left' || id === 'right' ? s[id].title : item([...s.left.items, ...s.right.items]))
    : s.type === 'flow' ? JSON.stringify(s.steps.find(st => st.id === id) ?? null)
    : s.type === 'cycle' ? JSON.stringify(s.nodes.find(n => n.id === id) ?? null)
    : s.type === 'timeline' ? JSON.stringify(s.steps.find(st => st.id === id)?.label ?? null)
    : s.type === 'typing' ? JSON.stringify([s.style, s.who, s.title, s.text])
    : s.type === 'figures' ? JSON.stringify(s.items.find(it => it.id === id) ?? null)
    : s.type === 'road' ? JSON.stringify(id === 'rider' ? s.label ?? '' : s.readouts?.find(r => r.id === id) ?? null)
    : s.type === '3d' ? null
    : id === 'image' ? s.src : id === 'caption' ? s.caption : null;
  return text && text !== 'null' ? `${s.type}|${text}` : null;
}

/** Phrases the scene's own data times things by (arrows, timeline steps, underlines). */
function scenePhrases(s: Scene): string[] {
  const all = s.type === 'cycle' ? s.arrows.map(a => a.at)
    : s.type === 'timeline' ? s.steps.flatMap(st => [st.at, st.light, st.land])
    : s.type === 'image' ? (s.marks ?? []).map(m => m.at)
    : s.type === 'typing' ? [s.from, s.until]
    : s.type === 'road' ? (s.moves ?? []).map(m => m.at)
    : s.type === '3d' ? [
      ...(s.shots ?? []).map(sh => sh.at), ...(s.spotlight?.changes ?? []).map(c => c.at),
      ...s.objects.flatMap(o => [...(o.moves ?? []).map(m => m.at), ...(o.slides ?? []).map(sl => sl.at)]),
    ] : [];
  return all.filter((p): p is string => !!p);
}

type Size = ReturnType<typeof narratorSize>;

export const SCENE_LEAD_FRAMES = 6; // a beat's scene appears this long before its voice starts
const HOME_AFTER_S = 1.2; // a beat that points at nothing for this long first sends the narrator to the scene's home
const DEAL_FRAMES = 4; // several elements shown by one cue come in this far apart
const FRAMING = ['title', 'subtitle', 'heading', 'caption', 'left', 'right', 'slots'];
const ALERT_S = 3; // a notification stays up this long without `until`

export interface PlannedBeat {
  beat: Beat;
  startFrame: number;
  endFrame: number;
  layout: Layout;
  /** Frame (within the scene) at which each element is first shown or pointed at. */
  shown: Record<string, number>;
  /** Spotlights: from `frame`, these elements are lit and the rest dimmed ('all' lit, null none). */
  spots: Array<{ frame: number; ids: string[] | 'all' | null }>;
  /** Glows pulsing from `from` to `to` (at least three pulses). */
  blinks: Array<{ id: string; from: number; to: number }>;
  /** Chips popping up beside an element. */
  notes: Array<{ id: string; text: string; frame: number }>;
  /** An element turning a quarter (spent), or back (restore). */
  spends: Array<{ id: string; frame: number; restore: boolean }>;
  /** Phone notifications, up from `frame` to `to`. */
  alerts: Array<{ from?: string; title: string; text?: string; frame: number; to: number }>;
  /** Frame (within the scene) of each phrase the scene's data names (arrows, timeline steps, underlines). */
  phrases: Record<string, number>;
  /** Elements the scene before had at these places: they glide from there instead of appearing. */
  carryIn: Record<string, Box>;
  /** Elements the next scene takes over: they don't fade out, and leave as it begins. */
  carryOut: string[];
  /** Cold open: what's on screen at the scene's first frame is already in place (and there's no fade-in). */
  instant: boolean;
}

/** The narrator stands at `stand` (after a hop from the last stop, `depart` to `arrive`) and points at `aim` from `frame`. */
interface Stop {
  frame: number;
  stand: Point;
  aim: Point | null;
  /** `<beat index>:<element id>`, for the scene to light it up. */
  target: string | null;
  depart: number;
  arrive: number;
  hops: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const nearest = (b: Box, p: Point): Point => ({ x: clamp(p.x, b.x, b.x + b.w), y: clamp(p.y, b.y, b.y + b.h) });

/** Where the stick touches a box, seen from p: the middle part of the facing edge, just outside it. */
function aimPoint(b: Box, p: Point, { R }: Size): Point {
  const gap = 0.06 * R;
  const dx = p.x < b.x ? b.x - p.x : Math.max(0, p.x - b.x - b.w);
  const dy = p.y < b.y ? b.y - p.y : Math.max(0, p.y - b.y - b.h);
  if (dy >= dx) return { x: clamp(p.x, b.x + 0.2 * b.w, b.x + 0.8 * b.w), y: p.y < b.y ? b.y - gap : b.y + b.h + gap };
  return { x: p.x < b.x ? b.x - gap : b.x + b.w + gap, y: clamp(p.y, b.y + 0.25 * b.h, b.y + 0.75 * b.h) };
}

const S = Math.SQRT1_2;
/** Sides to stand on, with a penalty in radii: below first, then beside, diagonally, and above only as a last resort. */
const SIDES: Array<[number, number, number]> = [[0, 1, 0], [1, 0, 0.5], [-1, 0, 0.5], [S, S, 1], [-S, S, 1], [0, -1, 4], [S, -S, 4.5], [-S, -S, 4.5]];
/** Penalty for pointing up from the narrator's own row (a longer stick) instead. */
const FROM_ROW_PENALTY = 1.5;

/**
 * Where to stand to point at `box`: right here if it's in reach and the spot is clear, else the nearest clear spot a
 * stick's length off one of its sides, or on the narrator's own row under it (pointing up with a longer stick), inside
 * the frame and clear of every element.
 */
function chooseStand(box: Box, from: Point, obstacles: Box[], stage: Stage, size: Size): Point {
  const { R, stick, reach, margin } = size;
  const { w, home } = stage;
  const ok = (p: Point) => p.x >= margin + R && p.x <= w - margin - R && p.y >= margin + R && p.y <= home.y + 0.01
    && obstacles.every(o => dist(p, nearest(o, p)) > 1.15 * R);
  if (ok(from) && dist(from, aimPoint(box, from, size)) <= reach) return from;
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const spots = SIDES.map(([dx, dy, penalty]) => {
    const edge = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
    const p = { x: c.x + dx * (edge + R + stick), y: c.y + dy * (edge + R + stick) };
    return { p, score: dist(from, p) + penalty * R };
  });
  const under = { x: clamp(c.x, margin + R, w - margin - R), y: home.y };
  spots.push({ p: under, score: dist(from, under) + FROM_ROW_PENALTY * R });
  return spots.filter(s => ok(s.p)).sort((a, b) => a.score - b.score)[0]?.p ?? from;
}

export function planVideo(script: Script, timeline: Timeline, fps: number, stage: Stage, totalFrames: number) {
  const size = narratorSize(Math.min(stage.w, stage.h));
  const toFrame = (ms: number) => Math.round((ms / 1000) * fps);

  const resolved = script.beats.map(beat => {
    const tb = timeline.beats.find(b => b.id === beat.id);
    if (!tb) throw new Error(`beat "${beat.id}" has no timing in timeline.json: re-run npm run voice`);
    if (!beat.scene?.type) throw new Error(`[${beat.id}] needs a scene, e.g. {"type": "text"}`);
    const ids = elementIds(beat);
    const layout = sceneOf(beat.scene).layout(beat.scene, beat, stage);
    const frameOf = (phrase: string | undefined) => {
      if (!phrase) return toFrame(tb.startMs);
      const ms = findPhrase(tb.words, phrase);
      if (ms === null) console.warn(`[${beat.id}] phrase "${phrase}" not found in voiceover; using the beat start`);
      return toFrame(ms ?? tb.startMs);
    };
    const cues = (beat.cues ?? []).map(cue => {
      const spotted = Array.isArray(cue.spot) ? cue.spot : cue.spot && cue.spot !== 'all' ? [cue.spot] : [];
      const named = [...[cue.show ?? []].flat(), cue.point, ...spotted, cue.blink, cue.note?.on, cue.spend, cue.restore].filter((id): id is string => !!id);
      for (const id of named) {
        if (!ids.includes(id)) throw new Error(`[${beat.id}] the ${beat.scene.type} scene has no "${id}" (${ids.join(', ')})`);
      }
      return { ...cue, frame: frameOf(cue.at), untilFrame: cue.until ? frameOf(cue.until) : null };
    }).sort((a, b) => a.frame - b.frame);
    const phrases = Object.fromEntries(scenePhrases(beat.scene).map(p => [p, frameOf(p)]));
    return { beat, layout, cues, phrases, voiceFrame: toFrame(tb.startMs) };
  });

  const beats: PlannedBeat[] = resolved.map((r, i) => {
    const startFrame = i === 0 ? 0 : Math.max(0, r.voiceFrame - SCENE_LEAD_FRAMES);
    const next = resolved[i + 1];
    const endFrame = next ? Math.max(startFrame + 1, next.voiceFrame - SCENE_LEAD_FRAMES) : totalFrames;
    const rel = (f: number) => f - startFrame;
    const b: PlannedBeat = {
      beat: r.beat, startFrame, endFrame, layout: r.layout, shown: {}, spots: [], blinks: [], notes: [], spends: [], alerts: [],
      phrases: Object.fromEntries(Object.entries(r.phrases).map(([p, f]) => [p, rel(f)])), carryIn: {}, carryOut: [], instant: false,
    };
    for (const c of r.cues) {
      // Several ids: dealt a moment apart, or spread evenly up to `until`.
      const show = [c.show ?? []].flat();
      show.forEach((id, k) => {
        const f = c.untilFrame !== null && show.length > 1 ? c.frame + ((c.untilFrame - c.frame) * k) / (show.length - 1) : c.frame + k * DEAL_FRAMES;
        b.shown[id] ??= Math.round(rel(f));
      });
      if (c.point) b.shown[c.point] ??= rel(c.frame);
      if (c.spot !== undefined) b.spots.push({ frame: rel(c.frame), ids: c.spot === null ? null : c.spot === 'all' ? 'all' : [c.spot].flat() });
      if (c.blink) b.blinks.push({ id: c.blink, from: rel(c.frame), to: rel(c.untilFrame ?? c.frame) });
      if (c.note) b.notes.push({ id: c.note.on, text: c.note.text, frame: rel(c.frame) });
      if (c.spend) b.spends.push({ id: c.spend, frame: rel(c.frame), restore: false });
      if (c.restore) b.spends.push({ id: c.restore, frame: rel(c.frame), restore: true });
      if (c.alert) b.alerts.push({ ...c.alert, frame: rel(c.frame), to: rel(c.untilFrame ?? c.frame + ALERT_S * fps) });
    }
    // A new notification sends the one before it away.
    b.alerts.forEach((a, k) => { const next = b.alerts[k + 1]; if (next) a.to = Math.min(a.to, next.frame); });
    return b;
  });

  // Carry-over: an element the scene before also showed, the same and in the same kind of scene, glides to its new
  // place instead of fading out and in again.
  beats.forEach((b, i) => {
    const prev = beats[i - 1];
    if (!prev || b.beat.carry === false || prev.beat.scene.type !== b.beat.scene.type) return;
    const before = new Set(elementIds(prev.beat));
    for (const id of elementIds(b.beat)) {
      const key = elementKey(b.beat, id);
      if (!before.has(id) || !key || key !== elementKey(prev.beat, id) || !prev.layout.anchors[id]) continue;
      b.carryIn[id] = prev.layout.anchors[id];
      b.shown[id] = 0;
      prev.carryOut.push(id);
    }
  });
  if (beats[0] && script.coldOpen !== false) beats[0].instant = true;

  // The narrator's stops: a scene's home when a beat starts without pointing, then one stop per point cue.
  const stops: Stop[] = [];
  let at = stage.home;
  const stop = (frame: number, stand: Point, aim: Point | null, target: string | null) => {
    stops.push({ frame, stand, aim, target, depart: frame, arrive: frame, hops: 0 });
    at = stand;
  };
  stop(0, at, null, null);
  resolved.forEach((r, i) => {
    const points = r.cues.filter(c => c.point !== undefined);
    if (i > 0 && (!points.length || points[0].frame - r.voiceFrame > HOME_AFTER_S * fps)) stop(r.voiceFrame, stage.home, null, null);
    const obstacles = Object.values(r.layout.anchors);
    for (const c of points) {
      if (!c.point) { stop(c.frame, at, null, null); continue; }
      const box = r.layout.anchors[c.point];
      const stand = chooseStand(box, at, obstacles, stage, size);
      stop(c.frame, stand, aimPoint(box, stand, size), `${i}:${c.point}`);
    }
  });

  // Hops: timed to land 2 frames before the cue, but never leaving before the last stop's stick is up.
  for (let k = 1; k < stops.length; k++) {
    const s = stops[k], prev = stops[k - 1];
    const d = dist(prev.stand, s.stand);
    if (d < 1) {
      s.depart = s.arrive = Math.max(s.frame, prev.arrive);
      continue;
    }
    const travel = Math.round(fps * clamp(0.25 + d / 2000, 0.3, 0.85));
    const earliest = Math.max(prev.frame, prev.arrive) + (prev.aim ? 8 : 0);
    s.depart = Math.max(earliest, s.frame - 2 - travel);
    s.arrive = s.depart + travel;
    s.hops = Math.max(1, Math.round(d / (4 * size.R)));
  }

  const looks = resolved.flatMap(r => r.cues.filter(c => c.narrator).map(c => ({ frame: c.frame, image: c.narrator! })));
  return { beats, stops, size, looks };
}

export interface NarratorPose {
  /** Body centre. */
  x: number;
  y: number;
  /** Where the body would rest without the hop (the shadow stays there). */
  ground: number;
  /** Squash and stretch. */
  sx: number;
  sy: number;
  /** Stick: the point it reaches for, and how far out it is (0-1, overshooting a little as it lands). */
  aim: Point | null;
  ext: number;
  /** Where the eyes look: a direction, each axis -1..1 (0, 0 = at the viewer). */
  look: Point;
  /** What it's pointing at (`<beat index>:<element id>`). */
  target: string | null;
}

/** Direction from a to b, shrinking to 0 for points close to the body. */
function towards(a: Point, b: Point, R: number): Point {
  const d = dist(a, b);
  if (d < 1) return { x: 0, y: 0 };
  const k = Math.min(1, d / (3 * R)) / d;
  return { x: (b.x - a.x) * k, y: (b.y - a.y) * k };
}

export function narratorAt(stops: Stop[], frame: number, fps: number, R: number): NarratorPose {
  let k = 0;
  while (k + 1 < stops.length && stops[k + 1].depart <= frame) k++;
  const s = stops[k], prev = stops[k - 1];

  if (prev && frame < s.arrive) {
    // Hopping from the last stop: the stick comes down at take-off, the eyes look where it's going.
    const p = (frame - s.depart) / (s.arrive - s.depart);
    const q = (p * s.hops) % 1;
    const d = dist(prev.stand, s.stand);
    const height = clamp((d / s.hops) * 0.35, 0.35 * R, 1.3 * R);
    const x = lerp(prev.stand.x, s.stand.x, p), ground = lerp(prev.stand.y, s.stand.y, p);
    const stretch = 0.08 * Math.sin(Math.PI * q);
    const ext = prev.aim ? clamp01(1 - (frame - s.depart) / 4) : 0;
    return {
      x, y: ground - height * 4 * q * (1 - q), ground, sx: 1 - 0.6 * stretch, sy: 1 + stretch,
      aim: prev.aim, ext, look: towards({ x, y: ground }, s.aim ?? s.stand, R), target: ext > 0.3 ? prev.target : null,
    };
  }

  // Standing: a springy squash on landing, a crouch just before the next hop.
  let squash = 0;
  if (s.hops) {
    const t = (frame - s.arrive) / fps;
    squash = 0.16 * Math.exp(-t * 9) * Math.cos(t * 26);
  }
  const next = stops[k + 1];
  if (next?.hops && next.depart - frame < 4) squash = Math.max(squash, 0.1 * (1 - (next.depart - frame) / 4));

  const start = Math.max(s.frame, s.arrive);
  const t = frame - start;
  const stayed = prev && !s.hops && prev.aim;
  let aim = s.aim, ext = 0, target = s.target;
  if (s.aim && stayed) {
    // Same spot, new target: the stick swings over.
    const m = clamp01(t / 7);
    aim = t < 0 ? prev.aim : { x: lerp(prev.aim!.x, s.aim.x, Easing.inOut(Easing.cubic)(m)), y: lerp(prev.aim!.y, s.aim.y, Easing.inOut(Easing.cubic)(m)) };
    ext = 1 - 0.15 * Math.sin(Math.PI * m);
    if (t < 3) target = prev.target;
  } else if (s.aim) {
    ext = t < 0 ? 0 : Easing.out(Easing.back(1.8))(clamp01(t / 8));
  } else if (stayed) {
    // Pointing at nothing now: lower the stick.
    aim = prev.aim;
    ext = clamp01(1 - t / 5);
    target = prev.target;
  }
  const stand = s.stand;
  const look = aim && ext > 0 ? towards(stand, aim, R) : { x: 0, y: 0 };
  const lookAmount = Math.min(1, ext * 1.5);
  return {
    x: stand.x, y: stand.y, ground: stand.y, sx: 1 + 0.7 * squash, sy: 1 - squash,
    aim, ext, look: { x: look.x * lookAmount, y: look.y * lookAmount }, target: ext > 0.3 ? target : null,
  };
}

/**
 * How an element looks on scene frame `f`: its cue effects (narrator pointing, spotlight, blinks, notes, spent),
 * carry-over from the scene before, and the scene's fades (`fadeIn`, `fadeOut`, 0-1).
 */
export function lookAt(b: PlannedBeat, id: string, f: number, pointed: number, fadeIn: number, fadeOut: number): Look {
  const appear = b.shown[id] ?? 0;
  const from = b.carryIn[id] ?? null;
  // Spotlight: from each entry until the next, eased over 6 frames from the one before.
  let k = -1;
  b.spots.forEach((s, j) => { if (s.frame <= f) k = j; });
  const cur = b.spots[k], prev = b.spots[k - 1];
  const lit = (s?: PlannedBeat['spots'][number]) => (s && (s.ids === 'all' || s.ids?.includes(id)) ? 1 : 0);
  // Titles, headings and captions frame the scene: a spotlight on others doesn't dim them.
  const dimmed = (s?: PlannedBeat['spots'][number]) => (s && Array.isArray(s.ids) && !s.ids.includes(id) && !FRAMING.includes(id) ? 1 : 0);
  const t = cur ? clamp01((f - cur.frame) / 6) : 1;
  // Blinks: 10-frame pulses, as many as fit before `to`, at least three.
  let pulse = 0;
  for (const bl of b.blinks) {
    const length = 10 * Math.max(3, Math.round((bl.to - bl.from) / 10));
    if (bl.id === id && f >= bl.from && f < bl.from + length) pulse = Math.max(pulse, 0.5 - 0.5 * Math.cos((2 * Math.PI * (f - bl.from)) / 10));
  }
  // Spent: eased over 10 frames toward each entry's state.
  let spent = 0;
  for (const s of b.spends) if (s.id === id && f >= s.frame) spent += ((s.restore ? 0 : 1) - spent) * Easing.inOut(Easing.quad)(clamp01((f - s.frame) / 10));
  const bump = Math.max(0, ...b.notes.filter(n => n.id === id && f >= n.frame).map(n => Math.sin(Math.PI * clamp01((f - n.frame) / 10))));
  // A carried-out element stays until the scene ends, then the next scene's copy takes over at the same place.
  const out = b.carryOut.includes(id) ? (f < b.endFrame - b.startFrame ? 1 : 0) : fadeOut;
  return {
    appear, instant: (b.instant && appear === 0) || !!from,
    glow: Math.max(pointed, lerp(lit(prev), lit(cur), t), pulse), dim: lerp(dimmed(prev), dimmed(cur), t), spent, bump,
    fade: (from ? 1 : fadeIn) * out, from, glide: from ? Easing.inOut(Easing.cubic)(clamp01(f / 12)) : 1,
  };
}
