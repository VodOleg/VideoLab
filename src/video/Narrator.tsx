// The narrator: a round character drawn in SVG and posed by narratorAt (plan.ts): it hops, squashes as it lands, points
// with a stick, looks at what it points at, blinks, and opens its mouth with the voiceover's loudness.
import type React from 'react';
import { random, useVideoConfig } from '../engine/index.ts';
import type { NarratorPose } from './plan.ts';

const BODY = '#ffb238', LIGHT = '#ffe08a', SHADE = '#f08a24', INK = '#2a1e3a';
const STICK = '#c58b4e', TIP = '#fff3c4', MOUTH = '#4a1a2c', TONGUE = '#ff7a8a';

/**
 * 0 = eyes open, 1 = shut: a 6-frame blink every 2-5 s, counted from `frame` 0 with the blinks drawn from `seed`.
 * (The Video restarts it each scene, so a scene that only moves in time looks the same and keeps its clip.)
 */
export function blinkAt(frame: number, fps: number, seed = '') {
  let t = 0;
  for (let i = 0; ; i++) {
    t += fps * (2 + 3 * random(`blink-${seed}-${i}`));
    if (frame < t - 3) return 0;
    if (frame < t + 3) return 1 - Math.abs(frame - t) / 3;
  }
}

/** `mouth`: how open, 0-1 (the voice's loudness right now). */
export const Narrator: React.FC<{ pose: NarratorPose; R: number; mouth: number; blink: number }> = ({ pose, R, mouth, blink }) => {
  const { width, height } = useVideoConfig();
  const { x, y, ground, sx, sy, aim, ext, look } = pose;
  const lift = ground - y;
  const talk = 1 + 0.03 * mouth;

  // The stick comes out of a little hand on the body's edge, facing the target.
  let stick: { base: { x: number; y: number }; tip: { x: number; y: number } } | null = null;
  if (aim && ext > 0.02) {
    const len = Math.hypot(aim.x - x, aim.y - y) || 1;
    const base = { x: x + ((aim.x - x) / len) * 0.82 * R, y: y + ((aim.y - y) / len) * 0.82 * R };
    stick = { base, tip: { x: base.x + (aim.x - base.x) * ext, y: base.y + (aim.y - base.y) * ext } };
  }

  // Mouth: a smile line that opens downwards; a tongue shows once it's open.
  const mw = R * (0.3 - 0.07 * mouth), mh = R * (0.02 + 0.36 * mouth);
  const mouthPath = `M ${-mw} 0 Q 0 ${0.1 * R} ${mw} 0 Q 0 ${0.1 * R + 2 * mh} ${-mw} 0 Z`;
  const eye = (side: number) => (
    <g transform={`translate(${side * 0.34 * R} ${-0.2 * R}) scale(1 ${1 - 0.92 * blink})`}>
      <ellipse rx={0.21 * R} ry={0.26 * R} fill="#ffffff" stroke={INK} strokeWidth={0.05 * R} />
      <circle cx={look.x * 0.09 * R} cy={look.y * 0.11 * R} r={0.11 * R} fill={INK} />
      <circle cx={look.x * 0.09 * R + 0.04 * R} cy={look.y * 0.11 * R - 0.04 * R} r={0.035 * R} fill="#ffffff" />
    </g>
  );

  return (
    <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      <defs>
        <radialGradient id="narrator-body" cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor={LIGHT} />
          <stop offset="0.55" stopColor={BODY} />
          <stop offset="1" stopColor={SHADE} />
        </radialGradient>
      </defs>
      <ellipse cx={x} cy={ground + 1.02 * R} rx={0.8 * R * (1 - Math.min(0.5, lift / (3 * R)))} ry={0.14 * R} fill="rgba(0,0,0,0.35)" />
      {stick && (
        <g strokeLinecap="round">
          <line x1={stick.base.x} y1={stick.base.y} x2={stick.tip.x} y2={stick.tip.y} stroke={INK} strokeWidth={0.17 * R} />
          <line x1={stick.base.x} y1={stick.base.y} x2={stick.tip.x} y2={stick.tip.y} stroke={STICK} strokeWidth={0.1 * R} />
          <circle cx={stick.tip.x} cy={stick.tip.y} r={0.09 * R} fill={TIP} stroke={INK} strokeWidth={0.045 * R} />
        </g>
      )}
      {/* Squash and stretch from the bottom of the body, so it stays on the ground. */}
      <g transform={`translate(${x} ${y + R}) scale(${sx * talk} ${sy * talk}) translate(0 ${-R})`}>
        <circle r={R} fill="url(#narrator-body)" stroke={INK} strokeWidth={0.07 * R} />
        <ellipse cx={-0.58 * R} cy={0.2 * R} rx={0.14 * R} ry={0.08 * R} fill={TONGUE} opacity={0.35} />
        <ellipse cx={0.58 * R} cy={0.2 * R} rx={0.14 * R} ry={0.08 * R} fill={TONGUE} opacity={0.35} />
        {eye(-1)}
        {eye(1)}
        <g transform={`translate(0 ${0.3 * R})`}>
          <clipPath id="narrator-mouth"><path d={mouthPath} /></clipPath>
          <path d={mouthPath} fill={MOUTH} stroke={INK} strokeWidth={0.06 * R} strokeLinejoin="round" />
          {mouth > 0.15 && <ellipse cx={0} cy={0.05 * R + 1.7 * mh} rx={0.55 * mw} ry={0.6 * mh} fill={TONGUE} clipPath="url(#narrator-mouth)" />}
        </g>
      </g>
      {stick && <circle cx={stick.base.x} cy={stick.base.y} r={0.17 * R} fill={BODY} stroke={INK} strokeWidth={0.06 * R} />}
    </svg>
  );
};
