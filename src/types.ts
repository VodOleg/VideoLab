// Shared data formats: projects/<name>/script.json (written by the agent), build/timeline.json (voice step, or
// estimated), projects/<name>/kit.json (posting kit). docs/SPEC.md describes them in full.

export interface Box { x: number; y: number; w: number; h: number }

/** Frame shape: 16:9 is 1920x1080 (YouTube), 9:16 is 1080x1920 (Shorts, Reels, TikTok), 1:1 is 1080x1080. */
export type Format = '16:9' | '9:16' | '1:1';

/** Colour of an item or column: yes (green), no (red), accent (the theme's highlight); default neutral. */
export type Tone = 'yes' | 'no' | 'accent';

/** An element of a scene that cues can show and point at. */
export interface Item { id: string; text: string; tone?: Tone; /** Crossed out just after it appears. */ strike?: boolean }

/**
 * What a beat shows: a scene type and its content. Every element has an id that cues use; an element no cue names
 * appears when the scene starts. Ids per type: title: title, subtitle · text: text · points: heading + item ids ·
 * compare: left, right (column titles) + item ids · flow: heading, slots (outlines of all steps) + step ids ·
 * image: image, caption + region ids.
 */
export type Scene =
  | { type: 'title'; title: string; subtitle?: string }
  /** A statement in big type: `text`, or the beat's own words. */
  | { type: 'text'; text?: string }
  | { type: 'points'; heading?: string; items: Item[] }
  | { type: 'compare'; left: Column; right: Column }
  /** Steps joined by arrows: a row in landscape, a column in portrait and square. */
  | { type: 'flow'; heading?: string; steps: Step[] }
  /**
   * A picture from the project folder (e.g. "assets/map.png"; PNG, JPEG, WebP or SVG), fitted inside the stage.
   * `regions`: named parts of it as [x, y, w, h] fractions of the picture, for cues to point at (they light up).
   */
  | { type: 'image'; src: string; caption?: string; regions?: Record<string, [number, number, number, number]> };

export interface Column { title: string; tone?: Tone; items: Item[] }
export interface Step { id: string; label: string; detail?: string }

/**
 * A cue fires at its beat's start, or when the voiceover reaches the `at` phrase: it shows elements (by id) and/or
 * points the narrator at one (pointing also shows it and lights it up; null lowers the stick).
 */
export interface Cue { at?: string; show?: string | string[]; point?: string | null }

/** A beat: a few sentences of voiceover spoken over one scene. Each beat is a scene of the finished video. */
export interface Beat { id: string; text: string; scene: Scene; cues?: Cue[] }

/**
 * A Kokoro voice made of other voices' style vectors (src/tts.ts): weights per voice for the timbre half and the
 * delivery (prosody) half; each half's weights sum to 1, and negative ones push away from a voice.
 */
export interface VoiceMix { timbre: Record<string, number>; prosody: Record<string, number> }

export interface Theme { bg: string; panel: string; line: string; text: string; muted: string; accent: string; yes: string; no: string }

/** projects/<name>/script.json */
export interface Script {
  /** Working title, for logs and the review page. */
  title?: string;
  /** Default 16:9. */
  format?: Format;
  /** The narrator character, who hops to what's being said and points at it; default true. */
  narrator?: boolean;
  /** Word-by-word captions burned in; default true for 9:16, false otherwise. */
  captions?: boolean;
  /** Colours over the default dark theme. */
  theme?: Partial<Theme>;
  /** Kokoro voice: a voice name, or `mix` (wins over name); default the stack's narrator voice. */
  voice?: { name?: string; mix?: VoiceMix; speed?: number };
  /** Pronunciations for the voice only, e.g. {"quinoa": "keenwah"} or exact phonemes {"quinoa": "/kˈiːnwɑː/"}; captions keep the real word. */
  say?: Record<string, string>;
  /**
   * Background track from music/ (copied into build/ by npm run render); none when absent or null.
   * volume: gain while the voice is silent; duck: multiplier under the voice; startMs: skip into the track.
   */
  music?: { track: string; volume?: number; duck?: number; startMs?: number } | null;
  beats: Beat[];
}

/** projects/<name>/kit.json: what gets pasted into each platform when posting (npm run kit). */
export interface Kit {
  /** Cover image: the video frame at this many seconds. */
  cover?: { at: number };
  /** Date it went up on the platforms (YYYY-MM-DD); the review page lists it under Published. */
  published?: string;
  youtube?: { title: string; description: string; tags: string[] };
  instagram?: { caption: string };
  tiktok?: { caption: string };
}

export interface Word { text: string; startMs: number; endMs: number }

export interface TimelineBeat {
  id: string;
  startMs: number;
  endMs: number;
  /** Voiceover file for this beat, relative to the project folder. */
  audio?: string;
  words: Word[];
}

export interface Timeline {
  estimated: boolean;
  durationMs: number;
  beats: TimelineBeat[];
}
