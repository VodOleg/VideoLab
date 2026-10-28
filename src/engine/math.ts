// Animation math: pure functions of the frame, so any frame can be drawn on its own, in any order.

export type Extrapolate = 'extend' | 'clamp' | 'identity' | 'wrap';
export type EasingFn = (t: number) => number;

export interface InterpolateOptions {
  easing?: EasingFn;
  /** Below the first input: 'extend' the first segment (default), 'clamp' to the first output, return the input itself ('identity'), or 'wrap' around. */
  extrapolateLeft?: Extrapolate;
  extrapolateRight?: Extrapolate;
}

function extrapolate(x: number, edge: number, inMin: number, inMax: number, mode: Extrapolate) {
  if (mode === 'clamp') return edge;
  if (mode === 'wrap') {
    const range = inMax - inMin;
    return ((((x - inMin) % range) + range) % range) + inMin;
  }
  return x;
}

/** Maps `input` from `inputRange` (strictly increasing) to `outputRange`, piecewise, easing each segment. */
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly number[], options: InterpolateOptions = {}): number {
  if (Number.isNaN(input)) throw new Error('interpolate: input is NaN');
  if (inputRange.length !== outputRange.length || inputRange.length < 2) {
    throw new Error(`interpolate: inputRange (${inputRange.length}) and outputRange (${outputRange.length}) need the same length, at least 2`);
  }
  for (let i = 1; i < inputRange.length; i++) {
    if (!(inputRange[i] > inputRange[i - 1])) throw new Error(`interpolate: inputRange must be strictly increasing, got [${inputRange.join(', ')}]`);
  }
  const { easing = Easing.linear, extrapolateLeft = 'extend', extrapolateRight = 'extend' } = options;
  let i = 1;
  while (i < inputRange.length - 1 && input > inputRange[i]) i++;
  const inMin = inputRange[i - 1], inMax = inputRange[i], outMin = outputRange[i - 1], outMax = outputRange[i];

  let x = input;
  if (x < inMin) {
    if (extrapolateLeft === 'identity') return x;
    x = extrapolate(x, inMin, inMin, inMax, extrapolateLeft);
  }
  if (x > inMax) {
    if (extrapolateRight === 'identity') return x;
    x = extrapolate(x, inMax, inMin, inMax, extrapolateRight);
  }
  if (outMin === outMax) return outMin;
  return outMin + easing((x - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export interface SpringConfig { damping: number; mass: number; stiffness: number; overshootClamping: boolean }

const SPRING_DEFAULTS: SpringConfig = { damping: 10, mass: 1, stiffness: 100, overshootClamping: false };

/**
 * A damped spring from `from` to `to`, released at rest at frame `delay`: the exact solution of the spring's motion at
 * this frame (no stepping, so it's the same whichever frames came before).
 */
export function spring({ frame, fps, config = {}, from = 0, to = 1, delay = 0 }: {
  frame: number; fps: number; config?: Partial<SpringConfig>; from?: number; to?: number; delay?: number;
}): number {
  const { damping, mass, stiffness, overshootClamping } = { ...SPRING_DEFAULTS, ...config };
  const t = Math.max(0, frame - delay) / fps;
  const x0 = to - from; // distance still to go at release
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const w0 = Math.sqrt(stiffness / mass);
  let left: number; // distance still to go at t
  if (zeta < 1) {
    const w1 = w0 * Math.sqrt(1 - zeta * zeta);
    left = Math.exp(-zeta * w0 * t) * (x0 * Math.cos(w1 * t) + ((zeta * w0 * x0) / w1) * Math.sin(w1 * t));
  } else {
    left = Math.exp(-w0 * t) * (x0 + w0 * x0 * t);
  }
  const value = to - left;
  if (overshootClamping && (to - value) * x0 < 0) return to;
  return value;
}

/** A CSS-style cubic-bezier(x1, y1, x2, y2). */
function bezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const curve = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  // The curve's parameter where x = target: Newton's method, falling back to bisection where the slope is flat.
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = curve(x1, x2, t) - x, d = slope(x1, x2, t);
      if (Math.abs(dx) < 1e-7) return t;
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      if (curve(x1, x2, t) < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return t => (t <= 0 || t >= 1 ? t : curve(y1, y2, solve(t)));
}

/** Easing curves for interpolate (t from 0 to 1). `in` curves start slow; wrap them in out() or inOut() for the others. */
export const Easing = {
  linear: (t: number) => t,
  quad: (t: number) => t * t,
  cubic: (t: number) => t * t * t,
  poly: (n: number): EasingFn => t => t ** n,
  sin: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  circle: (t: number) => 1 - Math.sqrt(1 - t * t),
  exp: (t: number) => 2 ** (10 * (t - 1)),
  /** Overshoots backwards first; `s` is how far (1.70158 = 10%). */
  back: (s = 1.70158): EasingFn => t => t * t * ((s + 1) * t - s),
  elastic: (bounciness = 1): EasingFn => {
    const p = bounciness * Math.PI;
    return t => 1 - Math.cos((t * Math.PI) / 2) ** 3 * Math.cos(t * p);
  },
  bounce: (t: number) => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { const u = t - 1.5 / 2.75; return 7.5625 * u * u + 0.75; }
    if (t < 2.5 / 2.75) { const u = t - 2.25 / 2.75; return 7.5625 * u * u + 0.9375; }
    const u = t - 2.625 / 2.75;
    return 7.5625 * u * u + 0.984375;
  },
  bezier,
  in: (easing: EasingFn): EasingFn => easing,
  out: (easing: EasingFn): EasingFn => t => 1 - easing(1 - t),
  inOut: (easing: EasingFn): EasingFn => t => (t < 0.5 ? easing(t * 2) / 2 : 1 - easing((1 - t) * 2) / 2),
  ease: bezier(0.42, 0, 1, 1),
};

/** A number in [0, 1) that's always the same for the same seed (so frames agree with each other). */
export function random(seed: string | number): number {
  let h: number;
  if (typeof seed === 'number') h = seed * 10000000000;
  else {
    h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  // mulberry32
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
