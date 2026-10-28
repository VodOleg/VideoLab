// The scene kit: what a beat can show, laid out from the script's data for any frame shape. Each scene type turns its
// content into boxes (cues show them; the narrator points at them and keeps clear of them) and draws them, each element
// popping in at its first cue. Text is sized to fit its box, so any wording works. docs/SPEC.md lists the types.
import type React from 'react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from '../engine/index.ts';
import type { Beat, Box, Column, Item, Scene, Step, Theme, Tone } from '../types.ts';
import { fontFamily } from './fonts.ts';

export interface Point { x: number; y: number }

export const DEFAULT_THEME: Theme = {
  bg: '#11131f', panel: '#1b1f31', line: '#2f3552', text: '#eef0ff', muted: '#8d93b8', accent: '#ffb238', no: '#ff5d6c', yes: '#7ce0c3',
};
const STEP_COLORS = ['#7aa2ff', '#ff8fb1', '#7ce0c3', '#ffd166', '#b69cff', '#6fd3ff'];

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
  /** How far the narrator is pointing at an element right now, 0-1. */
  pointed: (id: string) => number;
}

interface SceneDef<S extends Scene> { layout: (scene: S, beat: Beat, stage: Stage) => Layout; Component: React.FC<SceneProps<S>> }

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const withAlpha = (hex: string, a: number) => hex + Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0');
const toneColor = (theme: Theme, tone: Tone | undefined, fallback: string) => (tone ? theme[tone] : fallback);

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

/** 0 -> 1, with a little overshoot, from frame `at`. */
function usePop(at: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame < at ? 0 : spring({ frame: frame - at, fps, config: { damping: 12, stiffness: 170, mass: 0.7 } });
}

const Text: React.FC<{ size: number; color: string; weight?: number; align?: 'center' | 'left'; children: React.ReactNode }> = ({ size, color, weight = 800, align = 'center', children }) => (
  <div style={{ fontFamily, fontSize: size, fontWeight: weight, color, lineHeight: LINE, textAlign: align, textWrap: 'balance', overflowWrap: 'anywhere' }}>{children}</div>
);

/** A panel that pops in at `at` and lights up in its colour while the narrator points at it. */
const Panel: React.FC<{ box: Box; at: number; color: string; pointed: number; theme: Theme; u: number; align?: 'center' | 'left'; children?: React.ReactNode }> = ({ box, at, color, pointed, theme, u, align = 'center', children }) => {
  const p = usePop(at);
  if (p <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, padding: `0 ${24 * u}px`,
        borderRadius: 22 * u, background: theme.panel, border: `${3 * u}px solid ${withAlpha(color, 0.3 + 0.7 * pointed)}`,
        boxShadow: `0 ${18 * u}px ${40 * u}px rgba(0,0,0,0.45), 0 0 ${60 * u}px ${withAlpha(color, 0.5 * pointed)}`,
        opacity: Math.min(1, p), transform: `scale(${(0.7 + 0.3 * p) * (1 + 0.05 * pointed)})`,
        display: 'flex', flexDirection: 'column', alignItems: align === 'center' ? 'center' : 'stretch', justifyContent: 'center',
      }}
    >
      {children}
    </div>
  );
};

/** Text without a panel (titles, headings), rising into place at `at`. */
const Words: React.FC<{ box: Box; at: number; size: number; color: string; weight?: number; pointed?: number; theme: Theme; children: React.ReactNode }> = ({ box, at, size, color, weight, pointed = 0, theme, children }) => {
  const p = usePop(at);
  if (p <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: Math.min(1, p), transform: `translateY(${(1 - p) * 20}px) scale(${1 + 0.04 * pointed})`,
        textShadow: pointed ? `0 0 ${30 * pointed}px ${withAlpha(theme.accent, 0.6 * pointed)}` : undefined,
      }}
    >
      <Text size={size} color={color} weight={weight}>{children}</Text>
    </div>
  );
};

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
const Arrow: React.FC<{ from: Point; to: Point; at: number; color: string; u: number }> = ({ from, to, at, color, u }) => {
  const drawn = interpolate(useCurrentFrame(), [at, at + 8], [0, 1], { ...clampOpts, easing: Easing.out(Easing.cubic) });
  if (drawn <= 0) return null;
  const head = 14 * u;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const end = { x: from.x + (to.x - from.x) * drawn, y: from.y + (to.y - from.y) * drawn };
  const back = (d: number, side: number) => ({ x: end.x - Math.cos(angle) * d - Math.sin(angle) * side, y: end.y - Math.sin(angle) * d + Math.cos(angle) * side });
  const [l, r, base] = [back(head, head * 0.7), back(head, -head * 0.7), back(head * 0.6, 0)];
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible' }}>
      <line x1={from.x} y1={from.y} x2={base.x} y2={base.y} stroke={color} strokeWidth={4 * u} strokeLinecap="round" />
      <polygon points={`${end.x},${end.y} ${l.x},${l.y} ${r.x},${r.y}`} fill={color} />
    </svg>
  );
};

const centered = (outer: Box, w: number, h: number): Box => ({ x: outer.x + (outer.w - w) / 2, y: outer.y + (outer.h - h) / 2, w, h });

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
  Component: ({ scene, layout: { anchors: a, fonts }, theme, shown, pointed }) => (
    <>
      <Words box={a.title} at={shown('title')} size={fonts.title} color={theme.text} weight={900} pointed={pointed('title')} theme={theme}>{scene.title}</Words>
      {scene.subtitle && <Words box={a.subtitle} at={shown('subtitle')} size={fonts.subtitle} color={theme.accent} weight={700} pointed={pointed('subtitle')} theme={theme}>{scene.subtitle}</Words>}
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
  Component: ({ scene, beat, layout: { anchors: a, fonts }, theme, shown, pointed }) => (
    <Words box={a.text} at={shown('text')} size={fonts.text} color={theme.text} pointed={pointed('text')} theme={theme}>{scene.text ?? beat.text}</Words>
  ),
};

// points: an optional heading over a list of items.

const points: SceneDef<Extract<Scene, { type: 'points' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const anchors: Record<string, Box> = {};
    const fonts: Record<string, number> = {};
    const w = wide ? Math.min(c.w * 0.64, 1150 * u) : c.w * 0.96;
    let top = c.y;
    if (s.heading) {
      fonts.heading = fitFont(s.heading, c.w * 0.9, 150 * u, 62 * u);
      const h = textHeight(s.heading, c.w * 0.9, fonts.heading);
      anchors.heading = { x: c.x + c.w * 0.05, y: top, w: c.w * 0.9, h };
      top += h + 40 * u;
    }
    const n = Math.max(1, s.items.length), gap = 22 * u, avail = c.y + c.h - top;
    const itemH = Math.min(112 * u, (avail - gap * (n - 1)) / n);
    const textW = w - 2 * 24 * u - 44 * u; // padding and the bullet
    fonts.item = Math.min(...s.items.map(it => fitFont(it.text, textW, itemH * 0.86, 46 * u)));
    const y0 = top + (avail - (n * itemH + (n - 1) * gap)) / 2;
    s.items.forEach((it, i) => { anchors[it.id] = { x: c.x + (c.w - w) / 2, y: y0 + i * (itemH + gap), w, h: itemH }; });
    return { anchors, fonts };
  },
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u }, theme, shown, pointed }) => (
    <>
      {scene.heading && <Words box={a.heading} at={shown('heading')} size={fonts.heading} color={theme.text} weight={900} pointed={pointed('heading')} theme={theme}>{scene.heading}</Words>}
      {scene.items.map(it => <ItemPanel key={it.id} item={it} box={a[it.id]} at={shown(it.id)} size={fonts.item} pointed={pointed(it.id)} theme={theme} u={u} bullet />)}
    </>
  ),
};

const ItemPanel: React.FC<{ item: Item; box: Box; at: number; size: number; pointed: number; theme: Theme; u: number; bullet?: boolean; tone?: Tone }> = ({ item, box, at, size, pointed, theme, u, bullet, tone }) => {
  const color = toneColor(theme, item.tone ?? tone, theme.accent);
  return (
    <Panel box={box} at={at} color={color} pointed={pointed} theme={theme} u={u} align={bullet ? 'left' : 'center'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 * u, justifyContent: bullet ? 'flex-start' : 'center' }}>
        {bullet && <div style={{ flex: 'none', width: 22 * u, height: 22 * u, borderRadius: '50%', background: color }} />}
        <Text size={size} color={item.strike ? theme.muted : theme.text} align={bullet ? 'left' : 'center'}>{item.text}</Text>
      </div>
      {item.strike && <Strike at={at + 10} color={theme.no} u={u} />}
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
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u }, theme, shown, cued, pointed }) => (
    <>
      {(['left', 'right'] as const).map(side => {
        const col: Column = scene[side];
        // A column title appears at its own cue, else with its first item.
        const first = col.items[0]?.id;
        return (
          <div key={side}>
            <Words box={a[side]} at={cued(side) || !first ? shown(side) : shown(first)} size={fonts.head} color={toneColor(theme, col.tone, theme.muted)} weight={900} pointed={pointed(side)} theme={theme}>
              {col.title.toUpperCase()}
            </Words>
            {col.items.map(it => <ItemPanel key={it.id} item={it} tone={col.tone} box={a[it.id]} at={shown(it.id)} size={fonts.item} pointed={pointed(it.id)} theme={theme} u={u} />)}
          </div>
        );
      })}
    </>
  ),
};

// flow: steps joined by arrows, a row on wide frames and a column otherwise; `slots` outlines them all before they appear.

const flow: SceneDef<Extract<Scene, { type: 'flow' }>> = {
  layout: (s, _beat, { content: c, u, wide }) => {
    const anchors: Record<string, Box> = {};
    const fonts: Record<string, number> = {};
    let top = c.y;
    if (s.heading) {
      fonts.heading = fitFont(s.heading, c.w * 0.9, 150 * u, 64 * u);
      const h = textHeight(s.heading, c.w * 0.9, fonts.heading);
      anchors.heading = { x: c.x + c.w * 0.05, y: top, w: c.w * 0.9, h };
      top += h + 50 * u;
    }
    const area: Box = { x: c.x, y: top, w: c.w, h: c.y + c.h - top };
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
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u, wide }, theme, shown, cued, pointed }) => {
    const frame = useCurrentFrame();
    const slots = cued('slots') ? shown('slots') : Infinity;
    return (
      <>
        {scene.heading && <Words box={a.heading} at={shown('heading')} size={fonts.heading} color={theme.text} weight={900} pointed={pointed('heading')} theme={theme}>{scene.heading}</Words>}
        {scene.steps.map((st: Step, i) => {
          const box = a[st.id], at = shown(st.id), color = STEP_COLORS[i % STEP_COLORS.length];
          const prev = scene.steps[i - 1] && a[scene.steps[i - 1].id];
          const pad = 10 * u;
          const arrow = prev && (wide
            ? { from: { x: prev.x + prev.w + pad, y: box.y + box.h / 2 }, to: { x: box.x - pad, y: box.y + box.h / 2 } }
            : { from: { x: box.x + box.w / 2, y: prev.y + prev.h + pad }, to: { x: box.x + box.w / 2, y: box.y - pad } });
          return (
            <div key={st.id}>
              {frame >= slots && frame < at + 4 && (
                <div
                  style={{
                    position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: 22 * u,
                    border: `${3 * u}px dashed ${theme.line}`, opacity: interpolate(frame, [slots + 2 * i, slots + 2 * i + 6], [0, 1], clampOpts),
                  }}
                />
              )}
              {arrow && <Arrow {...arrow} at={at - 4} color={theme.muted} u={u} />}
              <Panel box={box} at={at} color={color} pointed={pointed(st.id)} theme={theme} u={u}>
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

// image: a picture fitted inside the stage, an optional caption under it, and named regions to point at.

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
  Component: ({ scene, layout: { anchors: a, fonts }, stage: { u }, theme, project, shown, cued, pointed }) => {
    const frame = useCurrentFrame();
    const p = usePop(shown('image'));
    const pic = a.image;
    const src = /^https?:/.test(scene.src) ? scene.src : staticFile(`${project}/${scene.src}`);
    return (
      <>
        {p > 0 && (
          <div style={{ position: 'absolute', left: pic.x, top: pic.y, width: pic.w, height: pic.h, opacity: Math.min(1, p), transform: `scale(${0.92 + 0.08 * p})` }}>
            <Img src={src} style={{ width: '100%', height: '100%', borderRadius: 18 * u, boxShadow: `0 ${18 * u}px ${50 * u}px rgba(0,0,0,0.5)`, display: 'block' }} />
          </div>
        )}
        {Object.keys(scene.regions ?? {}).map(id => {
          const r = a[id], lit = pointed(id), outlined = cued(id) && frame >= shown(id) ? 0.45 : 0;
          const strength = Math.max(lit, outlined);
          if (strength <= 0 || p <= 0) return null;
          return (
            <div
              key={id}
              style={{
                position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 12 * u,
                border: `${6 * u}px solid ${withAlpha(theme.accent, strength)}`, background: withAlpha(theme.accent, 0.16 * lit),
                boxShadow: `0 0 ${50 * u * lit}px ${withAlpha(theme.accent, 0.8 * lit)}`,
              }}
            />
          );
        })}
        {scene.caption && <Words box={a.caption} at={shown('caption')} size={fonts.caption} color={theme.muted} weight={700} pointed={pointed('caption')} theme={theme}>{scene.caption}</Words>}
      </>
    );
  },
};

export const SCENES: { [K in Scene['type']]: SceneDef<Extract<Scene, { type: K }>> } = { title, text, points, compare, flow, image };

export const sceneOf = <S extends Scene>(scene: S) => SCENES[scene.type] as unknown as SceneDef<S>;
