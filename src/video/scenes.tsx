// The scene kit: what a beat can show, laid out from the script's data for any frame shape. Each scene type turns its
// content into boxes (cues show them; the narrator points at them and keeps clear of them) and draws them. Every
// element goes through El, which applies its Look: popping in at its cue, the glow of pointing, spotlights and blinks,
// dimming, turning when spent, gliding over from the scene before, and the scene's fades. Text is sized to fit its
// box, so any wording works. docs/SPEC.md lists the types.
import type React from 'react';
import { useMemo } from 'react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from '../engine/index.ts';
import type { Beat, Box, CycleArrow, Item, MarkBox, RoadMove, Scene, Theme, Tone } from '../types.ts';
import { fontFamily, monoFamily } from './fonts.ts';
import { scene3d } from './scene3d.tsx';

export interface Point { x: number; y: number }

export const DEFAULT_THEME: Theme = {
  bg: '#11131f', panel: '#1b1f31', line: '#2f3552', text: '#eef0ff', muted: '#8d93b8', accent: '#ffb238', no: '#ff5d6c', yes: '#7ce0c3',
};
export const STEP_COLORS = ['#7aa2ff', '#ff8fb1', '#7ce0c3', '#ffd166', '#b69cff', '#6fd3ff'];

/** Where scenes are laid out, for one frame shape (plan.ts stageFor). */
export interface Stage {
  w: number;
  h: number;
  /** Layout unit: 1 at 1080 px on the frame's shorter side. */
  u: number;
  /** Clearly wider than tall: rows read better than columns. */
  wide: boolean;
  /** Where content goes: inside the margins, above the narrator's strip and the captions. */
  content: Box;
  /** Where the narrator rests. */
  home: Point;
  /** Natural sizes of the project's pictures, by src. */
  images: Record<string, { w: number; h: number }>;
}

/** A scene's elements for one stage: boxes by id, and the font size each text element was fitted at. */
export interface Layout { anchors: Record<string, Box>; fonts: Record<string, number> }

/** How an element looks on this frame (plan.ts lookAt). */
export interface Look {
  /** Frame (within the scene) it appears: its first cue, else the scene's start. */
  appear: number;
  /** Already in place when it appears (cold open, carried over): no pop. */
  instant: boolean;
  /** Glow 0-1: pointed at, spotlit or blinking. */
  glow: number;
  /** Dimmed 0-1 by a spotlight on others. */
  dim: number;
  /** Turned a quarter 0-1 (spent). */
  spent: number;
  /** A short pulse 0-1 (a note arriving). */
  bump: number;
  /** The scene's fade for it, 0-1. */
  fade: number;
  /** Where it was in the scene before (carried over), and how far it has glided from there, 0-1. */
  from: Box | null;
  glide: number;
}

export interface SceneProps<S extends Scene = Scene> {
  scene: S;
  beat: Beat;
  layout: Layout;
  stage: Stage;
  theme: Theme;
  /** Project folder under projects/ (pictures are read from there). */
  project: string;
  /** Frame (within the scene) at which an element appears: its first cue, else the scene's start. */
  shown: (id: string) => number;
  /** Whether any cue names the element. */
  cued: (id: string) => boolean;
  /** How an element looks right now. */
  look: (id: string) => Look;
  /** Frame (within the scene) the voice reaches a phrase the scene's data names; `fallback` without one. */
  at: (phrase: string | undefined, fallback: number) => number;
  /** The scene's fade, 0-1, for what isn't an element (arrows, outlines). */
  fade: number;
  /** Underline boxes found by OCR, by "<src>|<text>" (npm run render). */
  marks: Record<string, MarkBox[]>;
}

export interface SceneDef<S extends Scene> { layout: (scene: S, beat: Beat, stage: Stage) => Layout; Component: React.FC<SceneProps<S>> }

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const withAlpha = (hex: string, a: number) => hex + Math.round(clamp01(a) * 255).toString(16).padStart(2, '0');
export const toneColor = (theme: Theme, tone: Tone | undefined, fallback: string) => (tone ? theme[tone] : fallback);
const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const centered = (outer: Box, w: number, h: number): Box => ({ x: outer.x + (outer.w - w) / 2, y: outer.y + (outer.h - h) / 2, w, h });

// Text fitting. Montserrat ExtraBold's glyphs average ~0.6 em; a greedy word wrap gives the line count.
const CHAR_EM = 0.6;
const LINE = 1.18;

function lineCount(text: string, width: number, size: number): number {
  const perLine = Math.max(1, Math.floor(width / (CHAR_EM * size)));
  let lines = 1, used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const len = word.length;
    if (used && used + 1 + len > perLine) { lines++; used = 0; }
    if (len > perLine) { lines += Math.floor(len / perLine); used = len % perLine; } else used += (used ? 1 : 0) + len;
  }
  return lines;
}

/** Height of `text` at `size` in a box `width` wide. */
const textHeight = (text: string, width: number, size: number) => lineCount(text, width, size) * size * LINE;

/** The largest font size up to `max` at which `text` fits in width x height. */
function fitFont(text: string, width: number, height: number, max: number): number {
  let size = Math.floor(max);
  while (size > 10 && textHeight(text, width, size) > height) size--;
  return size;
}

/** 0 -> 1, with a little overshoot, from frame `at` (1 at once when `instant`). */
function usePop(at: number, instant = false) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return 0;
  return instant ? 1 : spring({ frame: frame - at, fps, config: { damping: 12, stiffness: 170, mass: 0.7 } });
}

/**
 * An element at its box, looking as `look` says: popping in (scaling, or rising for text), glowing bigger, dimmed,
 * turned when spent, gliding from where the scene before had it, faded with the scene. `extra`: more scale (an arrival).
 */
export const El: React.FC<{ box: Box; look: Look; rise?: boolean; extra?: number; children: (p: number) => React.ReactNode }> = ({ box, look, rise, extra = 0, children }) => {
  const p = usePop(look.appear, look.instant);
  if (p <= 0 || look.fade <= 0) return null;
  let transform = '';
  if (look.from && look.glide < 1) {
    // FLIP: drawn at its new box, moved and scaled to look like its old one, then let go.
    const a = centre(look.from), b = centre(box);
    transform += `translate(${(a.x - b.x) * (1 - look.glide)}px, ${(a.y - b.y) * (1 - look.glide)}px) scale(${lerp(look.from.h / box.h, 1, look.glide)}) `;
  }
  const grow = (rise ? 1 : 0.7 + 0.3 * p) * (1 + 0.05 * look.glow + 0.06 * Math.max(look.bump, extra)) * (1 - 0.2 * look.spent);
  transform += `translateY(${rise ? (1 - p) * 20 : 0}px) scale(${grow}) rotate(${90 * look.spent}deg)`;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, opacity: Math.min(1, p) * look.fade * (1 - 0.65 * look.dim), transform }}>
      {children(p)}
    </div>
  );
};

export const Text: React.FC<{ size: number; color: string; weight?: number; align?: 'center' | 'left'; children: React.ReactNode }> = ({ size, color, weight = 800, align = 'center', children }) => (
  <div style={{ fontFamily, fontSize: size, fontWeight: weight, color, lineHeight: LINE, textAlign: align, textWrap: 'balance', overflowWrap: 'anywhere' }}>{children}</div>
);

/** A panel that lights up in its colour while it glows (pointed at, spotlit, blinking). */
const Panel: React.FC<{ box: Box; look: Look; color: string; theme: Theme; u: number; align?: 'center' | 'left'; dashed?: boolean; extra?: number; children?: React.ReactNode }> = ({ box, look, color, theme, u, align = 'center', dashed, extra, children }) => (
  <El box={box} look={look} extra={extra}>
    {() => (
      <div
        style={{
          position: 'absolute', inset: 0, padding: `0 ${24 * u}px`, borderRadius: 22 * u, background: dashed ? 'transparent' : theme.panel,
          border: `${3 * u}px ${dashed ? 'dashed' : 'solid'} ${withAlpha(color, 0.3 + 0.7 * look.glow)}`,
          boxShadow: dashed ? undefined : `0 ${18 * u}px ${40 * u}px rgba(0,0,0,0.45), 0 0 ${60 * u}px ${withAlpha(color, 0.5 * look.glow)}`,
          display: 'flex', flexDirection: 'column', alignItems: align === 'center' ? 'center' : 'stretch', justifyContent: 'center',
        }}
      >
        {children}
      </div>
    )}
  </El>
);

/** Text without a panel (titles, headings), rising into place. */
const Words: React.FC<{ box: Box; look: Look; size: number; color: string; weight?: number; theme: Theme; children: React.ReactNode }> = ({ box, look, size, color, weight, theme, children }) => (
  <El box={box} look={look} rise>
    {() => (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textShadow: look.glow ? `0 0 ${30 * look.glow}px ${withAlpha(theme.accent, 0.6 * look.glow)}` : undefined }}>
        <Text size={size} color={color} weight={weight}>{children}</Text>
      </div>
    )}
  </El>
);

/** Struck through, left to right, from frame `at`. */
const Strike: React.FC<{ at: number; color: string; u: number }> = ({ at, color, u }) => {
  const drawn = interpolate(useCurrentFrame(), [at, at + 8], [0, 1], { ...clampOpts, easing: Easing.out(Easing.quad) });
  if (drawn <= 0) return null;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <line x1={6} y1={58} x2={6 + 88 * drawn} y2={58 - 14 * drawn} stroke={color} strokeWidth={7 * u} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

/** An arrow drawn from a to b over 8 frames from `at`. */
const Arrow: React.FC<{ from: Point; to: Point; at: number; color: string; u: number; opacity: number }> = ({ from, to, at, color, u, opacity }) => {
  const drawn = interpolate(useCurrentFrame(), [at, at + 8], [0, 1], { ...clampOpts, easing: Easing.out(Easing.cubic) });
  if (drawn <= 0) return null;
  const head = 14 * u;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const end = { x: from.x + (to.x - from.x) * drawn, y: from.y + (to.y - from.y) * drawn };
  const back = (d: number, side: number) => ({ x: end.x - Math.cos(angle) * d - Math.sin(angle) * side, y: end.y - Math.sin(angle) * d + Math.cos(angle) * side });
  const [l, r, base] = [back(head, head * 0.7), back(head, -head * 0.7), back(head * 0.6, 0)];
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible', opacity }}>
      <line x1={from.x} y1={from.y} x2={base.x} y2={base.y} stroke={color} strokeWidth={4 * u} strokeLinecap="round" />
      <polygon points={`${end.x},${end.y} ${l.x},${l.y} ${r.x},${r.y}`} fill={color} />
    </svg>
  );
};

/** A pill of text (a note, an arrow's label) centred on `at`, kept inside the frame. */
export const Chip: React.FC<{ at: Point; text: string; size: number; color: string; theme: Theme; opacity: number; scale?: number }> = ({ at, text, size, color, theme, opacity, scale = 1 }) => {
  const { width } = useVideoConfig();
  const half = (text.length * size * CHAR_EM + 1.2 * size) / 2;
  return (
    <div
      style={{
        position: 'absolute', left: Math.min(Math.max(at.x, half + 12), width - half - 12), top: at.y, transform: `translate(-50%, -50%) scale(${scale})`,
        padding: `${0.12 * size}px ${0.5 * size}px`, borderRadius: 999, background: theme.bg, border: `${Math.max(2, size / 12)}px solid ${color}`, color,
        fontFamily, fontSize: size, fontWeight: 800, whiteSpace: 'nowrap', opacity, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      }}
    >
      {text}
    </div>
  );
};

/** Notes (cue `note`): a chip popping up at an element's top right corner. */
export const Notes: React.FC<{ notes: Array<{ id: string; text: string; frame: number }>; anchors: Record<string, Box>; theme: Theme; u: number; fade: number }> = ({ notes, anchors, theme, u, fade }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <>
      {notes.filter(n => frame >= n.frame && anchors[n.id]).map(n => {
        const p = spring({ frame: frame - n.frame, fps, config: { damping: 12, stiffness: 170, mass: 0.7 } });
        const b = anchors[n.id];
        return <Chip key={`${n.id}-${n.frame}`} at={{ x: b.x + b.w, y: b.y }} text={n.text} size={36 * u} color={theme.accent} theme={theme} opacity={Math.min(1, p) * fade} scale={0.6 + 0.4 * p} />;
      })}
    </>
  );
};

// title: a big title and an optional subtitle.

const title: SceneDef<Extract<Scene, { type: 'title' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const w = c.w * 0.9;
    const titleSize = fitFont(s.title, w, c.h * 0.5, (wide ? 124 : 108) * u);
    const titleH = textHeight(s.title, w, titleSize);
    const subSize = s.subtitle ? fitFont(s.subtitle, w, c.h * 0.25, 50 * u) : 0;
    const subH = s.subtitle ? textHeight(s.subtitle, w, subSize) : 0;
    const gap = s.subtitle ? 36 * u : 0;
    const block = centered(c, w, titleH + gap + subH);
    const anchors: Record<string, Box> = { title: { ...block, h: titleH } };
    if (s.subtitle) anchors.subtitle = { ...block, y: block.y + titleH + gap, h: subH };
    return { anchors, fonts: { title: titleSize, subtitle: subSize } };
  },
  Component: ({ scene, layout: { anchors: a, fonts }, theme, look }) => (
    <>
      <Words box={a.title} look={look('title')} size={fonts.title} color={theme.text} weight={900} theme={theme}>{scene.title}</Words>
      {scene.subtitle && <Words box={a.subtitle} look={look('subtitle')} size={fonts.subtitle} color={theme.accent} weight={700} theme={theme}>{scene.subtitle}</Words>}
    </>
  ),
};

// text: a statement in big type (the beat's own words unless `text` is given).

const text: SceneDef<Extract<Scene, { type: 'text' }>> = {
  layout: (s, beat, { content: c, u, wide }) => {
    const body = s.text ?? beat.text;
    const w = c.w * (wide ? 0.8 : 0.9);
    const size = fitFont(body, w, c.h * 0.85, (wide ? 76 : 70) * u);
    return { anchors: { text: centered(c, w, textHeight(body, w, size)) }, fonts: { text: size } };
  },
  Component: ({ scene, beat, layout: { anchors: a, fonts }, theme, look }) => (
    <Words box={a.text} look={look('text')} size={fonts.text} color={theme.text} theme={theme}>{scene.text ?? beat.text}</Words>
  ),
};

// points: an optional heading over a list of items.

/** A heading over the content, and the area left under it. */
export function headed(heading: string | undefined, c: Box, u: number, gap: number, max = 62): { anchors: Record<string, Box>; fonts: Record<string, number>; area: Box } {
  if (!heading) return { anchors: {}, fonts: {}, area: c };
  const w = c.w * 0.9, size = fitFont(heading, w, 150 * u, max * u), h = textHeight(heading, w, size);
  return { anchors: { heading: { x: c.x + c.w * 0.05, y: c.y, w, h } }, fonts: { heading: size }, area: { x: c.x, y: c.y + h + gap * u, w: c.w, h: c.h - h - gap * u } };
}

export const Heading: React.FC<{ text?: string; props: SceneProps }> = ({ text: t, props: { layout: { anchors: a, fonts }, theme, look } }) =>
  (t ? <Words box={a.heading} look={look('heading')} size={fonts.heading} color={theme.text} weight={900} theme={theme}>{t}</Words> : null);

const points: SceneDef<Extract<Scene, { type: 'points' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const { anchors, fonts, area } = headed(s.heading, c, u, 40);
    const w = wide ? Math.min(c.w * 0.64, 1150 * u) : c.w * 0.96;
    const n = Math.max(1, s.items.length), gap = 22 * u;
    const itemH = Math.min(112 * u, (area.h - gap * (n - 1)) / n);
    const textW = w - 2 * 24 * u - 44 * u; // padding and the bullet
    fonts.item = Math.min(...s.items.map(it => fitFont(it.text, textW, itemH * 0.86, 46 * u)));
    const y0 = area.y + (area.h - (n * itemH + (n - 1) * gap)) / 2;
    s.items.forEach((it, i) => { anchors[it.id] = { x: c.x + (c.w - w) / 2, y: y0 + i * (itemH + gap), w, h: itemH }; });
    return { anchors, fonts };
  },
  Component: props => {
    const { scene, layout: { anchors: a, fonts }, stage: { u }, theme, look } = props;
    return (
      <>
        <Heading text={scene.heading} props={props} />
        {scene.items.map(it => <ItemPanel key={it.id} item={it} box={a[it.id]} look={look(it.id)} size={fonts.item} theme={theme} u={u} bullet />)}
      </>
    );
  },
};

const ItemPanel: React.FC<{ item: Item; box: Box; look: Look; size: number; theme: Theme; u: number; bullet?: boolean; tone?: Tone }> = ({ item, box, look, size, theme, u, bullet, tone }) => {
  const color = toneColor(theme, item.tone ?? tone, theme.accent);
  return (
    <Panel box={box} look={look} color={color} theme={theme} u={u} align={bullet ? 'left' : 'center'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 * u, justifyContent: bullet ? 'flex-start' : 'center' }}>
        {bullet && <div style={{ flex: 'none', width: 22 * u, height: 22 * u, borderRadius: '50%', background: color }} />}
        <Text size={size} color={item.strike ? theme.muted : theme.text} align={bullet ? 'left' : 'center'}>{item.text}</Text>
      </div>
      {item.strike && <Strike at={look.appear + 10} color={theme.no} u={u} />}
    </Panel>
  );
};

// compare: two columns of items side by side, each under its title.

const compare: SceneDef<Extract<Scene, { type: 'compare' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const gap = wide ? Math.min(380 * u, c.w * 0.22) : c.w * 0.06;
    const cw = wide ? Math.min(560 * u, (c.w - gap) / 2) : (c.w - gap) / 2;
    const n = Math.max(1, s.left.items.length, s.right.items.length);
    const headH = 80 * u, headGap = 30 * u, itemGap = Math.min(44 * u, c.h * 0.04);
    const itemH = Math.min(120 * u, (c.h - headH - headGap - (n - 1) * itemGap) / n);
    const top = c.y + (c.h - (headH + headGap + n * itemH + (n - 1) * itemGap)) / 2;
    const xs = { left: c.x + c.w / 2 - gap / 2 - cw, right: c.x + c.w / 2 + gap / 2 };
    const anchors: Record<string, Box> = {};
    const all: Item[] = [];
    for (const side of ['left', 'right'] as const) {
      anchors[side] = { x: xs[side], y: top, w: cw, h: headH };
      s[side].items.forEach((it, i) => { anchors[it.id] = { x: xs[side], y: top + headH + headGap + i * (itemH + itemGap), w: cw, h: itemH }; });
      all.push(...s[side].items);
    }
    const fonts = {
      head: Math.min(...[s.left.title, s.right.title].map(t => fitFont(t.toUpperCase(), cw, headH, 52 * u))),
      item: Math.min(...all.map(it => fitFont(it.text, cw - 48 * u, itemH * 0.86, (wide ? 54 : 46) * u))),
    };
    return { anchors, fonts };
  },
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u }, theme, cued, look }) => (
    <>
      {(['left', 'right'] as const).map(side => {
        const col = scene[side];
        // A column title appears at its own cue, else with its first item.
        const first = col.items[0]?.id;
        const head = look(side);
        return (
          <div key={side}>
            <Words box={a[side]} look={cued(side) || !first ? head : { ...head, appear: look(first).appear }} size={fonts.head} color={toneColor(theme, col.tone, theme.muted)} weight={900} theme={theme}>
              {col.title.toUpperCase()}
            </Words>
            {col.items.map(it => <ItemPanel key={it.id} item={it} tone={col.tone} box={a[it.id]} look={look(it.id)} size={fonts.item} theme={theme} u={u} />)}
          </div>
        );
      })}
    </>
  ),
};

// flow: steps joined by arrows, a row on wide frames and a column otherwise; `slots` outlines them all before they appear.

const flow: SceneDef<Extract<Scene, { type: 'flow' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const { anchors, fonts, area } = headed(s.heading, c, u, 50, 64);
    const n = Math.max(1, s.steps.length);
    let boxes: Box[];
    if (wide) {
      const minGap = 46 * u;
      const w = Math.min(340 * u, (area.w - (n - 1) * minGap) / n), h = Math.min(210 * u, area.h);
      const gap = n > 1 ? Math.min(140 * u, (area.w - n * w) / (n - 1)) : 0;
      const row = centered(area, n * w + (n - 1) * gap, h);
      boxes = s.steps.map((_, i) => ({ x: row.x + i * (w + gap), y: row.y, w, h }));
    } else {
      const minGap = 44 * u;
      const h = Math.min(170 * u, (area.h - (n - 1) * minGap) / n), w = Math.min(720 * u, area.w * 0.86);
      const gap = n > 1 ? Math.min(100 * u, (area.h - n * h) / (n - 1)) : 0;
      const col = centered(area, w, n * h + (n - 1) * gap);
      boxes = s.steps.map((_, i) => ({ x: col.x, y: col.y + i * (h + gap), w, h }));
    }
    s.steps.forEach((st, i) => { anchors[st.id] = boxes[i]; });
    const b0 = boxes[0], bn = boxes[boxes.length - 1];
    anchors.slots = { x: b0.x, y: b0.y, w: bn.x + bn.w - b0.x, h: bn.y + bn.h - b0.y };
    const { w, h } = b0;
    const hasDetail = s.steps.some(st => st.detail);
    fonts.label = Math.min(...s.steps.map(st => fitFont(st.label, w - 48 * u, h * (hasDetail ? 0.42 : 0.7), 50 * u)));
    fonts.detail = hasDetail ? Math.min(...s.steps.map(st => fitFont(st.detail ?? '', w - 48 * u, h * 0.36, 32 * u))) : 0;
    return { anchors, fonts };
  },
  Component: props => {
    const { scene, layout: { anchors: a, fonts }, stage: { u, wide }, theme, shown, cued, look, fade } = props;
    const frame = useCurrentFrame();
    const slots = cued('slots') ? shown('slots') : Infinity;
    return (
      <>
        <Heading text={scene.heading} props={props} />
        {scene.steps.map((st, i) => {
          const box = a[st.id], l = look(st.id), color = STEP_COLORS[i % STEP_COLORS.length];
          const prev = scene.steps[i - 1] && a[scene.steps[i - 1].id];
          const pad = 10 * u;
          const arrow = prev && (wide
            ? { from: { x: prev.x + prev.w + pad, y: box.y + box.h / 2 }, to: { x: box.x - pad, y: box.y + box.h / 2 } }
            : { from: { x: box.x + box.w / 2, y: prev.y + prev.h + pad }, to: { x: box.x + box.w / 2, y: box.y - pad } });
          return (
            <div key={st.id}>
              {frame >= slots && frame < l.appear + 4 && (
                <div
                  style={{
                    position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: 22 * u,
                    border: `${3 * u}px dashed ${theme.line}`, opacity: fade * interpolate(frame, [slots + 2 * i, slots + 2 * i + 6], [0, 1], clampOpts),
                  }}
                />
              )}
              {arrow && <Arrow {...arrow} at={l.appear - 4} color={theme.muted} u={u} opacity={fade} />}
              <Panel box={box} look={l} color={color} theme={theme} u={u}>
                <div style={{ position: 'absolute', left: 14 * u, top: 12 * u, fontFamily, fontSize: 24 * u, fontWeight: 900, color }}>{i + 1}</div>
                <Text size={fonts.label} color={theme.text}>{st.label}</Text>
                {st.detail && <div style={{ height: 8 * u }} />}
                {st.detail && <Text size={fonts.detail} color={theme.muted} weight={700}>{st.detail}</Text>}
              </Panel>
            </div>
          );
        })}
      </>
    );
  },
};

// image: a picture fitted inside the stage, an optional caption under it, named regions to point at, and underlines.

const UNDERLINE_FRAMES = 12;

/**
 * A marker stroke growing left to right under printed words, line after line (one box per printed line, as fractions
 * of the picture `pic`). A dark stroke under the accent keeps it visible on light and dark pictures alike; the slight
 * dip reads as drawn by hand.
 */
const Underline: React.FC<{ boxes: MarkBox[]; pic: Box; start: number; color: string; u: number; opacity: number }> = ({ boxes, pic, start, color, u, opacity }) => {
  const frame = useCurrentFrame();
  if (frame < start || !boxes.length) return null;
  const lines = boxes.map(b => ({ x0: pic.x + b.x0 * pic.w - 6 * u, x1: pic.x + b.x1 * pic.w + 6 * u, y: pic.y + b.y1 * pic.h + 6 * u }));
  const total = lines.reduce((n, l) => n + l.x1 - l.x0, 0);
  const drawn = interpolate(frame - start, [0, UNDERLINE_FRAMES], [0, total], { ...clampOpts, easing: Easing.out(Easing.quad) });
  let before = 0;
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible', opacity }}>
      {lines.map((l, i) => {
        const len = l.x1 - l.x0;
        const shown = Math.min(len, Math.max(0, drawn - before));
        before += len;
        if (shown <= 0) return null;
        const d = `M ${l.x0} ${l.y} Q ${(l.x0 + l.x1) / 2} ${l.y + 5 * u} ${l.x1} ${l.y - 2 * u}`;
        const dash = `${shown} ${len * 2}`;
        return (
          <g key={i} fill="none" strokeLinecap="round">
            <path d={d} stroke="rgba(0,0,0,0.7)" strokeWidth={12 * u} strokeDasharray={dash} />
            <path d={d} stroke={color} strokeWidth={7 * u} strokeDasharray={dash} />
          </g>
        );
      })}
    </svg>
  );
};

const srcOf = (project: string, src: string) => (/^https?:/.test(src) ? src : staticFile(`${project}/${src}`));

const image: SceneDef<Extract<Scene, { type: 'image' }>> = {
  layout: (s, _beat, { content: c, u, images }) => {
    const capW = c.w * 0.9;
    const capSize = s.caption ? fitFont(s.caption, capW, 130 * u, 42 * u) : 0;
    const capH = s.caption ? textHeight(s.caption, capW, capSize) + 24 * u : 0;
    const natural = images[s.src] ?? { w: 16, h: 9 };
    const room = { ...c, h: c.h - capH };
    const k = Math.min(room.w / natural.w, room.h / natural.h);
    const pic = centered(room, natural.w * k, natural.h * k);
    pic.y = c.y + (c.h - pic.h - capH) / 2;
    const anchors: Record<string, Box> = { image: pic };
    if (s.caption) anchors.caption = { x: c.x + (c.w - capW) / 2, y: pic.y + pic.h + 24 * u, w: capW, h: capH - 24 * u };
    for (const [id, [x, y, w, h]] of Object.entries(s.regions ?? {})) {
      anchors[id] = { x: pic.x + x * pic.w, y: pic.y + y * pic.h, w: w * pic.w, h: h * pic.h };
    }
    return { anchors, fonts: { caption: capSize } };
  },
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u }, theme, project, shown, cued, look, at, fade, marks }) => {
    const frame = useCurrentFrame();
    const pic = a.image, l = look('image');
    return (
      <>
        <El box={pic} look={l}>
          {() => <Img src={srcOf(project, scene.src)} style={{ width: '100%', height: '100%', borderRadius: 18 * u, boxShadow: `0 ${18 * u}px ${50 * u}px rgba(0,0,0,0.5)`, display: 'block' }} />}
        </El>
        {Object.keys(scene.regions ?? {}).map(id => {
          const r = a[id], lit = look(id).glow, outlined = cued(id) && frame >= shown(id) ? 0.45 : 0;
          const strength = Math.max(lit, outlined);
          if (strength <= 0 || frame < l.appear) return null;
          return (
            <div
              key={id}
              style={{
                position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 12 * u, opacity: fade,
                border: `${6 * u}px solid ${withAlpha(theme.accent, strength)}`, background: withAlpha(theme.accent, 0.16 * lit),
                boxShadow: `0 0 ${50 * u * lit}px ${withAlpha(theme.accent, 0.8 * lit)}`,
              }}
            />
          );
        })}
        {(scene.marks ?? []).map(m => {
          const boxes = m.box ? [{ x0: m.box[0], y0: m.box[1], x1: m.box[2], y1: m.box[3] }] : marks[`${scene.src}|${m.text}`] ?? [];
          return <Underline key={m.text} boxes={boxes} pic={pic} start={Math.max(at(m.at, l.appear + 10), l.appear + 10)} color={theme.accent} u={u} opacity={l.fade} />;
        })}
        {scene.caption && <Words box={a.caption} look={look('caption')} size={fonts.caption} color={theme.muted} weight={700} theme={theme}>{scene.caption}</Words>}
      </>
    );
  },
};

// cycle: nodes joined by curved arrows drawn on their phrases, then light running along them.

const ARROW_FRAMES = 12;

/** Node boxes for a layout, inside `area`. */
function cycleBoxes(layout: 'ring' | 'grid' | 'payoff', n: number, area: Box, w: number, h: number): Box[] {
  if (layout === 'payoff') {
    const below = n - 1, gap = below > 1 ? Math.min(w * 0.6, (area.w - below * w) / (below - 1)) : 0;
    const row = centered(area, below * w + (below - 1) * gap, h);
    return [
      { x: area.x + (area.w - w) / 2, y: area.y, w, h },
      ...Array.from({ length: below }, (_, i) => ({ x: row.x + i * (w + gap), y: area.y + area.h - h, w, h })),
    ];
  }
  if (layout === 'grid') {
    const rows = Math.ceil(n / 2), gx = Math.min(w * 0.9, area.w - 2 * w), gy = rows > 1 ? Math.min(h * 0.9, (area.h - rows * h) / (rows - 1)) : 0;
    const block = centered(area, 2 * w + gx, rows * h + (rows - 1) * gy);
    return Array.from({ length: n }, (_, i) => ({ x: block.x + (i % 2) * (w + gx), y: block.y + Math.floor(i / 2) * (h + gy), w, h }));
  }
  // ring: clockwise from the top, on an ellipse that fills the area.
  const c = centre(area), rx = Math.max(0, (area.w - w) / 2), ry = Math.max(0, (area.h - h) / 2);
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { x: c.x + rx * Math.cos(a) * (n === 2 ? 1 : 0.92) - w / 2, y: c.y + ry * Math.sin(a) - h / 2, w, h };
  });
}

const unit = (x: number, y: number): Point => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };

/** Where an arrow leaves or reaches a box: the middle of the side facing `dir`, just off it, with that side's normal. */
function sideOf(r: Box, dir: Point, gap: number): { at: Point; normal: Point } {
  const c = centre(r);
  if (Math.abs(dir.x) * r.h > Math.abs(dir.y) * r.w) {
    const s = Math.sign(dir.x);
    return { at: { x: c.x + s * (r.w / 2 + gap), y: c.y }, normal: { x: s, y: 0 } };
  }
  const s = Math.sign(dir.y);
  return { at: { x: c.x, y: c.y + s * (r.h / 2 + gap) }, normal: { x: 0, y: s } };
}

/** A cubic curve from box a to box b, bowing away from the diagram's middle; `out` is that direction (for the label). */
function arrowCurve(a: Box, b: Box, middle: Point, u: number): { points: Point[]; out: Point } {
  const ca = centre(a), cb = centre(b);
  const out = unit((ca.x + cb.x) / 2 - middle.x, (ca.y + cb.y) / 2 - middle.y);
  const ab = unit(cb.x - ca.x, cb.y - ca.y);
  const from = sideOf(a, { x: ab.x + out.x, y: ab.y + out.y }, 16 * u);
  const to = sideOf(b, { x: out.x - ab.x, y: out.y - ab.y }, 16 * u);
  const bow = Math.min(120 * u, Math.max(50 * u, 0.3 * Math.hypot(to.at.x - from.at.x, to.at.y - from.at.y)));
  return {
    points: [from.at, { x: from.at.x + from.normal.x * bow, y: from.at.y + from.normal.y * bow }, { x: to.at.x + to.normal.x * bow, y: to.at.y + to.normal.y * bow }, to.at],
    out,
  };
}

/** A payoff's arrow: up from a box below into the top box's bottom edge, spread so the arrows don't meet in one point. */
function feedCurve(a: Box, b: Box, u: number): { points: Point[]; out: Point } {
  const from = { x: a.x + a.w / 2, y: a.y - 16 * u };
  const to = { x: centre(b).x + 0.4 * (from.x - centre(b).x), y: b.y + b.h + 16 * u };
  const bow = 0.45 * (from.y - to.y);
  return { points: [from, { x: from.x, y: from.y - bow }, { x: to.x, y: to.y + bow }, to], out: unit(from.x - to.x, 0) };
}

function bezier(p: Point[], t: number): Point {
  const s = 1 - t, k = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  return { x: k.reduce((n, w, i) => n + w * p[i].x, 0), y: k.reduce((n, w, i) => n + w * p[i].y, 0) };
}

function curveLength(p: Point[]): number {
  let len = 0, prev = p[0];
  for (let i = 1; i <= 40; i++) { const q = bezier(p, i / 40); len += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
  return len;
}

const cycleLayout = (s: Extract<Scene, { type: 'cycle' }>) => (s.layout === 'triangle' || !s.layout ? 'ring' : s.layout);

const cycle: SceneDef<Extract<Scene, { type: 'cycle' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const { anchors, fonts, area } = headed(s.heading, c, u, 40);
    const n = Math.max(1, s.nodes.length), layout = cycleLayout(s);
    const hasImage = s.nodes.some(nd => nd.image), hasDetail = s.nodes.some(nd => nd.detail);
    const across = layout === 'payoff' ? Math.max(1, n - 1) : layout === 'grid' ? 2 : n <= 3 ? 2 : 3;
    const w = Math.min((wide ? 360 : 330) * u, (area.w * (wide ? 0.7 : 0.9)) / across);
    const down = layout === 'payoff' || layout === 'ring' ? 2 : Math.ceil(n / 2);
    const h = Math.min(hasImage ? w * 0.95 : w * (hasDetail ? 0.62 : 0.5), (area.h * 0.8) / down);
    cycleBoxes(layout, n, area, w, h).forEach((b, i) => { anchors[s.nodes[i].id] = b; });
    const textH = hasImage ? h * 0.3 : h * 0.8;
    fonts.label = Math.min(...s.nodes.map(nd => fitFont(nd.label, w - 40 * u, textH * (hasDetail ? 0.6 : 1), 46 * u)));
    fonts.detail = hasDetail ? Math.min(...s.nodes.map(nd => fitFont(nd.detail ?? '', w - 40 * u, textH * 0.4, 28 * u))) : 0;
    fonts.arrow = 28 * u;
    return { anchors, fonts };
  },
  Component: props => {
    const { scene, layout: { anchors: a, fonts }, stage: { u }, theme, project, cued, look, at, fade } = props;
    const frame = useCurrentFrame();
    const layout = cycleLayout(scene);
    const index = (id: string) => scene.nodes.findIndex(nd => nd.id === id);
    for (const ar of scene.arrows) if (index(ar.from) < 0 || index(ar.to) < 0) throw new Error(`cycle arrow ${ar.from} -> ${ar.to}: no such node`);
    const { curves, begin, enter } = useMemo(() => {
      const boxes = scene.nodes.map(nd => a[nd.id]);
      const mids = boxes.map(centre);
      const middle = { x: mids.reduce((s, m) => s + m.x, 0) / mids.length, y: mids.reduce((s, m) => s + m.y, 0) / mids.length };
      const curves = scene.arrows.map(ar => (layout === 'payoff' ? feedCurve(a[ar.from], a[ar.to], u) : arrowCurve(a[ar.from], a[ar.to], middle, u)));
      // Nodes come in a moment apart, or (reveal) with the first arrow reaching them; arrows draw at their phrase, or
      // one after another once the nodes are in.
      const dealt = scene.nodes.length * 4 + 10;
      const begin: number[] = [];
      scene.arrows.forEach((ar: CycleArrow, k) => { begin.push(at(ar.at, scene.reveal ? 10 + k * 20 : dealt + k * 10)); });
      const enter = scene.nodes.map((nd, i) => {
        if (cued(nd.id) || i === 0 || !scene.reveal) return cued(nd.id) ? look(nd.id).appear : i * 4;
        const k = scene.arrows.findIndex(ar => ar.to === nd.id || (layout === 'payoff' && ar.from === nd.id));
        return k >= 0 ? begin[k] : i * 4;
      });
      return { curves, begin, enter };
    }, [scene, a, u, layout]);
    const progress = begin.map(b => interpolate(frame - b, [0, ARROW_FRAMES], [0, 1], { ...clampOpts, easing: Easing.out(Easing.quad) }));
    const flowing = scene.loop === false || !begin.length ? -1 : frame - (Math.max(...begin) + ARROW_FRAMES);
    const arrival = (i: number) => Math.max(0, ...scene.arrows.map((ar, k) => (ar.to === scene.nodes[i].id ? Math.sin(Math.PI * clamp01((frame - begin[k] - ARROW_FRAMES) / 10)) : 0)));

    return (
      <>
        <Heading text={scene.heading} props={props} />
        {curves.map(({ points: p, out }, k) => {
          const t = progress[k];
          if (t <= 0) return null;
          const len = curveLength(p);
          const d = `M ${p[0].x} ${p[0].y} C ${p[1].x} ${p[1].y} ${p[2].x} ${p[2].y} ${p[3].x} ${p[3].y}`;
          const tip = bezier(p, t), back = bezier(p, Math.max(0, t - 0.04));
          const dir = unit(tip.x - back.x, tip.y - back.y), hs = 16 * u;
          const head = `${tip.x + dir.x * hs * 0.6},${tip.y + dir.y * hs * 0.6} ${tip.x - dir.x * hs - dir.y * hs * 0.7},${tip.y - dir.y * hs + dir.x * hs * 0.7} ${tip.x - dir.x * hs + dir.y * hs * 0.7},${tip.y - dir.y * hs - dir.x * hs * 0.7}`;
          const label = scene.arrows[k].label, mid = bezier(p, 0.5);
          return (
            <div key={`arrow-${k}`}>
              <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible', opacity: fade }}>
                <g fill="none" strokeLinecap="round">
                  <path d={d} stroke="rgba(0,0,0,0.6)" strokeWidth={13 * u} strokeDasharray={`${t * len} ${len * 2}`} />
                  <path d={d} stroke={theme.accent} strokeWidth={7 * u} strokeDasharray={`${t * len} ${len * 2}`} />
                  {flowing > 0 && <path d={d} stroke="rgba(255,255,255,0.9)" strokeWidth={4 * u} strokeDasharray={`${18 * u} ${50 * u}`} strokeDashoffset={-flowing * 5 * u} />}
                </g>
                <polygon points={head} fill={theme.accent} stroke="rgba(0,0,0,0.6)" strokeWidth={2 * u} />
              </svg>
              {label && t > 0.6 && <Chip at={{ x: mid.x + out.x * 40 * u, y: mid.y + out.y * 40 * u }} text={label} size={fonts.arrow} color={theme.muted} theme={theme} opacity={fade * clamp01((t - 0.6) / 0.4)} />}
            </div>
          );
        })}
        {scene.nodes.map((nd, i) => {
          const box = a[nd.id], l = { ...look(nd.id), appear: enter[i] };
          const color = nd.sink ? theme.muted : toneColor(theme, nd.tone, STEP_COLORS[i % STEP_COLORS.length]);
          return (
            <Panel key={nd.id} box={box} look={l} color={color} theme={theme} u={u} dashed={nd.sink} extra={arrival(i)}>
              {nd.image && <Img src={srcOf(project, nd.image)} style={{ width: '100%', height: box.h * 0.58, objectFit: 'contain', marginBottom: 8 * u }} />}
              <Text size={fonts.label} color={nd.sink ? theme.muted : theme.text}>{nd.label}</Text>
              {nd.detail && <Text size={fonts.detail} color={theme.muted} weight={700}>{nd.detail}</Text>}
            </Panel>
          );
        })}
        {/* `carry`: a faded copy of the node the arrow leaves rides it into the node it reaches. */}
        {scene.arrows.map((ar, k) => {
          const t = progress[k];
          if (!ar.carry || t <= 0 || t >= 1) return null;
          const src = a[ar.from], p = bezier(curves[k].points, Easing.inOut(Easing.quad)(t)), s = lerp(0.7, scene.nodes[index(ar.to)].sink ? 0.25 : 0.5, t);
          return (
            <div key={`carry-${k}`} style={{ position: 'absolute', left: p.x - src.w / 2, top: p.y - src.h / 2, width: src.w, height: src.h, transform: `scale(${s})`, opacity: 0.7 * fade }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 22 * u, background: theme.panel, border: `${3 * u}px solid ${theme.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text size={fonts.label} color={theme.text}>{scene.nodes[index(ar.from)].label}</Text>
              </div>
            </div>
          );
        })}
      </>
    );
  },
};

// timeline: markers along an axis; each step's items show big, its marker lights, then the items shrink into it.

const timeline: SceneDef<Extract<Scene, { type: 'timeline' }>> = {
  layout: (s, _beat, { content: c, u }) => {
    const { anchors, fonts, area } = headed(s.heading, c, u, 30);
    const n = Math.max(1, s.steps.length), gap = 24 * u, markH = 84 * u;
    const axisW = c.w * 0.92, mw = Math.min(260 * u, (axisW - (n - 1) * gap) / n);
    const x0 = c.x + (c.w - (n * mw + (n - 1) * gap)) / 2, y = area.y + area.h - markH;
    s.steps.forEach((st, i) => { anchors[st.id] = { x: x0 + i * (mw + gap), y, w: mw, h: markH }; });
    fonts.marker = Math.min(...s.steps.map(st => fitFont(st.label, mw - 30 * u, markH * 0.8, 40 * u)));
    // The items' row, above the axis.
    const most = Math.max(1, ...s.steps.map(st => st.items?.length ?? 0));
    const row: Box = { x: area.x, y: area.y, w: area.w, h: y - 50 * u - area.y };
    const iw = Math.min(460 * u, (row.w - (most - 1) * 30 * u) / most), ih = Math.min(170 * u, row.h * 0.7);
    fonts.item = Math.min(...s.steps.flatMap(st => st.items ?? []).map(t => fitFont(t, iw - 48 * u, ih * 0.86, 50 * u)), 50 * u);
    fonts.note = 26 * u;
    // Item boxes per step aren't elements (the narrator points at markers); they sit in `row`, centred.
    anchors['row:' + 0] = { ...row };
    fonts.itemW = iw;
    fonts.itemH = ih;
    return { anchors, fonts };
  },
  Component: props => {
    const { scene, layout: { anchors: a, fonts }, stage: { u }, theme, look, at, fade } = props;
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const n = scene.steps.length;
    // When each step's items come (`at`), its marker lights (`light`) and the items land in it (`land`).
    const times = useMemo(() => {
      const out: Array<{ at: number; light: number; land: number | null }> = [];
      scene.steps.forEach((st, k) => {
        const prev = out[k - 1];
        const start = at(st.at, k === 0 ? 0 : (prev.land ?? prev.at) + 8);
        const next = scene.steps[k + 1];
        const land = st.land ? at(st.land, start + 45) : next ? (next.at ? at(next.at, start + 45) - 6 : start + 45) : null;
        out.push({ at: start, light: at(st.light, start), land });
      });
      return out;
    }, [scene, at]);
    const row = a['row:0'], iw = fonts.itemW, ih = fonts.itemH;
    const first = a[scene.steps[0]?.id], last = a[scene.steps[n - 1]?.id];
    return (
      <>
        <Heading text={scene.heading} props={props} />
        {first && <div style={{ position: 'absolute', left: first.x, top: first.y + first.h / 2 - 2 * u, width: last.x + last.w - first.x, height: 4 * u, background: theme.line, opacity: fade }} />}
        {scene.steps.map((st, k) => {
          const mark = a[st.id], tm = times[k], l = look(st.id);
          const lit = clamp01((frame - tm.light) / 6);
          const items = st.items ?? [];
          const rowW = items.length * iw + (items.length - 1) * 30 * u, x0 = row.x + (row.w - rowW) / 2, y0 = row.y + (row.h - ih) / 2;
          return (
            <div key={st.id}>
              {items.map((t, j) => {
                const start = tm.at + j * 4;
                if (frame < start || (tm.land !== null && frame > tm.land + ARROW_FRAMES)) return null;
                const p = spring({ frame: frame - start, fps, config: { damping: 14, stiffness: 140 } });
                const land = tm.land === null ? 0 : Easing.inOut(Easing.quad)(clamp01((frame - tm.land) / ARROW_FRAMES));
                const box = { x: x0 + j * (iw + 30 * u), y: y0, w: iw, h: ih }, target = centre(mark), from = centre(box);
                const x = lerp(from.x, target.x, land), y = lerp(from.y, target.y, land), s = lerp(0.8 + 0.2 * Math.min(1, p), 0.12, land);
                return (
                  <div
                    key={j}
                    style={{
                      position: 'absolute', left: x - iw / 2, top: y - ih / 2, width: iw, height: ih, transform: `scale(${s})`, opacity: Math.min(1, p) * fade * (1 - 0.6 * land),
                      borderRadius: 22 * u, background: theme.panel, border: `${3 * u}px solid ${theme.accent}`, padding: `0 ${24 * u}px`,
                      boxShadow: `0 ${18 * u}px ${40 * u}px rgba(0,0,0,0.45)`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Text size={fonts.item} color={theme.text}>{t}</Text>
                  </div>
                );
              })}
              <Panel box={mark} look={{ ...l, glow: Math.max(l.glow, lit) }} color={lit > 0 ? theme.accent : theme.line} theme={theme} u={u} extra={Math.sin(Math.PI * clamp01((frame - tm.light) / 10))}>
                <Text size={fonts.marker} color={lit > 0.5 ? theme.text : theme.muted}>{st.label}</Text>
              </Panel>
              {st.note && frame >= (tm.land ?? tm.light) && (
                <Chip at={{ x: mark.x + mark.w / 2, y: mark.y + mark.h + 30 * u }} text={st.note} size={fonts.note} color={theme.accent} theme={theme} opacity={fade * clamp01((frame - (tm.land ?? tm.light)) / 8)} />
              )}
            </div>
          );
        })}
      </>
    );
  },
};

// typing: a chat message or code typing itself out, from one phrase to another.

/** Lines code takes in a box `width` wide at `size` (monospace, ~0.6 em a character), keeping its own line breaks. */
const codeLines = (text: string, width: number, size: number) =>
  text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil((line.length * 0.6 * size) / width)), 0);

/** JSON-ish colouring: keys in the accent, strings in the text colour, numbers and literals in the accent, the rest muted. */
function codeTokens(text: string, theme: Theme): Array<{ text: string; color: string }> {
  const out: Array<{ text: string; color: string }> = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?|true|false|null)|([^"\d\-tfn]+|.)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) out.push({ text: m[1], color: m[2] ? theme.accent : theme.text }, ...(m[2] ? [{ text: m[2], color: theme.muted }] : []));
    else if (m[3]) out.push({ text: m[3], color: theme.accent });
    else out.push({ text: m[0], color: theme.muted });
  }
  return out;
}

const typing: SceneDef<Extract<Scene, { type: 'typing' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const w = Math.min((wide ? 1300 : 980) * u, c.w * (wide ? 0.82 : 0.98)), h = Math.min(c.h * 0.92, (wide ? 640 : 900) * u);
    const box = centered(c, w, h), bar = 76 * u, pad = 40 * u;
    const code = s.style === 'code';
    const textW = w - 2 * pad - (code ? 0 : 120 * u), textH = h - bar - 2 * pad;
    let size = Math.floor((code ? 36 : 48) * u);
    while (size > 12 && (code ? codeLines(s.text, textW, size) * size * 1.45 : textHeight(s.text, textW - 60 * u, size) + 50 * u) > textH) size--;
    return { anchors: { window: box }, fonts: { text: size } };
  },
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u }, theme, look, at }) => {
    const frame = useCurrentFrame();
    const box = a.window, l = look('window'), bar = 76 * u, pad = 40 * u;
    const code = scene.style === 'code';
    const from = at(scene.from, l.appear + 10);
    const until = Math.max(from + 1, at(scene.until, from + scene.text.length));
    const shown = Math.round(scene.text.length * clamp01((frame - from) / (until - from)));
    const typing = frame >= from && frame < until + 10;
    const cursor = typing && Math.floor(frame / 8) % 2 === 0;
    const caret = cursor ? <span style={{ display: 'inline-block', width: 0.08 * fonts.text, height: '1em', marginLeft: 2, verticalAlign: '-0.12em', background: theme.accent }} /> : null;
    const tokens = useMemo(() => (code ? codeTokens(scene.text, theme) : []), [code, scene.text, theme]);
    let left = shown;
    return (
      <El box={box} look={l}>
        {() => (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 26 * u, background: theme.panel, border: `${3 * u}px solid ${withAlpha(theme.accent, 0.35 + 0.65 * l.glow)}`, overflow: 'hidden', boxShadow: `0 ${24 * u}px ${60 * u}px rgba(0,0,0,0.55)` }}>
            {/* Title bar: window dots and the file name, or the person typing. */}
            <div style={{ height: bar, display: 'flex', alignItems: 'center', gap: 14 * u, padding: `0 ${pad}px`, borderBottom: `${2 * u}px solid ${theme.line}` }}>
              {code
                ? [0, 1, 2].map(i => <div key={i} style={{ width: 18 * u, height: 18 * u, borderRadius: '50%', background: i === 0 ? theme.accent : theme.line }} />)
                : <div style={{ width: 44 * u, height: 44 * u, borderRadius: '50%', background: theme.accent, color: theme.bg, fontFamily, fontWeight: 900, fontSize: 24 * u, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{(scene.who ?? 'You').slice(0, 1)}</div>}
              <div style={{ fontFamily: code ? monoFamily : fontFamily, fontSize: 26 * u, fontWeight: 700, color: theme.muted, marginLeft: 6 * u }}>{code ? scene.title ?? 'script.json' : scene.who ?? 'You'}</div>
            </div>
            {code ? (
              <div style={{ padding: pad, fontFamily: monoFamily, fontSize: fonts.text, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {tokens.map((t, i) => {
                  if (left <= 0) return null;
                  const part = t.text.slice(0, left);
                  left -= part.length;
                  return <span key={i} style={{ color: t.color }}>{part}</span>;
                })}
                {caret}
              </div>
            ) : (
              <div style={{ padding: pad, display: 'flex', justifyContent: 'flex-end' }}>
                {shown > 0 && (
                  <div style={{ maxWidth: '86%', padding: `${22 * u}px ${30 * u}px`, borderRadius: `${30 * u}px ${30 * u}px ${8 * u}px ${30 * u}px`, background: theme.accent, color: theme.bg, fontFamily, fontWeight: 700, fontSize: fonts.text, lineHeight: LINE, whiteSpace: 'pre-wrap' }}>
                    {scene.text.slice(0, shown)}
                    {cursor && <span style={{ display: 'inline-block', width: 0.08 * fonts.text, height: '1em', marginLeft: 2, verticalAlign: '-0.12em', background: theme.bg }} />}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </El>
    );
  },
};

// figures: key numbers counting up under an animated icon (a clock spinning to its time, dollar bills piling up).

/** The number in a value ("$3.40", "5 min") counted up from 0, keeping what's around it and its decimals. */
function countUp(value: string, t: number): string {
  const m = /^(\D*)(\d+(?:\.\d+)?)(.*)$/.exec(value);
  if (!m) return value;
  const decimals = m[2].split('.')[1]?.length ?? 0;
  return `${m[1]}${(Number(m[2]) * t).toFixed(decimals)}${m[3]}`;
}

/** A clock whose minute hand spins twice and settles a few minutes on, then ticks: a short time, passing. */
const ClockIcon: React.FC<{ size: number; start: number; theme: Theme; color: string }> = ({ size, start, theme, color }) => {
  const frame = useCurrentFrame();
  const t = frame - start;
  const spin = Easing.out(Easing.cubic)(clamp01(t / 36));
  const minute = 720 * spin + 30 * spin + (t > 36 ? Math.floor((t - 36) / 15) * 6 : 0);
  const hour = minute / 12;
  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} style={{ overflow: 'visible' }}>
      <circle r={r * 0.92} fill={theme.panel} stroke={theme.text} strokeWidth={r * 0.07} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6, long = i % 3 === 0;
        return <line key={i} x1={Math.sin(a) * r * 0.72} y1={-Math.cos(a) * r * 0.72} x2={Math.sin(a) * r * (long ? 0.56 : 0.64)} y2={-Math.cos(a) * r * (long ? 0.56 : 0.64)} stroke={theme.muted} strokeWidth={r * (long ? 0.06 : 0.035)} strokeLinecap="round" />;
      })}
      {/* The few minutes it took, shaded. */}
      {spin > 0.95 && <path d={`M 0 0 L 0 ${-r * 0.5} A ${r * 0.5} ${r * 0.5} 0 0 1 ${Math.sin(Math.PI / 6) * r * 0.5} ${-Math.cos(Math.PI / 6) * r * 0.5} Z`} fill={withAlpha(color, 0.45)} />}
      <line x1={0} y1={0} x2={0} y2={-r * 0.38} stroke={theme.text} strokeWidth={r * 0.09} strokeLinecap="round" transform={`rotate(${hour})`} />
      <line x1={0} y1={0} x2={0} y2={-r * 0.62} stroke={color} strokeWidth={r * 0.06} strokeLinecap="round" transform={`rotate(${minute})`} />
      <circle r={r * 0.07} fill={color} />
    </svg>
  );
};

/** Dollar bills dropping in one after another and settling into a pile. */
const MoneyIcon: React.FC<{ size: number; start: number; theme: Theme; color: string }> = ({ size, start, theme, color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bills = 6, bw = size * 0.9, bh = bw * 0.46;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      {Array.from({ length: bills }, (_, i) => {
        const t = frame - start - i * 5;
        if (t < 0) return null;
        const p = spring({ frame: t, fps, config: { damping: 13, stiffness: 120, mass: 0.8 } });
        const restY = size - bh - i * size * 0.07, restAngle = ((i * 37) % 13) - 6;
        const y = lerp(-size * 0.9, restY, p), angle = lerp(restAngle + 40 * (i % 2 ? 1 : -1), restAngle, p);
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: (size - bw) / 2 + ((i * 23) % 9) - 4, top: y, width: bw, height: bh, transform: `rotate(${angle}deg)`,
              borderRadius: bh * 0.08, background: theme.text, border: `${Math.max(2, bh * 0.05)}px solid ${color}`, boxShadow: `0 ${bh * 0.08}px ${bh * 0.2}px rgba(0,0,0,0.45)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: Math.min(1, p * 2),
            }}
          >
            <div style={{ position: 'absolute', inset: bh * 0.1, border: `${Math.max(1, bh * 0.025)}px solid ${withAlpha(color, 0.6)}`, borderRadius: bh * 0.05 }} />
            <div style={{ width: bh * 0.62, height: bh * 0.62, borderRadius: '50%', background: color, color: theme.text, fontFamily, fontWeight: 900, fontSize: bh * 0.45, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>$</div>
          </div>
        );
      })}
    </div>
  );
};

const figures: SceneDef<Extract<Scene, { type: 'figures' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const { anchors, fonts, area } = headed(s.heading, c, u, 30);
    const n = Math.max(1, s.items.length), gap = 60 * u;
    const row = wide || n === 1;
    const w = row ? Math.min(560 * u, (area.w - (n - 1) * gap) / n) : Math.min(700 * u, area.w * 0.9);
    const h = row ? area.h : (area.h - (n - 1) * gap) / n;
    const block = centered(area, row ? n * w + (n - 1) * gap : w, row ? h : n * h + (n - 1) * gap);
    s.items.forEach((it, i) => { anchors[it.id] = row ? { x: block.x + i * (w + gap), y: block.y, w, h } : { x: block.x, y: block.y + i * (h + gap), w, h }; });
    fonts.icon = Math.min(w * 0.6, h * 0.48);
    fonts.value = Math.min(...s.items.map(it => fitFont(it.value, w * 0.95, h * 0.24, 120 * u)));
    fonts.label = Math.min(...s.items.map(it => fitFont(it.label ?? '', w * 0.95, h * 0.16, 40 * u)));
    return { anchors, fonts };
  },
  Component: props => {
    const { scene, layout: { anchors: a, fonts }, theme, look } = props;
    const frame = useCurrentFrame();
    return (
      <>
        <Heading text={scene.heading} props={props} />
        {scene.items.map(it => {
          const l = look(it.id), color = toneColor(theme, it.tone, theme.accent);
          const count = Easing.out(Easing.cubic)(clamp01((frame - l.appear - 6) / 24));
          return (
            <El key={it.id} box={a[it.id]} look={l}>
              {() => (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: fonts.icon * 0.08 }}>
                  <div style={{ width: fonts.icon, height: fonts.icon, filter: l.glow ? `drop-shadow(0 0 ${24 * l.glow}px ${withAlpha(color, 0.7)})` : undefined }}>
                    {it.icon === 'clock' && <ClockIcon size={fonts.icon} start={l.appear} theme={theme} color={color} />}
                    {it.icon === 'money' && <MoneyIcon size={fonts.icon} start={l.appear} theme={theme} color={color} />}
                  </div>
                  <Text size={fonts.value} color={color} weight={900}>{countUp(it.value, count)}</Text>
                  {it.label && <Text size={fonts.label} color={theme.muted} weight={700}>{it.label}</Text>}
                </div>
              )}
            </El>
          );
        })}
      </>
    );
  },
};

// road: a motorbike and its rider on a road, side on, the camera following; the scene's moves switch what they do.

type RoadScene = Extract<Scene, { type: 'road' }>;
type Move = RoadMove['move'];

/** Speeds in bike units a second (the drawing's own units: the wheelbase is 124). */
const RIDE = 650, PUSH = 40, LAUNCH = 1300, CAMERA = 450;
/** How long a wheelie, a stall, getting off and getting back on take, in seconds; one step of pushing, in units. */
const WHEELIE_S = 1.5, STALL_S = 1.6, OFF_S = 0.8, ON_S = 0.5, STEP = 50;

/** Pixels per bike unit, and where the ground, the road and the bike sit, for a stage. */
function roadGeometry({ w, u, wide, content: c }: Stage) {
  const k = 2.8 * u, ground = c.y + c.h * 0.86;
  return { k, u, ground, bikeX: (wide ? 0.4 : 0.47) * w, horizon: ground - 250 * u, roadTop: ground - 60 * u, roadBottom: ground + 70 * u };
}

/** A number 0-1 from an integer seed, the same every time. */
const hash = (i: number) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
function mixHex(a: string, b: string, t: number) {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map(i => Math.round(lerp(ch(a, i), ch(b, i), clamp01(t))).toString(16).padStart(2, '0')).join('')}`;
}
const smooth = (x: number) => Easing.inOut(Easing.cubic)(clamp01(x));

/** The moves, in order, with the frame each starts on (ride from the start unless one without `at` says otherwise). */
function roadMoves(s: RoadScene, at: SceneProps['at']) {
  const moves: Array<{ move: Move; frame: number }> = [{ move: 'ride', frame: 0 }];
  for (const m of s.moves ?? []) moves.push({ move: m.move, frame: m.at ? at(m.at, 0) : 0 });
  return moves.sort((a, b) => a.frame - b.frame);
}

/**
 * Where the ride is on `frame`, stepped frame by frame from the start: distance travelled and the camera's (in units),
 * speed, the clouds' drift, how grey the landscape is, the rain cloud, and the steps taken pushing.
 */
function rideAt(moves: Array<{ move: Move; frame: number }>, frame: number, fps: number) {
  const dt = 1 / fps;
  let k = -1, x = 0, cam = 0, v = 0, vcam = 0, drift = 0, grey = 0, rain = 0, v0 = 0, x0 = 0;
  const xs: number[] = [];
  const startMove = moves.findLast(m => m.frame <= 0)?.move ?? 'ride';
  if (startMove === 'ride' || startMove === 'wheelie') v = RIDE;
  if (startMove === 'stall' || startMove === 'push') grey = 1;
  for (let f = 0; f <= frame; f++) {
    while (k + 1 < moves.length && moves[k + 1].frame <= f) { k++; v0 = v; x0 = x; }
    const m = moves[k].move, t = (f - moves[k].frame) / fps;
    const steps = (x - x0) / STEP;
    v = m === 'ride' ? RIDE + (v0 - RIDE) * Math.exp(-3 * t)
      : m === 'wheelie' ? RIDE + (v0 - RIDE) * Math.exp(-3 * t) + 0.15 * RIDE * Math.sin(Math.PI * clamp01(t / WHEELIE_S))
      : m === 'stall' ? v0 * (1 - clamp01(t / STALL_S)) ** 2
      : m === 'push' ? (t < OFF_S ? v0 * Math.exp(-8 * t) : PUSH * clamp01((t - OFF_S) / 0.5) * (0.5 + Math.sin(Math.PI * steps) ** 2))
      : t < ON_S ? v0 * Math.exp(-8 * t) : LAUNCH * (1 - Math.exp(-1.8 * (t - ON_S)));
    // The camera follows the bike, except when it launches: then it falls behind and comes to rest (and catches up if
    // the bike rides on).
    const launched = m === 'launch' && t >= ON_S, behind = x - cam;
    x += v * dt;
    vcam = launched ? Math.min(v, CAMERA * Math.exp(-Math.max(0, t - ON_S - 1.2) * 2)) : v;
    cam = launched ? cam + vcam * dt : x - behind * Math.exp(-3 * dt);
    // Pushing is a time-lapse: the clouds race.
    drift += (m === 'push' && t > OFF_S ? 900 : 25) * dt;
    const greyTo = m === 'stall' || m === 'push' || (m === 'launch' && t < ON_S) ? 1 : 0;
    grey += (greyTo - grey) * (1 - Math.exp(-(greyTo ? 2.5 : 5) * dt));
    const rainTo = m === 'push' && t > 0.6 * OFF_S ? 1 : 0;
    rain += (rainTo - rain) * (1 - Math.exp(-(rainTo ? 4 : 8) * dt));
    xs.push(x);
  }
  const cur = moves[Math.max(0, k)];
  return {
    move: cur.move, t: (frame - cur.frame) / fps, start: cur.frame, prev: moves[k - 1]?.move ?? null,
    x, cam, v, vcam, drift, grey, rain, steps: (x - x0) / STEP, xs,
  };
}

type RideState = ReturnType<typeof rideAt>;
type P = [number, number];

/** The rider's joints in bike units (y up is negative): sitting tucked in, slumped, and standing beside the bike. */
const SEATED = { hip: [-24, -106] as P, shoulder: [14, -146] as P, head: [32, -161] as P, feet: [[-12, -50], [-10, -52]] as P[], look: 0 };
const SLUMPED = { hip: [-24, -104] as P, shoulder: [2, -150] as P, head: [16, -160] as P, look: 32 };
const STANDING = { hip: [-4, -80] as P, shoulder: [14, -124] as P, head: [27, -140] as P, look: 22 };
const GRIP: P = [38, -97];
const THIGH = 44, SHIN = 44, UPPER_ARM = 30, FOREARM = 30;

const mix = (a: P, b: P, t: number): P => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/** The middle joint of a limb from a to b (knee, elbow), bent to one side. */
function joint(a: P, b: P, l1: number, l2: number, bend: 1 | -1): P {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(l1 - l2) + 0.01), l1 + l2 - 0.01);
  const cos = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const angle = Math.atan2(dy, dx) + bend * Math.acos(cos);
  return [a[0] + l1 * Math.cos(angle), a[1] + l1 * Math.sin(angle)];
}

/** The rider on this frame: how far off the bike (0 seated, 1 standing), slumped, and the pushing steps' feet. */
function riderPose(st: RideState) {
  const { move: m, t } = st;
  const back = m === 'launch' && st.prev === 'push';
  const stand = m === 'push' ? smooth(t / OFF_S) : back ? 1 - smooth(t / ON_S) : 0;
  const slump = m === 'stall' ? smooth((t - 0.4) / 0.8) : m === 'push' ? 1 : back ? 1 - smooth(t / ON_S) : 0;
  const sit = { hip: mix(SEATED.hip, SLUMPED.hip, slump), shoulder: mix(SEATED.shoulder, SLUMPED.shoulder, slump), head: mix(SEATED.head, SLUMPED.head, slump) };
  // Walking: each foot planted for 60% of a two-step cycle (sliding back exactly as fast as the ground goes by), then swung forward.
  const walking = m === 'push' ? st.steps : 0;
  const bob = 3 * Math.abs(Math.sin(Math.PI * walking));
  const standHip: P = [STANDING.hip[0], STANDING.hip[1] + bob];
  const foot = (offset: number): P => {
    const c = (((walking / 2 + offset) % 1) + 1) % 1;
    if (c < 0.6) return [standHip[0] + 30 - 60 * (c / 0.6), 6];
    const s = (c - 0.6) / 0.4;
    return [standHip[0] - 30 + 60 * s, 6 - 14 * Math.sin(Math.PI * s)];
  };
  // Swinging a leg over the seat lifts the body a little.
  const lift = 14 * Math.sin(Math.PI * stand);
  const up = (p: P): P => [p[0], p[1] - lift];
  return {
    stand,
    hip: up(mix(sit.hip, standHip, stand)),
    shoulder: up(mix(sit.shoulder, [STANDING.shoulder[0], STANDING.shoulder[1] + bob], stand)),
    head: up(mix(sit.head, [STANDING.head[0], STANDING.head[1] + bob], stand)),
    feet: [mix(SEATED.feet[0], foot(0), stand), mix(SEATED.feet[1], foot(0.5), stand)],
    look: lerp(lerp(SEATED.look, SLUMPED.look, slump), STANDING.look, stand),
  };
}

/** The bike's tilt in degrees (nose up is negative) about the rear axle. */
function bikeTilt({ move: m, t }: RideState) {
  if (m === 'ride') return 0.8 * Math.sin(t * 6);
  if (m === 'wheelie') return -24 * Math.sin(Math.PI * clamp01(t / WHEELIE_S)) ** 0.7;
  if (m === 'stall') return 2.5 * Math.sin(t * 38) * Math.exp(-t * 2.2);
  if (m === 'launch') return t < ON_S ? 0 : -27 * Easing.out(Easing.cubic)(clamp01((t - ON_S) / 0.35));
  return 0;
}

const REAR: P = [-60, -30], FRONT: P = [64, -30], WHEEL = 30, EXHAUST: P = [-82, -60];
const SUIT = '#262833', SUIT_FAR = '#16171d', BLACK = '#121317', HELMET = '#f3f4f7', VISOR = '#1d2633', SCARF = '#ffd84d';

const Wheel: React.FC<{ at: P; turn: number; blur: number; color: string }> = ({ at, turn, blur, color }) => (
  <g transform={`translate(${at[0]} ${at[1]})`}>
    <circle r={WHEEL} fill="#1b1c21" />
    <circle r={WHEEL - 8} fill="none" stroke={color} strokeWidth={3} />
    <g transform={`rotate(${turn})`} opacity={1 - blur}>
      {[0, 72, 144, 216, 288].map(a => <line key={a} x1={0} y1={-5} x2={0} y2={-(WHEEL - 9)} stroke={color} strokeWidth={3.2} strokeLinecap="round" transform={`rotate(${a})`} />)}
    </g>
    {blur > 0 && <circle r={WHEEL - 15} fill="none" stroke={color} strokeWidth={10} opacity={0.35 * blur} />}
    <circle r={13} fill="none" stroke="#b9bcc4" strokeWidth={2.5} />
    <circle r={5} fill="#c9ccd3" />
  </g>
);

const Bike: React.FC<{ color: string; label?: string; turn: number; blur: number; lit: number }> = ({ color, label, turn, blur, lit }) => (
  <g>
    <line x1={REAR[0]} y1={REAR[1]} x2={-14} y2={-48} stroke="#2b2e36" strokeWidth={8} strokeLinecap="round" />
    <Wheel at={REAR} turn={turn} blur={blur} color={color} />
    <line x1={FRONT[0]} y1={FRONT[1]} x2={46} y2={-94} stroke="#d4a64a" strokeWidth={6} strokeLinecap="round" />
    <Wheel at={FRONT} turn={turn} blur={blur} color={color} />
    <rect x={-18} y={-76} width={44} height={38} rx={6} fill="#3a3d47" />
    {[0, 1, 2, 3].map(i => <line key={i} x1={-12 + i * 10} y1={-70} x2={-12 + i * 10} y2={-44} stroke="#50545f" strokeWidth={3} />)}
    <path d="M 8 -40 Q -10 -36 -30 -46 L -78 -66 L -84 -56 L -36 -38 Q -8 -28 12 -34 Z" fill="#9aa0ab" />
    <path d="M 82 -58 L 70 -84 L 54 -98 L 30 -96 Q 14 -112 -2 -104 L -22 -98 L -50 -100 L -86 -114 L -84 -106 L -54 -88 L -24 -80 L -18 -60 Q 10 -34 40 -40 L 66 -48 Z" fill={color} />
    <path d="M 70 -62 L 40 -70 L -10 -66 L -16 -58 Q 10 -38 40 -42 L 66 -50 Z" fill={mixHex(color, '#000000', 0.32)} />
    <path d="M -22 -100 L -50 -102 L -54 -95 L -22 -94 Z" fill="#1b1c21" />
    <path d="M 54 -98 L 44 -120 L 34 -114 L 40 -97 Z" fill="#9fc6e8" opacity={0.75} />
    <path d="M 78 -66 L 72 -80 L 65 -76 L 71 -62 Z" fill="#fff7cc" />
    {lit > 0 && <path d="M 80 -72 L 200 -100 L 200 -40 Z" fill="#fff7cc" opacity={0.12 * lit} />}
    <rect x={-88} y={-114} width={8} height={5} rx={2} fill="#ff4b4b" />
    <line x1={46} y1={-94} x2={36} y2={-98} stroke="#2b2e36" strokeWidth={5} strokeLinecap="round" />
    {label && <text x={22} y={-62} textAnchor="middle" fontFamily={fontFamily} fontWeight={900} fontSize={12} fill="#ffffff" transform="skewX(-14)" letterSpacing={0.5}>{label.toUpperCase()}</text>}
  </g>
);

/** One leg or arm: two segments and a boot or glove. */
const Limb: React.FC<{ from: P; to: P; l1: number; l2: number; bend: 1 | -1; width: number; color: string; end: 'boot' | 'glove' }> = ({ from, to, l1, l2, bend, width, color, end }) => {
  const mid = joint(from, to, l1, l2, bend);
  // Where the limb really ends (a target out of reach is clamped).
  const d = Math.hypot(to[0] - mid[0], to[1] - mid[1]) || 1;
  const tip: P = [mid[0] + ((to[0] - mid[0]) * l2) / d, mid[1] + ((to[1] - mid[1]) * l2) / d];
  return (
    <g>
      <path d={`M ${from[0]} ${from[1]} L ${mid[0]} ${mid[1]} L ${tip[0]} ${tip[1]}`} stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {end === 'boot' ? <rect x={tip[0] - 7} y={tip[1] - 7} width={22} height={11} rx={4} fill={BLACK} /> : <circle cx={tip[0]} cy={tip[1]} r={6.5} fill={BLACK} />}
    </g>
  );
};

/** The rider's far side (drawn behind the bike while seated) or near side: scarf, leg, body, helmet and arm. */
const Rider: React.FC<{ pose: ReturnType<typeof riderPose>; accent: string; part: 'far' | 'near'; scarf: number; frame: number }> = ({ pose, accent, part, scarf, frame }) => {
  const { hip, shoulder, head, feet, look } = pose;
  if (part === 'far') {
    return (
      <g>
        <Limb from={hip} to={feet[1]} l1={THIGH} l2={SHIN} bend={-1} width={15} color={SUIT_FAR} end="boot" />
        <Limb from={shoulder} to={[GRIP[0] + 3, GRIP[1] - 2]} l1={UPPER_ARM} l2={FOREARM} bend={1} width={11} color={SUIT_FAR} end="glove" />
      </g>
    );
  }
  // The scarf streams back with speed and hangs when still.
  const neck: P = [head[0] - 12, head[1] + 12];
  const scarfPoints = Array.from({ length: 7 }, (_, i): P => {
    const wave = Math.sin(frame * 0.7 - i * 0.9) * (1 + i * 0.6);
    return [neck[0] - i * (2 + 7 * scarf), neck[1] + i * 6 * (1 - scarf) + wave * (0.4 + scarf)];
  });
  return (
    <g>
      <path d={`M ${scarfPoints.map(p => p.join(' ')).join(' L ')}`} stroke={SCARF} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Limb from={hip} to={feet[0]} l1={THIGH} l2={SHIN} bend={-1} width={16} color={SUIT} end="boot" />
      <line x1={hip[0]} y1={hip[1]} x2={shoulder[0]} y2={shoulder[1]} stroke={SUIT} strokeWidth={30} strokeLinecap="round" />
      <line x1={lerp(hip[0], shoulder[0], 0.15)} y1={lerp(hip[1], shoulder[1], 0.15) - 6} x2={lerp(hip[0], shoulder[0], 0.85)} y2={lerp(hip[1], shoulder[1], 0.85) - 6} stroke={accent} strokeWidth={4} strokeLinecap="round" />
      <g transform={`translate(${head[0]} ${head[1]}) rotate(${look})`}>
        <circle r={18} fill={HELMET} />
        <path d="M 3 -7 Q 16 -9 18.5 2 L 16 8 Q 7 6 3 2 Z" fill={VISOR} />
        <path d="M -15 -9 A 17 17 0 0 1 9 -16" stroke={accent} strokeWidth={4} fill="none" strokeLinecap="round" />
      </g>
      <Limb from={shoulder} to={GRIP} l1={UPPER_ARM} l2={FOREARM} bend={1} width={12} color={SUIT} end="glove" />
    </g>
  );
};

/** The landscape behind the road and the road itself, scrolled by the camera (`cam`, in pixels) at each layer's depth. */
const Landscape: React.FC<{ g: ReturnType<typeof roadGeometry>; w: number; h: number; cam: number; drift: number; grey: number }> = ({ g, w, h, cam, drift, grey }) => {
  const { u, ground, horizon, roadTop, roadBottom } = g;
  /** Indices of things spaced `gap` apart at depth `depth` that are on screen (with a margin), and the layer's offset. */
  const span = (gap: number, depth: number, margin: number) => {
    const off = cam * depth, from = Math.floor((off - margin) / gap), to = Math.ceil((off + w + margin) / gap);
    return { off, ids: Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i) };
  };
  const peaks = (gap: number, depth: number, low: number, high: number, seed: number) => {
    const { off, ids } = span(gap, depth, gap);
    const pts = ids.flatMap(i => [
      `${i * gap - off},${horizon - (low + (high - low) * hash(i + seed)) * u}`,
      `${(i + 0.5) * gap - off},${horizon - low * 0.45 * u}`,
    ]);
    return `M ${-gap} ${roadTop} L ${pts.join(' L ')} L ${w + gap} ${roadTop} Z`;
  };
  const hills = (depth: number, base: number, amp: number, seed: number) => {
    const off = cam * depth, pts: string[] = [];
    for (let x = -20; x <= w + 20; x += 20 * u) {
      const X = (x + off) / u;
      pts.push(`${x},${horizon + base * u - (amp * (0.6 + 0.4 * Math.sin(X / 230 + seed)) + 0.35 * amp * Math.sin(X / 97 + 2 * seed)) * u}`);
    }
    return `M -20 ${roadTop} L ${pts.join(' L ')} L ${w + 20} ${roadTop} Z`;
  };
  const trees = span(420 * u, 0.7, 300 * u), rails = span(160 * u, 1, 40 * u), dashes = span(320 * u, 1, 200 * u);
  const curb = span(130 * u, 1, 140 * u), tufts = span(330 * u, 1.25, 100 * u), clouds = span(520 * u, 0.04, 400 * u);
  const cloudOff = drift * g.k, wrap = w + 800 * u;
  const sun = { x: 0.8 * w, y: 0.45 * horizon };
  return (
    <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, filter: `saturate(${1 - 0.8 * grey}) brightness(${1 - 0.2 * grey})` }}>
      <defs>
        <linearGradient id="road-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={mixHex('#3d9cff', '#6b7380', grey)} />
          <stop offset="0.6" stopColor={mixHex('#8fd0ff', '#9aa1ad', grey)} />
          <stop offset="1" stopColor={mixHex('#ffe3b3', '#c4c7cc', grey)} />
        </linearGradient>
        <linearGradient id="road-grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a9a52" />
          <stop offset="0.5" stopColor="#2f6b37" />
          <stop offset="1" stopColor="#1c4223" />
        </linearGradient>
      </defs>
      <rect width={w} height={roadTop + 10} fill="url(#road-sky)" />
      <circle cx={sun.x} cy={sun.y} r={110 * u} fill="#fff3c4" opacity={0.25 * (1 - grey)} />
      <circle cx={sun.x} cy={sun.y} r={70 * u} fill="#fff3c4" opacity={1 - 0.85 * grey} />
      {clouds.ids.map(i => {
        const x = ((((i * 520 * u + hash(i) * 200 * u - clouds.off - cloudOff) % wrap) + wrap) % wrap) - 400 * u;
        const y = (0.12 + 0.3 * hash(i + 7)) * horizon, s = (0.7 + 0.6 * hash(i + 3)) * u;
        return (
          <g key={i} transform={`translate(${x} ${y}) scale(${s})`} opacity={0.9}>
            <ellipse cx={0} cy={0} rx={90} ry={34} fill="#ffffff" />
            <circle cx={-30} cy={-18} r={34} fill="#ffffff" />
            <circle cx={22} cy={-26} r={42} fill="#ffffff" />
          </g>
        );
      })}
      <path d={peaks(260 * u, 0.05, 180, 380, 11)} fill="#a3b0ea" />
      <path d={peaks(200 * u, 0.12, 120, 260, 31)} fill="#7f90d8" />
      <path d={hills(0.3, -10, 70, 1)} fill="#77c77a" />
      <path d={hills(0.45, 60, 60, 4)} fill="#5bb262" />
      {trees.ids.filter(i => hash(i + 5) > 0.25).map(i => {
        const x = i * 420 * u + hash(i) * 160 * u - trees.off, s = (0.8 + 0.5 * hash(i + 9)) * u;
        return (
          <g key={i} transform={`translate(${x} ${roadTop - 6 * u}) scale(${s})`}>
            <rect x={-9} y={-90} width={18} height={92} fill="#6b4a2f" />
            <circle cx={0} cy={-120} r={58} fill="#3e9a4b" />
            <circle cx={-34} cy={-92} r={36} fill="#45a653" />
            <circle cx={30} cy={-96} r={40} fill="#368c43" />
          </g>
        );
      })}
      <line x1={0} y1={roadTop - 20 * u} x2={w} y2={roadTop - 20 * u} stroke="#c9ccd3" strokeWidth={7 * u} />
      {rails.ids.map(i => <rect key={i} x={i * 160 * u - rails.off} y={roadTop - 26 * u} width={8 * u} height={30 * u} fill="#8d929c" />)}
      <rect y={roadTop} width={w} height={roadBottom - roadTop} fill="#4b4f5c" />
      <rect y={roadTop} width={w} height={6 * u} fill="#5f6372" />
      {dashes.ids.map(i => <rect key={i} x={i * 320 * u - dashes.off} y={ground + 18 * u} width={140 * u} height={10 * u} rx={4 * u} fill="#f2f2f2" />)}
      {curb.ids.map(i => <rect key={i} x={i * 130 * u - curb.off} y={roadBottom} width={130 * u} height={20 * u} fill={i % 2 ? '#ffffff' : '#e23d3d'} />)}
      <rect y={roadBottom + 20 * u} width={w} height={Math.max(0, h - roadBottom - 20 * u)} fill="url(#road-grass)" />
      {tufts.ids.map(i => {
        const x = i * 330 * u + hash(i + 2) * 200 * u - tufts.off, y = roadBottom + (60 + 160 * hash(i + 4)) * u;
        return <path key={i} d={`M ${x - 18 * u} ${y} L ${x - 8 * u} ${y - 30 * u} L ${x} ${y} L ${x + 8 * u} ${y - 36 * u} L ${x + 18 * u} ${y} Z`} fill="#5cb565" />;
      })}
    </svg>
  );
};

/** "4.0 m" or "10:00" (minutes and seconds) counted up from 0. */
function countValue(value: string, t: number): string {
  const clock = /^(\d+):(\d{2})$/.exec(value);
  if (!clock) return countUp(value, clamp01(t));
  const s = Math.floor((Number(clock[1]) * 60 + Number(clock[2])) * clamp01(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const road: SceneDef<RoadScene> = {
  layout: (s, _beat, stage) => {
    const { content: c, u, wide } = stage;
    const { anchors, fonts, area } = headed(s.heading, c, u, 50, 70);
    const { k, ground, bikeX } = roadGeometry(stage);
    anchors.rider = { x: bikeX - 90 * k, y: ground - 180 * k, w: 190 * k, h: 180 * k };
    const rs = s.readouts ?? [];
    if (rs.length) {
      // A row under the heading (where alerts come down), or a column at the right in landscape.
      const gap = 30 * u, rh = 180 * u;
      const rw = wide ? 380 * u : Math.min(340 * u, (c.w * 0.9 - (rs.length - 1) * gap) / rs.length);
      rs.forEach((r, i) => {
        anchors[r.id] = wide
          ? { x: c.x + c.w - rw, y: area.y + i * (rh + gap), w: rw, h: rh }
          : { x: c.x + (c.w - (rs.length * rw + (rs.length - 1) * gap)) / 2 + i * (rw + gap), y: area.y, w: rw, h: rh };
      });
      fonts.value = Math.min(...rs.map(r => fitFont(r.value, rw * 0.88, rh * 0.5, 84 * u)));
      fonts.label = Math.min(...rs.map(r => fitFont(r.label ?? '', rw * 0.88, rh * 0.22, 32 * u)));
    }
    return { anchors, fonts };
  },
  Component: props => {
    const { scene, layout: { anchors: a, fonts }, stage, theme, look, at, fade } = props;
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const g = roadGeometry(stage), { k, u } = g;
    const moves = roadMoves(scene, at);
    const st = rideAt(moves, frame, fps);
    const pose = riderPose(st);
    const tilt = bikeTilt(st);
    const engine = st.move === 'ride' || st.move === 'wheelie' || (st.move === 'launch' && st.t >= ON_S);
    const speed = clamp01(st.vcam / RIDE);
    const bob = engine ? 1.2 * Math.sin(frame * 1.7) * Math.min(1, st.v / RIDE) : 0;
    const bx = g.bikeX + (st.x - st.cam) * k;
    const screen = (p: P): Point => {
      const r = (tilt * Math.PI) / 180, dx = p[0] - REAR[0], dy = p[1] - REAR[1];
      return { x: bx + (REAR[0] + dx * Math.cos(r) - dy * Math.sin(r)) * k, y: g.ground + (REAR[1] + dx * Math.sin(r) + dy * Math.cos(r) + bob) * k };
    };
    const worldX = (x: number) => g.bikeX + (x - st.cam) * k;
    const puffs: Array<{ x: number; y: number; r: number; color: string; opacity: number }> = [];
    if (st.move === 'stall') {
      // Three dark coughs from the exhaust, left behind as the bike rolls on.
      for (const s of [0.15, 0.5, 0.85]) {
        const e = st.start + Math.round(s * fps), age = (frame - e) / (0.9 * fps);
        if (age < 0 || age >= 1) continue;
        puffs.push({ x: worldX(st.xs[e] + EXHAUST[0]) - age * 20 * k, y: screen(EXHAUST).y - age * 30 * k, r: (8 + 26 * age) * k, color: '#4a4e58', opacity: 0.85 * (1 - age) });
      }
    }
    if (st.move === 'launch') {
      // Dust kicked up behind the back wheel.
      const from = st.start + Math.round(ON_S * fps);
      for (let e = from; e <= frame && e < from + Math.round(0.7 * fps); e += 2) {
        const age = (frame - e) / (0.9 * fps);
        if (age >= 1) continue;
        puffs.push({ x: worldX(st.xs[e] + REAR[0] - 20) - age * 30 * k, y: g.ground - (8 + 22 * age) * k, r: (10 + 40 * age) * k, color: '#d8c4a2', opacity: 0.7 * (1 - age) });
      }
    }
    const head = screen(pose.head);
    const readoutEnd = (appear: number) => moves.find(m => m.frame > appear)?.frame ?? appear + 3 * fps;
    return (
      <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
        <Landscape g={g} w={stage.w} h={stage.h} cam={st.cam * k} drift={st.drift} grey={st.grey} />
        <svg width={stage.w} height={stage.h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          {/* Speed lines streaking past. */}
          {speed > 0.05 && Array.from({ length: 9 }, (_, i) => {
            const len = (180 + 200 * hash(i + 21)) * u * speed, wrap = stage.w + 600 * u;
            const x = ((((hash(i + 40) * wrap - st.cam * k * 1.6) % wrap) + wrap) % wrap) - 300 * u;
            const y = lerp(g.horizon * 0.35, g.ground - 20 * u, hash(i + 60));
            return <line key={i} x1={x} y1={y} x2={x + len} y2={y} stroke="#ffffff" strokeWidth={5 * u} strokeLinecap="round" opacity={0.5 * speed} />;
          })}
          {puffs.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={p.color} opacity={p.opacity} />)}
          <g transform={`translate(${bx} ${g.ground + bob * k}) scale(${k}) rotate(${tilt} ${REAR[0]} ${REAR[1]})`}>
            <ellipse cx={2} cy={2} rx={100} ry={7} fill="#000000" opacity={0.25} transform={`rotate(${-tilt} ${REAR[0]} ${REAR[1]})`} />
            {pose.stand < 0.5 && <Rider pose={pose} accent={theme.accent} part="far" scarf={speed} frame={frame} />}
            {/* Exhaust: a light trail while the engine runs. */}
            {engine && [0, 1, 2, 3, 4].map(j => {
              const age = ((frame + j * 4) % 20) / 20;
              return <circle key={j} cx={EXHAUST[0] - age * 50} cy={EXHAUST[1] - age * 8} r={4 + 10 * age} fill="#c9ccd3" opacity={0.35 * (1 - age)} />;
            })}
            <Bike color={theme.accent} label={scene.label} turn={(st.x / WHEEL) * (180 / Math.PI)} blur={clamp01((st.v / RIDE - 0.2) * 1.5)} lit={engine ? 1 : 0} />
            {pose.stand >= 0.5 && <Rider pose={pose} accent={theme.accent} part="far" scarf={speed} frame={frame} />}
            <Rider pose={pose} accent={theme.accent} part="near" scarf={clamp01(st.v / RIDE)} frame={frame} />
            {/* Sweat flying off while pushing. */}
            {st.move === 'push' && st.t > OFF_S && [0, 1].map(j => {
              const age = ((frame + j * 11) % 22) / 22;
              const x = pose.head[0] - 10 - age * 26 * (j ? 0.6 : 1), y = pose.head[1] - 16 - age * 22 + age * age * 40;
              return <path key={j} d={`M ${x} ${y - 5} Q ${x + 4} ${y + 1} ${x} ${y + 4} Q ${x - 4} ${y + 1} ${x} ${y - 5} Z`} fill="#a9dcff" opacity={1 - age} />;
            })}
          </g>
          {/* A rain cloud of his own while he pushes. */}
          {st.rain > 0.01 && (
            <g opacity={st.rain} transform={`translate(${head.x} ${head.y - 85 * k})`}>
              {Array.from({ length: 12 }, (_, i) => {
                const x = (-42 + ((i * 31) % 84)) * k, fall = ((frame * 4 + i * 23) % 60) * k;
                return <line key={i} x1={x} y1={14 * k + fall} x2={x - 2 * k} y2={22 * k + fall} stroke="#9fc3ff" strokeWidth={3 * u} strokeLinecap="round" opacity={1 - fall / (60 * k)} />;
              })}
              <ellipse cx={0} cy={6 * k} rx={56 * k} ry={14 * k} fill="#6c717d" />
              <circle cx={-26 * k} cy={-4 * k} r={20 * k} fill="#7d8391" />
              <circle cx={4 * k} cy={-12 * k} r={26 * k} fill="#868c99" />
              <circle cx={32 * k} cy={-2 * k} r={18 * k} fill="#7d8391" />
            </g>
          )}
        </svg>
        {scene.heading && (
          <El box={a.heading} look={look('heading')} rise>
            {() => (
              <div style={{ position: 'absolute', inset: `${-14 * u}px ${-26 * u}px`, borderRadius: 20 * u, background: theme.text, boxShadow: `0 ${12 * u}px ${30 * u}px rgba(0,0,0,0.35)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text size={fonts.heading} color={theme.bg} weight={900}>{scene.heading}</Text>
              </div>
            )}
          </El>
        )}
        {(scene.readouts ?? []).map(r => {
          const l = look(r.id), end = readoutEnd(l.appear);
          const gone = clamp01((frame - end) / 8);
          if (gone >= 1) return null;
          return (
            <div key={r.id} style={{ opacity: 1 - gone }}>
              <Panel box={a[r.id]} look={l} color={theme.accent} theme={theme} u={u}>
                <div style={{ fontFamily, fontWeight: 900, fontSize: fonts.value, color: theme.accent, lineHeight: LINE, fontVariantNumeric: 'tabular-nums' }}>
                  {countValue(r.value, (frame - l.appear) / Math.max(1, end - l.appear))}
                </div>
                {r.label && <div style={{ fontFamily, fontWeight: 700, fontSize: fonts.label, color: theme.muted, lineHeight: LINE }}>{r.label}</div>}
              </Panel>
            </div>
          );
        })}
      </div>
    );
  },
};

/** Alerts (cue `alert`): a phone notification dropping in at `top`, and up and away at its end. */
export const Alerts: React.FC<{ alerts: Array<{ from?: string; title: string; text?: string; frame: number; to: number }>; top: number; stage: Stage; theme: Theme; fade: number }> = ({ alerts, top, stage, theme, fade }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = stage;
  const w = Math.min(0.9 * stage.w, 940 * u), icon = 96 * u;
  return (
    <>
      {alerts.filter(al => frame >= al.frame && frame < al.to + 12).map(al => {
        const p = spring({ frame: frame - al.frame, fps, config: { damping: 15, stiffness: 150, mass: 0.8 } });
        const away = Easing.in(Easing.cubic)(clamp01((frame - al.to) / 12));
        const y = -90 * u * (1 - p + away);
        return (
          <div
            key={`${al.frame}-${al.title}`}
            style={{
              position: 'absolute', left: (stage.w - w) / 2, top, width: w, transform: `translateY(${y}px)`, opacity: fade * clamp01(1.5 * p) * (1 - away),
              display: 'flex', gap: 26 * u, alignItems: 'center', padding: `${26 * u}px ${30 * u}px`, borderRadius: 34 * u,
              background: withAlpha(theme.text, 0.97), color: theme.bg, boxShadow: `0 ${20 * u}px ${50 * u}px rgba(0,0,0,0.4)`, fontFamily,
            }}
          >
            <div style={{ flex: 'none', width: icon, height: icon, borderRadius: 0.24 * icon, background: theme.accent, color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 0.5 * icon }}>
              {(al.from ?? '!').slice(0, 1).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 28 * u, fontWeight: 700, color: withAlpha(theme.bg, 0.55), letterSpacing: u }}>
                <span>{(al.from ?? '').toUpperCase()}</span>
                <span>now</span>
              </div>
              <div style={{ fontSize: 46 * u, fontWeight: 900, lineHeight: 1.2 }}>{al.title}</div>
              {al.text && <div style={{ fontSize: 38 * u, fontWeight: 700, lineHeight: 1.25, color: withAlpha(theme.bg, 0.8) }}>{al.text}</div>}
            </div>
          </div>
        );
      })}
    </>
  );
};

export const SCENES: { [K in Scene['type']]: SceneDef<Extract<Scene, { type: K }>> } = { title, text, points, compare, flow, image, cycle, timeline, typing, figures, road, '3d': scene3d };

export const sceneOf = <S extends Scene>(scene: S) => SCENES[scene.type] as unknown as SceneDef<S>;
