// The narrator: a round character drawn in SVG and posed by narratorAt (plan.ts): it hops, squashes as it lands, points
// with a stick, looks at what it points at, blinks, and opens its mouth with the voiceover's loudness.
import type React from 'react';
import { Img, random, useVideoConfig } from '../engine/index.ts';
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

/** `mouth`: how open, 0-1 (the voice's loudness right now). `image`: a picture for the body instead of the round face. */
export const Narrator: React.FC<{ pose: NarratorPose; R: number; mouth: number; blink: number; image?: string }> = ({ pose, R, mouth, blink, image }) => {
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

  const mouthG = (
    <g transform={`translate(0 ${0.3 * R})`}>
      <clipPath id="narrator-mouth"><path d={mouthPath} /></clipPath>
      <path d={mouthPath} fill={MOUTH} stroke={INK} strokeWidth={0.06 * R} strokeLinejoin="round" />
      {mouth > 0.15 && <ellipse cx={0} cy={0.05 * R + 1.7 * mh} rx={0.55 * mw} ry={0.6 * mh} fill={TONGUE} clipPath="url(#narrator-mouth)" />}
    </g>
  );
  const squash = `scale(${sx * talk}, ${sy * talk})`;

  return (
    <>
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
      {!image && <g transform={`translate(${x} ${y + R}) scale(${sx * talk} ${sy * talk}) translate(0 ${-R})`}>
        <circle r={R} fill="url(#narrator-body)" stroke={INK} strokeWidth={0.07 * R} />
        <ellipse cx={-0.58 * R} cy={0.2 * R} rx={0.14 * R} ry={0.08 * R} fill={TONGUE} opacity={0.35} />
        <ellipse cx={0.58 * R} cy={0.2 * R} rx={0.14 * R} ry={0.08 * R} fill={TONGUE} opacity={0.35} />
        {eye(-1)}
        {eye(1)}
        {mouthG}
      </g>}
      {stick && <circle cx={stick.base.x} cy={stick.base.y} r={0.17 * R} fill={BODY} stroke={INK} strokeWidth={0.06 * R} />}
    </svg>
    {image && (
      <div style={{ position: 'absolute', left: x - 1.2 * R, top: y - 1.4 * R, width: 2.4 * R, height: 2.4 * R, transformOrigin: '50% 100%', transform: squash }}>
        <Img src={image} style={{ width: '100%', height: '100%', display: 'block' }} />
        <svg viewBox={`${-1.2 * R} ${-1.2 * R} ${2.4 * R} ${2.4 * R}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>{mouthG}</svg>
      </div>
    )}
    </>
  );
};

const CAB = { body: '#0b0b0d', shine: '#2a2a30', outline: '#f4f4f6', chrome: '#c9ccd2', glass: '#cfd7e2', glassDark: '#8796a8', tyre: '#1c1c20', beam: '#ff8c1a' };

/**
 * The narrator as a black cab, seen from the front: eyes in the windscreen, the grille for a mouth, a TAXI sign that
 * glows while it talks. It drives where narratorAt hops (a small bounce and a lean instead of jumps), and points by
 * shining a headlight beam at the target. Its wheels sit where the round narrator's bottom would be.
 */
export const Cab: React.FC<{ pose: NarratorPose; R: number; mouth: number; blink: number; image?: string }> = ({ pose, R, mouth, blink }) => {
  const { width, height } = useVideoConfig();
  const { x, y, ground, aim, ext, look } = pose;
  const lift = ground - y;
  const cy = ground - 0.15 * lift; // a bounce, not a jump
  const lean = Math.max(-1, Math.min(1, look.x)) * Math.min(1, lift / (0.5 * R)) * 5;
  const s = R * 1.05; // drawing unit: the cab is about 2.3 of these wide
  const eye = (side: number) => (
    <g transform={`translate(${side * 0.34 * s} ${-0.56 * s}) scale(1 ${1 - 0.9 * blink})`}>
      <ellipse rx={0.2 * s} ry={0.17 * s} fill="#ffffff" stroke={CAB.body} strokeWidth={0.04 * s} />
      <circle cx={look.x * 0.08 * s} cy={look.y * 0.06 * s} r={0.09 * s} fill={CAB.body} />
      <circle cx={look.x * 0.08 * s + 0.035 * s} cy={look.y * 0.06 * s - 0.035 * s} r={0.03 * s} fill="#ffffff" />
    </g>
  );
  // The beam: from the headlight nearer the target, widening onto it.
  let beam: React.ReactNode = null;
  if (aim && ext > 0.02) {
    const side = aim.x >= x ? 1 : -1;
    const from = { x: x + side * 0.78 * s, y: cy + 0.12 * s };
    const dx = aim.x - from.x, dy = aim.y - from.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, reach = Math.min(1, ext), spread = 0.55 * s * reach;
    const tip = { x: from.x + dx * reach, y: from.y + dy * reach };
    beam = (
      <g opacity={Math.min(1, ext)}>
        <defs>
          <linearGradient id="cab-beam" gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={tip.x} y2={tip.y}>
            <stop offset="0" stopColor={CAB.beam} stopOpacity={0.75} />
            <stop offset="1" stopColor={CAB.beam} stopOpacity={0.12} />
          </linearGradient>
        </defs>
        <polygon points={`${from.x + nx * 0.12 * s},${from.y + ny * 0.12 * s} ${tip.x + nx * spread},${tip.y + ny * spread} ${tip.x - nx * spread},${tip.y - ny * spread} ${from.x - nx * 0.12 * s},${from.y - ny * 0.12 * s}`} fill="url(#cab-beam)" />
        <circle cx={tip.x} cy={tip.y} r={0.22 * s * reach} fill={CAB.beam} opacity={0.55} />
      </g>
    );
  }
  const grilleH = 0.26 * s + 0.2 * s * mouth;
  const lit = 0.35 + 0.65 * Math.min(1, mouth * 1.6);
  return (
    <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      {beam}
      <ellipse cx={x} cy={ground + 1.02 * R} rx={1.15 * s} ry={0.13 * s} fill="rgba(0,0,0,0.5)" />
      <g transform={`translate(${x} ${cy + R - 1.02 * s}) rotate(${lean}) scale(${1 + 0.02 * mouth})`} strokeLinejoin="round">
        {/* TAXI sign */}
        <rect x={-0.42 * s} y={-1.32 * s} width={0.84 * s} height={0.26 * s} rx={0.07 * s} fill={withGlow(lit)} stroke={CAB.outline} strokeWidth={0.04 * s} />
        <text x={0} y={-1.13 * s} textAnchor="middle" fontFamily="Montserrat" fontWeight={900} fontSize={0.19 * s} fill={CAB.body} letterSpacing={0.02 * s}>TAXI</text>
        {/* Tyres, under the body */}
        <rect x={-1.0 * s} y={0.62 * s} width={0.42 * s} height={0.4 * s} rx={0.1 * s} fill={CAB.tyre} />
        <rect x={0.58 * s} y={0.62 * s} width={0.42 * s} height={0.4 * s} rx={0.1 * s} fill={CAB.tyre} />
        {/* Cabin and body */}
        <path d={`M ${-0.95 * s} ${-0.1 * s} L ${-0.85 * s} ${-0.9 * s} Q ${-0.8 * s} ${-1.08 * s} ${-0.55 * s} ${-1.08 * s} L ${0.55 * s} ${-1.08 * s} Q ${0.8 * s} ${-1.08 * s} ${0.85 * s} ${-0.9 * s} L ${0.95 * s} ${-0.1 * s} Z`} fill={CAB.body} stroke={CAB.outline} strokeWidth={0.05 * s} />
        <rect x={-1.15 * s} y={-0.2 * s} width={2.3 * s} height={0.9 * s} rx={0.22 * s} fill={CAB.body} stroke={CAB.outline} strokeWidth={0.05 * s} />
        <rect x={-1.0 * s} y={-0.14 * s} width={2.0 * s} height={0.08 * s} rx={0.04 * s} fill={CAB.shine} />
        {/* Mirrors */}
        <ellipse cx={-1.12 * s} cy={-0.32 * s} rx={0.12 * s} ry={0.08 * s} fill={CAB.body} stroke={CAB.outline} strokeWidth={0.035 * s} />
        <ellipse cx={1.12 * s} cy={-0.32 * s} rx={0.12 * s} ry={0.08 * s} fill={CAB.body} stroke={CAB.outline} strokeWidth={0.035 * s} />
        {/* Windscreen with the eyes */}
        <defs>
          <linearGradient id="cab-glass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={CAB.glass} />
            <stop offset="1" stopColor={CAB.glassDark} />
          </linearGradient>
        </defs>
        <path d={`M ${-0.7 * s} ${-0.25 * s} L ${-0.64 * s} ${-0.84 * s} Q ${-0.6 * s} ${-0.94 * s} ${-0.48 * s} ${-0.94 * s} L ${0.48 * s} ${-0.94 * s} Q ${0.6 * s} ${-0.94 * s} ${0.64 * s} ${-0.84 * s} L ${0.7 * s} ${-0.25 * s} Z`} fill="url(#cab-glass)" stroke={CAB.chrome} strokeWidth={0.03 * s} />
        {eye(-1)}
        {eye(1)}
        {/* Headlights: brighter while the beam is on */}
        {[-1, 1].map(side => (
          <g key={side}>
            <circle cx={side * 0.78 * s} cy={0.12 * s} r={0.19 * s} fill={CAB.chrome} />
            <circle cx={side * 0.78 * s} cy={0.12 * s} r={0.14 * s} fill={ext > 0.02 && (aim?.x ?? x) * side >= x * side ? CAB.beam : '#fff6dc'} />
          </g>
        ))}
        {/* The grille is the mouth: it opens with the voice. */}
        <rect x={-0.34 * s} y={0.0 * s} width={0.68 * s} height={grilleH} rx={0.08 * s} fill="#141418" stroke={CAB.chrome} strokeWidth={0.05 * s} />
        {[-0.2, -0.07, 0.07, 0.2].map(gx => <line key={gx} x1={gx * s} y1={0.05 * s} x2={gx * s} y2={grilleH - 0.05 * s} stroke={CAB.chrome} strokeWidth={0.025 * s} opacity={0.8} />)}
        {/* Bumper */}
        <rect x={-1.2 * s} y={0.56 * s} width={2.4 * s} height={0.13 * s} rx={0.065 * s} fill={CAB.chrome} />
      </g>
    </svg>
  );
};

/** The TAXI sign's colour: dim amber, glowing orange as the voice gets louder. */
const withGlow = (lit: number) => `rgb(${Math.round(150 + 105 * lit)}, ${Math.round(90 + 50 * lit)}, ${Math.round(20 + 6 * lit)})`;
