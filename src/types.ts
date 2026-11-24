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
 * image: image, caption + region ids · cycle: heading + node ids · timeline: heading + step ids · typing: window ·
 * figures: heading + figure ids · road: heading, rider + readout ids · 3d: heading + object ids.
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
  | { type: 'image'; src: string; caption?: string; regions?: Record<string, [number, number, number, number]>; marks?: Mark[] }
  /**
   * A loop or system: nodes joined by curved arrows, each drawn as the voice reaches its `at`. Layouts: ring (any number,
   * clockwise from the top; 3 make a triangle), grid (4, in reading order), payoff (the first node on top, the others
   * feeding it from below). `reveal`: a node appears only with the first arrow reaching it. Once every arrow is drawn,
   * light keeps running along them (`loop`, default true).
   */
  | { type: 'cycle'; layout?: 'ring' | 'triangle' | 'grid' | 'payoff'; heading?: string; nodes: CycleNode[]; arrows: CycleArrow[]; reveal?: boolean; loop?: boolean }
  /**
   * Steps along an axis (days, stages, years): each step's items show big at `at`, its marker lights at `light`, and the
   * items shrink into the marker at `land` (by default just before the next step's items come); the last step's stay.
   */
  | { type: 'timeline'; heading?: string; steps: TimelineStep[] }
  /**
   * Text typing itself out: a chat message (`chat`, from `who`) or code in an editor (`code`, titled `title`). It types
   * from the phrase `from` (default: just after the scene starts) to the phrase `until` (default: ~30 characters a second).
   */
  | { type: 'typing'; style?: 'chat' | 'code'; who?: string; title?: string; text: string; from?: string; until?: string }
  /** Key numbers, each big with an animated icon (a clock whose hands spin, dollar bills piling up) and a label. */
  | { type: 'figures'; heading?: string; items: Figure[] }
  /**
   * A side view of a ride: a motorbike (`label` on its side) and its rider on a road through a landscape, the camera
   * following them. `moves` change what they do as the voice reaches each `at` (one without `at` from the start; default
   * ride): ride (cruising), wheelie (a wheelie, then riding on), stall (the engine dies and the bike rolls to a stop),
   * push (the rider gets off and pushes it, slowly, under a rain cloud, while the clouds above race by), launch (back on,
   * a wheelie and off out of the frame). Stalling and pushing drain the colour; riding brings it back. `readouts`: numbers
   * in panels near the top (cued like any element) that count up to their `value` ("10:00", "4.0 m") until the move they
   * appeared in ends, then leave.
   */
  | { type: 'road'; heading?: string; label?: string; moves?: RoadMove[]; readouts?: Readout[] }
  /**
   * A 3D scene (three.js): `objects` standing on a floor, lit by a `light` preset, through a camera that frames them by
   * meaning (`camera`: which objects, from which angle, how close) and moves to each of `shots` as the voice reaches its
   * `at`; `orbit` circles slowly round. Units are metres, y is up, and the floor is at y 0. Cues work on objects as on
   * any element: shown, they rise into place; pointed at or spotlit, they glow. Objects no cue names are simply there.
   */
  | {
    type: '3d';
    /**
     * Carry on from an earlier beat's 3d scene (its id): its objects where they ended up, its light, floor and
     * spotlight. `objects` here add to them, or change one (the same id: these fields replace its own; `gone`
     * removes it). The camera isn't carried: give each beat its shots.
     */
    with?: string;
    heading?: string;
    /** studio (default: soft boxes over the theme's background), day, sunset, night, or stage (a dark hall; use a spotlight). */
    light?: 'studio' | 'day' | 'sunset' | 'night' | 'stage';
    /**
     * A theatre spotlight from above the audience on the object `on` (following it), `angle` degrees wide (default
     * 16); `dim` 0-1 darkens everything else (the house lights). `changes` re-aim, widen or narrow it and dim as the
     * voice reaches each `at`, over `seconds` (default 1).
     */
    spotlight?: { on?: string; angle?: number; dim?: number; changes?: Array<{ at?: string; wait?: number; on?: string; angle?: number; dim?: number; seconds?: number }> };
    /** Background colour (studio; the others have a sky). */
    background?: string;
    /** Floor colour, or false for none. */
    floor?: string | false;
    camera?: Shot;
    shots?: Shot[];
    /** Degrees a second the camera circles round what it looks at. */
    orbit?: number;
    objects: Thing[];
  };

/** An object in a 3D scene. */
export interface Thing {
  id: string;
  /**
   * A shape, raised `text`, a `model` (src: a .glb or .gltf in the project folder, e.g. "assets/bike.glb"), a
   * `screen` showing `slides`, or a `group` (nothing drawn: a frame to build a figure in from parts).
   */
  shape: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'capsule' | 'text' | 'model' | 'screen' | 'group';
  text?: string;
  src?: string;
  /**
   * Part of another object (its id): `at` and `turn` are then measured from that object's base and turn, and it
   * moves, turns, scales and appears with it. Build figures this way: a body with a head and arms.
   */
  parent?: string;
  /** What it turns about: its middle (default), its base, or its top (an arm from the shoulder). */
  pivot?: 'middle' | 'base' | 'top';
  /** A torus drawn only this many degrees round (a hook, a horseshoe); default the whole ring. */
  arc?: number;
  /** Swings this many degrees about its pivot as its parent walks (legs and arms; opposite signs alternate). */
  stride?: number;
  /** A screen's slides, each from its `at` (crossfading). */
  slides?: Slide[];
  /** Its scale before any moves (default 1). */
  scale?: number;
  /** In a scene carried on `with` another: take this object away. */
  gone?: boolean;
  /**
   * Metres: [width, height, depth], or one number (a box's side, a sphere's or ring's diameter, a model's largest side,
   * text's letter size). A model is scaled to fit.
   */
  size?: number | [number, number, number];
  /** Where it stands: the middle of its base, [x, y, z] (default [0, 0, 0]: on the floor in the middle). */
  at?: [number, number, number];
  /** Degrees round the vertical axis (positive turns it to its left), or [x, y, z]. */
  turn?: number | [number, number, number];
  color?: string;
  tone?: Tone;
  /** plastic (default), matte, metal, glass, or glow (lit from within). */
  material?: 'plastic' | 'matte' | 'metal' | 'glass' | 'glow';
  /** A name tag over it, always facing the viewer. */
  label?: string;
  /** Degrees a second it turns round the vertical axis. */
  spin?: number;
  /** Bobs gently up and down. */
  float?: boolean;
  /** A model's animation, by name ("*": its first), looping. */
  animation?: string;
  /**
   * As the voice reaches each `at` (and `wait` seconds more), it goes to a new place (`to`), turn or `scale`,
   * over `seconds` (default 1). A model can play another `animation` from there: for `seconds` if given
   * (looping), else once; then it goes back to its own.
   */
  moves?: Array<{ at?: string; wait?: number; to?: [number, number, number]; turn?: number | [number, number, number]; scale?: number; seconds?: number; animation?: string }>;
}

/**
 * A slide on a `screen`. Layouts: plain (default: `title` big, `text` under it), quote (`title` as a quote,
 * `text` who said it), code (a terminal: `text` lines in monospace, "$ " lines as commands), chat (`title` a channel,
 * `text` lines as messages; a line starting with "~" is crossed out), band (a terminal with a status band in
 * `color` saying `title`, `text` as prompt lines). *Words* between stars are in the accent colour; `stamp` is a
 * red rubber stamp slammed across it a moment after it appears ("BLOCKED").
 */
export interface Slide {
  at?: string;
  wait?: number;
  layout?: 'plain' | 'quote' | 'code' | 'chat' | 'band';
  title?: string;
  text?: string;
  stamp?: string;
  color?: string;
}

/**
 * A camera shot: framed by meaning (`frame`: the objects to fit, default all; `angle`; `distance`), or placed exactly
 * (`position` and `target`, which win). In `shots`, the camera glides there from `at`, over `seconds` (default 1.2).
 */
export interface Shot {
  at?: string;
  wait?: number;
  frame?: string | string[];
  /** three-quarter (default: front, a little to the right and above), front, side, back, top, high or low. */
  angle?: 'three-quarter' | 'front' | 'side' | 'back' | 'top' | 'high' | 'low';
  /** close, medium (default) or wide. */
  distance?: 'close' | 'medium' | 'wide';
  position?: [number, number, number];
  target?: [number, number, number];
  /** Vertical field of view in degrees (default 35). */
  fov?: number;
  seconds?: number;
}

export interface RoadMove { move: 'ride' | 'wheelie' | 'stall' | 'push' | 'launch'; at?: string }
/** A number that counts up from 0: "4.0 m" by tenths, "10:00" as minutes and seconds. */
export interface Readout { id: string; value: string; label?: string }

export interface Column { title: string; tone?: Tone; items: Item[] }
export interface Step { id: string; label: string; detail?: string }

/** A figure: `value` counts up to its number ("5 min", "$3"), over `label`, under an animated `icon`. */
export interface Figure { id: string; value: string; label?: string; icon?: 'clock' | 'money'; tone?: Tone }

/** A cycle node: a label, an optional detail line and picture (relative to the project folder); a `sink` is drawn as a drain things go into. */
export interface CycleNode { id: string; label: string; detail?: string; image?: string; tone?: Tone; sink?: boolean }
/** An arrow between two nodes (by id), drawn at `at`; `carry`: a faded copy of the `from` node rides it into `to`. */
export interface CycleArrow { from: string; to: string; at?: string; label?: string; carry?: boolean }
/** A timeline step: its marker's `label`, the `items` it shows big, and a `note` under the marker once it lands. */
export interface TimelineStep { id: string; label: string; items?: string[]; at?: string; light?: string; land?: string; note?: string }

/**
 * An underline that grows under words printed in a picture as the voice reaches `at`. The words are found by OCR
 * (npm run render); `box`: [x0, y0, x1, y1] as fractions of the picture places it by hand instead.
 */
export interface Mark { text: string; at?: string; box?: [number, number, number, number] }
/** A box on a picture, as fractions of its width and height. */
export interface MarkBox { x0: number; y0: number; x1: number; y1: number }

/**
 * A cue fires at its beat's start, or when the voiceover reaches the `at` phrase: it shows elements (by id) and/or
 * points the narrator at one (pointing also shows it and lights it up; null lowers the stick), and can change how
 * elements on screen look.
 */
export interface Cue {
  at?: string;
  /** Several `show` ids appear one by one, evenly spaced from `at` to this phrase (without it, a moment apart); a `blink` ends here. */
  until?: string;
  show?: string | string[];
  point?: string | null;
  /** From here until the next `spot`: these elements lift and glow while the scene's others dim ("all": all lit; null: back to normal). */
  spot?: string | string[] | null;
  /** The element's glow pulses about three times a second, until `until` (default: three pulses), e.g. while it acts. */
  blink?: string;
  /** A chip with `text` pops up beside the element `on`, which pulses ("+3", "x2", "free"). */
  note?: { on: string; text: string };
  /** The element turns a quarter and shrinks (spent, used up)... */
  spend?: string;
  /** ...and turns back (refreshed). */
  restore?: string;
  /**
   * A phone notification (an app name `from`, a bold `title`, a line of `text`) slides down near the top (under the
   * heading), and back up at `until` (default 3 s later, or when the next one comes).
   */
  alert?: { from?: string; title: string; text?: string };
  /** With an image narrator: its picture from here on (a file in the project folder). */
  narrator?: string;
}

/** A beat: a few sentences of voiceover spoken over one scene. Each beat is a scene of the finished video. */
export interface Beat {
  id: string;
  text: string;
  scene: Scene;
  cues?: Cue[];
  /** Voice speed for this beat only, e.g. a calmer ending (default: the script's). */
  speed?: number;
  /** ElevenLabs delivery for this beat only: higher stability and lower style calm it down. */
  stability?: number;
  style?: number;
  /** Extra silence after the beat, so its last picture stays up (music swells in pauses over 700 ms). */
  holdMs?: number;
  /** Elements identical to the previous scene's (same id and text) glide to their new place instead of fading (default true). */
  carry?: boolean;
}

/**
 * A Kokoro voice made of other voices' style vectors (src/tts.ts): weights per voice for the timbre half and the
 * delivery (prosody) half; each half's weights sum to 1, and negative ones push away from a voice.
 */
export interface VoiceMix { timbre: Record<string, number>; prosody: Record<string, number> }

/** An ElevenLabs voice (src/elevenlabs.ts): a voice from the account's library, a model and its voice settings. */
export interface ElevenVoice {
  voiceId: string;
  /** For logs, e.g. "Angus (Glasgow)". */
  name?: string;
  model: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  /** 0.7-1.2; a beat's own `speed` wins. */
  speed?: number;
  /**
   * Drafts (npm run voice without --final) use the free Kokoro narrator at this speed instead, set so a draft runs about
   * as long as this voice does; a beat's own `speed` scales it by speed / this voice's speed.
   */
  draftSpeed?: number;
}

export interface Theme { bg: string; panel: string; line: string; text: string; muted: string; accent: string; yes: string; no: string }

/** projects/<name>/script.json */
export interface Script {
  /** Working title, for logs and the review page. */
  title?: string;
  /** Default 16:9. */
  format?: Format;
  /**
   * The narrator character, who goes to what's being said and points at it: true (default) is a round figure that hops
   * and points with a stick; "cab" is a black cab that drives over and points with its headlight beam; false is none;
   * `{ image }`: the round figure's hop and stick with a picture from the project folder for a body, and a small mouth.
   */
  narrator?: boolean | 'cab' | { image: string };
  /** Word-by-word captions burned in; default true for 9:16, false otherwise. */
  captions?: boolean;
  /** Colours over the default dark theme. */
  theme?: Partial<Theme>;
  /**
   * Kokoro voice (a voice name, or `mix`, which wins over name; default the stack's narrator voice), or a paid ElevenLabs
   * voice, which speaks only with npm run voice -- <name> --final (until then a free Kokoro draft paced like it).
   */
  voice?: { name?: string; mix?: VoiceMix; speed?: number } | { elevenlabs: ElevenVoice };
  /** Video starts on the first scene already in place, no fade from black (default true). */
  coldOpen?: boolean;
  /**
   * Pronunciations for the voice only, e.g. {"quinoa": "keenwah"} or exact phonemes {"quinoa": "/kˈiːnwɑː/"} (Kokoro only:
   * ElevenLabs reads respellings); captions keep the real word.
   */
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
  /** Who spoke it, e.g. "ElevenLabs Angus (eleven_v4, ...)". */
  voice?: string;
  /** A Kokoro stand-in for the script's ElevenLabs voice: fine for review, not for posting. */
  draft?: boolean;
  durationMs: number;
  beats: TimelineBeat[];
}
