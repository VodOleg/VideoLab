// The engine's API for video components: import from here, not from the engine's files.
export { AbsoluteFill, Audio, continueRender, delayRender, Freeze, Img, loadFont, Sequence, staticFile, useCurrentFrame, useVideoConfig, type AudioProps, type VideoConfig } from './core.tsx';
export { Easing, interpolate, random, spring, type EasingFn, type Extrapolate, type InterpolateOptions, type SpringConfig } from './math.ts';
export { composition, registerRoot, type CalculateMetadataFunction, type CompositionDef, type Metadata } from './page.tsx';
