# VideoLab specification

VideoLab turns a prompt into a finished video. An AI agent writes a script (narration split into beats, each beat
showing one scene); the stack voices it, times every word, animates the scenes in sync with the voice, mixes music,
renders, and puts the result on a review page. Everything runs locally with free tools.

This document is the reference: architecture, every file format, every command, and how to extend the stack.
[AGENTS.md](../AGENTS.md) is the operating guide (the workflow an agent follows from prompt to video).

## Contents

1. [Architecture](#1-architecture)
2. [Project layout](#2-project-layout)
3. [The script (`script.json`)](#3-the-script-scriptjson)
4. [Scene kit](#4-scene-kit)
5. [Cues and timing](#5-cues-and-timing)
6. [The narrator](#6-the-narrator)
7. [Voice](#7-voice)
8. [Music and loudness](#8-music-and-loudness)
9. [Rendering](#9-rendering)
10. [Review](#10-review)
11. [Posting kit](#11-posting-kit)
12. [The engine](#12-the-engine)
13. [Extending the stack](#13-extending-the-stack)
14. [Commands](#14-commands)
15. [Limits and known behaviour](#15-limits-and-known-behaviour)
16. [Licenses](#16-licenses)

## 1. Architecture

```
prompt ──► agent writes projects/<name>/script.json
                │
   npm run voice│  Kokoro TTS speaks each beat ─► build/voice/<beat>.wav
                │  whisper.cpp times every word ─► build/timeline.json
                ▼
  npm run render│  --sheet: one frame per scene in a grid (check layouts in seconds)
                │  bundle src/video (esbuild) ─► headless Chromium draws each frame (React)
                │  ─► JPEG frames ─► ffmpeg (H.264) ; soundtrack mixed in Node ─► loudness -14 LUFS
                ▼
          out/<name>.mp4 + .preview.mp4 (+ out/scenes/ per-scene clips)
                │
   review page  │  docker compose up -d ─► http://localhost:8796 (phone-friendly)
                ▼
    npm run kit │  titles, descriptions, tags per platform + cover image
```

| Part | Files | What it does |
|---|---|---|
| Script | `projects/<name>/script.json`, `src/types.ts` | The agent's input: format, voice, music, beats, scenes, cues |
| Voice | `src/voice.ts`, `src/tts.ts`, `src/phonemes.ts`, `src/whisper.ts`, `src/voicelab.ts` | Kokoro speech per beat, exact pauses, pronunciation fixes, word timing, voice comparisons |
| Composition | `src/video/` | The `Video` composition: scene kit, narrator, captions, music ducking |
| Engine | `src/engine/` | Our own React video renderer: frame clock, animation math, bundling, capture, encoding, audio mix, studio |
| Render | `src/render.ts` | Levels, music prep, whole or scene-by-scene render, loudness, previews, contact sheets |
| Music | `src/music.ts`, `src/music_gen.py`, `src/loop.ts`, `src/video/music.ts` | Optional generated tracks (ACE-Step), seamless loops, ducking under the voice |
| Review | `serve/`, `docker-compose.yml` | A static page over `out/`: new cuts, changed scenes, voice previews, posting kits |
| Kit | `src/kit.ts` | Posting text per platform with limit checks, and a cover image |

The pipeline is deterministic: the same script, timeline and code draw the same frames, which is what makes
scene-by-scene re-rendering (only what changed) possible.

## 2. Project layout

```
projects/<name>/
  script.json            the script (written by the agent)
  kit.json               posting text (optional, written by the agent)
  assets/                pictures the image scenes show (optional)
  build/                 generated, not in git:
    voice/<beat>.wav     the voiceover, one file per beat (24 kHz mono 16-bit), plus <beat>.16k.wav for whisper
    timeline.json        every beat's start/end and every word's time
    levels.json          voice loudness per frame (the narrator's mouth)
    music.wav, music.json  the prepared background track and its gain
    render.mp4, render.wav the raw render and its soundtrack
    scenes/              one clip per scene, named by fingerprint (scene-by-scene rendering)
music/                   background tracks (not in git; your own or generated)
out/                     everything for review (not in git; served by the review page)
  <name>.mp4             the finished video (-14 LUFS, H.264 + AAC)
  <name>.preview.mp4     the same at 720p on the shorter side, for phones
  <name>.sheet.png       contact sheet
  <name>.<a-b>.mp4       a part (--beats)
  scenes/                the scenes the last scene-by-scene render re-rendered + scenes.json
  previews/              voice previews (npm run voice -- <name> --only ...) + previews.json
  voice-lab/             voice comparisons + samples.json
  <name>.kit.json, <name>.cover.jpg   the posting kit
.cache/                  whisper.cpp + model, engine bundles, previews scratch (not in git)
```

A project name is a folder name: lowercase letters, digits and dashes (`how-bees-make-honey`).

## 3. The script (`script.json`)

```jsonc
{
  "title": "How bees make honey",          // optional, for logs and the review page
  "format": "16:9",                         // "16:9" (1920x1080, default) | "9:16" (1080x1920) | "1:1" (1080x1080)
  "narrator": true,                         // the narrator character (default true)
  "captions": false,                        // burned-in word-by-word captions (default: true for 9:16, else false)
  "theme": { "accent": "#ffb238" },         // optional colour overrides (see Theme)
  "voice": { "name": "am_michael", "speed": 1.1 },  // optional (see Voice)
  "say": { "quinoa": "keenwah" },           // optional pronunciation fixes (see Voice)
  "music": { "track": "calm-loop.wav", "volume": 0.3, "duck": 0.35 },  // optional (see Music)
  "beats": [
    {
      "id": "intro",                        // unique; letters, digits, dashes (it names files and scenes)
      "text": "Honey starts as flower nectar... and bees turn it into one of the few foods that almost never spoils.",
      "scene": { "type": "title", "title": "How bees make honey", "subtitle": "From flower to jar" },
      "cues": [
        { "show": "title" },
        { "at": "almost never spoils", "point": "subtitle" }
      ]
    }
  ]
}
```

`projects/example/script.json` uses every scene type; copy it to start a project.

### Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | string | project name | Working title |
| `format` | `"16:9"` \| `"9:16"` \| `"1:1"` | `"16:9"` | Frame size; every layout adapts |
| `narrator` | boolean | `true` | Show the narrator character |
| `captions` | boolean | `format == "9:16"` | Burn in captions (a page of a few words, the spoken one highlighted) |
| `theme` | object | dark theme | `bg`, `panel`, `line`, `text`, `muted`, `accent`, `yes`, `no` (CSS colours) |
| `voice` | `{ name?, mix?, speed? }` | narrator voice, speed 1.12 | Kokoro voice (section 7) |
| `say` | `{ word: spoken }` | none | Pronunciations for the voice only; captions keep the real word |
| `music` | `{ track, volume?, duck?, startMs? }` \| `null` | none | Background track in `music/` (section 8) |
| `beats` | Beat[] | required | The video, in order |

### Beat

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique. Names the voice file, the scene and its clip |
| `text` | string | What the voice says over this scene: 1-3 natural sentences, 5-15 seconds |
| `scene` | Scene | What's on screen (section 4) |
| `cues` | Cue[] | When elements appear and what the narrator points at (section 5) |

Each beat is one scene of the finished video. A video is typically 4-12 beats for a 30-90 s short; long-form is
the same structure with more beats.

## 4. Scene kit

Every scene type lays itself out from its data for any format, fits text to its boxes, and gives each element an id
for cues. Elements no cue names appear when the scene starts; cued elements pop in at their first cue.

| Type | Data | Element ids | Use |
|---|---|---|---|
| `title` | `title`, `subtitle?` | `title`, `subtitle` | Openers, chapter titles |
| `text` | `text?` (default: the beat's own words) | `text` | A statement, a quote, a closing line |
| `points` | `heading?`, `items: Item[]` | `heading`, item ids | Lists, reasons, features (2-6 items) |
| `compare` | `left: Column`, `right: Column` | `left`, `right` (column titles), item ids | Before/after, myth/fact, A vs B |
| `flow` | `heading?`, `steps: Step[]` | `heading`, `slots`, step ids | Processes, pipelines, timelines (2-6 steps) |
| `image` | `src`, `caption?`, `regions?` | `image`, `caption`, region ids | Pictures, maps, charts, diagrams |

```ts
Item   = { id: string; text: string; tone?: 'yes' | 'no' | 'accent'; strike?: boolean }
Column = { title: string; tone?: 'yes' | 'no' | 'accent'; items: Item[] }
Step   = { id: string; label: string; detail?: string }
```

- **title**: centred big type; the subtitle is in the accent colour.
- **text**: centred, sized to fill the stage. Keep it under ~25 words.
- **points**: a column of panels with a coloured bullet; `tone` colours the bullet and the glow, `strike: true`
  crosses an item out just after it appears.
- **compare**: two columns side by side (in every format), column titles in capitals in the column's `tone`. A column
  title appears at its own cue, else with its first item. Item ids must be unique across both columns.
- **flow**: numbered panels joined by arrows: a row on 16:9, a column on 9:16 and 1:1. Cue `"show": "slots"` to draw
  dashed outlines of every step first, then each step fills its outline as it's named; the arrow into a step draws
  just before it.
- **image**: `src` is relative to the project folder (`assets/map.png`) or an `https://` URL (avoid: renders need the
  network). PNG, JPEG, WebP or SVG. The picture is fitted inside the stage keeping its shape; `caption` goes under it.
  `regions` are named parts of the picture as `[x, y, width, height]` fractions of the picture
  (`{"lake": [0.1, 0.4, 0.3, 0.2]}`); pointing at a region lights it up, showing it outlines it.

**Text sizes** are fitted automatically (Montserrat ExtraBold, estimated by character count), so long text shrinks
rather than overflows. Short text reads better: items and step labels under ~35 characters, headings under ~40.

**Theme** (defaults): `bg #11131f`, `panel #1b1f31`, `line #2f3552`, `text #eef0ff`, `muted #8d93b8`,
`accent #ffb238`, `yes #7ce0c3`, `no #ff5d6c`. The background has a faint grid and a vignette.

**Stage**: content stays inside 5% side margins and a 7% top margin, above the narrator's strip along the bottom
(when the narrator is on) and above the captions band (when captions are on). Layouts use a unit of 1 px at 1080 px
on the frame's shorter side, so 16:9, 9:16 and 1:1 look alike in proportion.

## 5. Cues and timing

```ts
Cue = { at?: string; show?: string | string[]; point?: string | null }
```

- `at`: a phrase from the beat's `text`. The cue fires when the voice starts saying it (matched against whisper's
  words, ignoring case and punctuation; the first occurrence wins). Without `at`, the cue fires at the beat's start.
  A phrase that isn't found logs a warning and fires at the beat's start: re-check the wording after edits.
- `show`: element id(s) to make appear.
- `point`: the narrator hops to the element and points at it; it also appears and lights up. `null` lowers the stick.
- Unknown element ids stop the render with the list of valid ids.

Timing rules:
- A beat's scene appears 6 frames (0.2 s) before its voice and fades over 8 frames; the next scene takes over 6 frames
  before the next beat's voice.
- The narrator times each hop to land 2 frames before its cue, so the stick touches the element as the word is
  spoken. Cues closer than ~0.4 s apart make it hurry; spread them over the sentence.
- A beat that points at nothing for its first 1.2 s sends the narrator home first.
- The video ends 1.2 s after the last word.
- Before `npm run voice` has run, timing is estimated (~2.7 words/s), so sheets and the studio work from the first
  draft; the real timeline replaces it.

## 6. The narrator

A round orange character drawn in SVG (`src/video/Narrator.tsx`), planned in `src/video/plan.ts`:

- It rests at its **home** (bottom centre) and hops (with squash and stretch) to a spot next to what it points at,
  choosing in order: where it stands (if in reach and clear), below the element, beside it, diagonally below, or on
  its own row under it pointing up with a longer stick; standing above an element is a last resort. It never stands
  on an element or below its home row (so it stays clear of captions).
- It points with a stick (an overshooting extend), looks where it's going and at what it points at, blinks every
  2-5 s (restarting each scene), and moves its mouth with the voice's loudness (`build/levels.json`, one value per
  frame, written by `npm run render`).
- `"narrator": false` hides it; cues still light elements up.

## 7. Voice

`npm run voice -- <name>` speaks every beat with **Kokoro** (82M parameters, runs on the CPU) and times every word with
**whisper.cpp** (base.en), writing `build/voice/<beat>.wav` and `build/timeline.json`.

- **Narration style**: smooth, natural sentences joined with commas and "and"; plain periods. At most one `...` (a
  dramatic 450 ms pause, e.g. in the hook); `..` is a short 250 ms pause, only where words would run together (a list
  of names). Question-and-answer delivery and pause-heavy lines sound unnatural. One idea per beat; show each thing the
  moment it's named.
- **Pauses**: a phrase ending in `...` or `..` is spoken on its own and joined to the next with exact silence, so a
  pause never clips a word. A beat starts with 150 ms of lead-in; beats are 250 ms apart.
- **Pronunciation**: `say` respells a word for the voice only (`{"Nguyen": "Win"}`), or gives exact phonemes between
  slashes (`{"quinoa": "/kˈiːnwɑː/"}`, espeak/Kokoro IPA; `ˈ` primary and `ˌ` secondary stress before the syllable).
  Respellings can't move stress; phonemes can. Matching is per word, case-insensitive, inner hyphens and apostrophes
  included.
- **Checking**: the log prints what whisper heard per beat; a misheard word often means a mispronounced one (or a
  homophone: "flour" for "flower" is fine). The ear decides: `--only intro,why` writes previews of those beats to
  `out/previews/` (on the review page) without touching `build/`; `--try "text"` (repeatable, with one `--only` beat)
  previews alternative wordings; `--note` adds a note for the listener.
- **Voices**: `voice.name` is a Kokoro voice (`am_michael`, `am_fenrir`, `af_heart`, `af_bella`, `bf_emma`,
  `bm_george`, ...); `voice.mix` blends voices: `{"timbre": {"am_michael": 1}, "prosody": {"am_fenrir": 1}}` takes the
  sound of one voice and the delivery of another (weights per half sum to 1). The default narrator is that mix at speed
  1.12. `npm run voicelab -- <name> [--beats a,b]` renders the same lines in a set of voices and mixes to
  `out/voice-lab/` for comparison; put the chosen one in `script.json` `voice`.
- **Alignment**: whisper's words are matched to the script's words by edit distance; unmatched words are spread over
  the gap between their neighbours. Captions show the script's spelling.

## 8. Music and loudness

- `music.track` is a file in `music/` (any format ffmpeg reads). `npm run render` copies it to `build/music.wav` and
  measures the gain that brings it to -20 LUFS, so `volume` means the same for any track.
- `volume` (default 0.3) is the level while the voice is silent; `duck` (default 0.35) multiplies it under speech
  (150 ms attack before a word, 500 ms release, gaps under 700 ms stay ducked); it fades in over 400 ms and out over
  1.5 s at the end. `startMs` skips into the track.
- A track shorter than 75% of the video loops (make loops seamless with `npm run loop`); a longer one plays once and
  fades out at the end of the video or of the track.
- The final mix (voice + music) is normalized to **-14 LUFS**, true peak -1.5 dB (two-pass loudnorm, linear when the
  peaks allow): what YouTube, TikTok and Instagram play at.
- `npm run music -- [--style speed-metal | --prompt "..."] [--seconds 16] [--bpm 140] [--count 3]` generates
  instrumental tracks locally with **ACE-Step 1.5** (first run installs it into `.cache/ace-step`: ~10 GB of models,
  needs `uv` and a GPU for reasonable speed). Describe the sound in prose (instruments, playing, production); don't
  name artists. `npm run loop -- music/<track>.wav [--bpm 165] [--bars 8]` cuts a seamless loop of whole bars (tempo
  change with rubberband, pitch kept).
- Use only music you have the rights to: your own, generated, or licensed for commercial use. No music is the default.

## 9. Rendering

`npm run render -- <name>` renders the whole video in one pass: about 50 frames a second for 16:9 diagram scenes on a
16-thread PC (a 60 s video in about a minute).

| Option | Effect |
|---|---|
| `--sheet` | Only `out/<name>.sheet.png`: one frame of each scene, 70% into it, labelled, in a grid. Seconds. Check this first |
| `--sheet --frames 30,240` | The sheet of chosen frames instead |
| `--beats a,b` | Only those beats, back to back, to `out/<name>.<a-b>.mp4` (a part to review) |
| `--scenes` | Scene by scene: re-render only the scenes that changed (below) |
| `--scenes a,b` | Scene by scene, re-rendering those scenes even if unchanged |
| `--fresh` | Scene by scene, re-rendering every scene |

**Scene by scene** works like a film shoot: each beat is a scene rendered to its own clip, and the clips are joined.
Before rendering, a dry run over every frame fingerprints what each frame draws (a hash of its DOM, plus the content
of the files it shows, the bundle's assets, Chromium's version and the encoder settings). A clip is named by its
scene's fingerprint, so a scene re-renders only when one of its frames would look different, whether the change was
its text, its timing or the code; a scene that only moved in time (an earlier one got longer) is reused. Clips are
joined without re-encoding, and the soundtrack is always mixed whole, so music and ducking never seam at a cut.
Clips no scene uses any more are deleted. The scenes that were re-rendered also go to `out/scenes/` with their sound
and text, so a reviewer watches only what changed. Re-running with nothing changed takes ~25 s (previews and
loudness); one changed scene adds its own render time.

What a fingerprint can't see: anything drawn outside the DOM (a canvas) and font files set up in code (they change
with the bundle's assets anyway). `--fresh` covers those. Drawing that depends on absolute time should count from its
scene's start (the narrator's blinks do), or every later scene re-renders when an earlier one changes length.

**Encoding**: JPEG frames (quality 90) captured over the Chrome DevTools Protocol, H.264 (x264, CRF 18, preset
medium) kept in Chrome's full-range BT.601 YUV and tagged so (converting to limited-range BT.709 measured 1.5-2.5
levels off). Audio AAC 192 kbps, 48 kHz. Previews are 720 px on the shorter side, CRF 28.

**Stills**: `npm run still -- Video out/frame.png --frame=120 --props='{"project":"<name>"}'` (`.jpg` for JPEG).

## 10. Review

- **Review page**: `docker compose up -d` serves `out/` with nginx at http://localhost:8796 (any device on the network:
  `http://<machine address>:8796`). Tabs: **Review** (new cuts without a posting kit, re-rendered scenes with their
  lines, voice previews), **To post** and **Published** (posting kits with copy buttons), **Voice lab**, **Files**.
  Restart the container after editing `serve/index.html` (`docker compose restart`): the page is a single bind-mounted
  file.
- **Studio**: `npm run studio [-- --port 3000 --host 0.0.0.0]` opens a live preview at http://localhost:3000: pick the
  composition, set props (`{"project": "<name>", "beats": ["intro"]}`), scrub or play with sound. Keys: space
  play/pause, left/right one frame, shift+left/right one second, home/end. It rebuilds and reloads on code changes and
  keeps its place in the URL.
- **Contact sheet**: `--sheet` (above): the cheapest way for an agent to see a whole video (one image).

## 11. Posting kit

`projects/<name>/kit.json` (all platforms optional, at least one):

```json
{
  "cover": { "at": 4.5 },
  "youtube": { "title": "How bees make honey", "description": "...", "tags": ["bees", "honey"] },
  "instagram": { "caption": "... #bees #honey" },
  "tiktok": { "caption": "... #bees" },
  "published": "2026-11-02"
}
```

`npm run kit -- <name>` checks the limits (YouTube title 100 characters and no `<` `>`, description 5000, tags 500
counted YouTube's way; Instagram caption 2200 and at most 5 hashtags; TikTok caption 4000), renders the cover (the
frame at `cover.at` seconds, JPEG), and writes `out/<name>.kit.json`; the review page shows it under To post, or
Published once `published` is set. Credits for pictures and music (section 16) belong in the descriptions.

## 12. The engine

`src/engine/` is a small React video renderer (no Remotion: its API is modeled on Remotion's, so its patterns apply).
A composition is a React component that draws one frame; the engine tells it which.

**Component API** (`import { ... } from '../engine/index.ts'`):

| API | Meaning |
|---|---|
| `useCurrentFrame()` | The frame, counted from the enclosing `Sequence` |
| `useVideoConfig()` | `{ width, height, fps, durationInFrames }` |
| `<Sequence from durationInFrames layout?>` | Shows children in that span, with their frame counted from `from`; fills the parent unless `layout="none"` |
| `<Freeze frame>` | Children see a fixed frame (their audio is silent) |
| `<AbsoluteFill>` | A full-size flex column |
| `<Img>` | An image; frames wait until it's decoded, a failed load stops the render |
| `<Audio src volume? trimBefore? loop?>` | Sound from the sequence's start; `volume` may be a function of the frame |
| `staticFile(path)` | URL of a file under `projects/` |
| `interpolate(x, inRange, outRange, { easing, extrapolateLeft, extrapolateRight })` | Piecewise mapping; extrapolation `extend`, `clamp`, `identity`, `wrap` |
| `spring({ frame, fps, config: { damping, mass, stiffness, overshootClamping }, from, to, delay })` | Exact damped spring |
| `Easing` | `linear quad cubic poly(n) sin circle exp back(s) elastic(b) bounce bezier(x1,y1,x2,y2) in out inOut ease` |
| `random(seed)` | Deterministic 0-1 |
| `loadFont(family, { weight: url })` | Registers a font; frames wait for it |
| `delayRender(label)` / `continueRender(handle)` | Hold frames until async work is done |
| `composition({ id, component, width, height, fps, durationInFrames, defaultProps, calculateMetadata })` | A composition; `calculateMetadata({ props })` returns size, length, props and `scenes: [{ id, from }]` |
| `registerRoot(compositions)` | The entry (`src/video/index.ts`) |

Rules for components: draw purely from the frame and props (no `Date.now()`, `Math.random()`, timers or effects
that change what's drawn), so any frame can be drawn alone and in any order.

**How a render works** (`render.ts`): esbuild bundles `src/video/index.ts` (`.cache/engine/bundle`); a local server
(`server.ts`) serves it, `projects/` at `/static/` and the bundle at `/bundle/`; Playwright's headless Chromium opens
the page in N tabs (half the CPU threads, at most 8); for each frame a tab sets the frame (`flushSync`), waits for
fonts, `delayRender` locks and every `<img>` to decode, and captures a JPEG; frames are written to ffmpeg in order.
The page applies `* { box-sizing: border-box }`.

**Sound** (`audio.ts`): a dry run over every frame in a hidden copy of the composition collects each `Audio`'s start,
trim, loop and volume per frame; Node decodes the files (ffmpeg) and sums them into a 48 kHz stereo float WAV (volume
glides between frames).

**ffmpeg** comes from `ffmpeg-static` (6.1, full build: `loudnorm`, `rubberband`, `fps`, `tile`), wrapped by
`src/engine/ffmpeg.ts` (`ffmpeg`, `measureLoudness`, `decodeAudio`, `floatWav`) for every script.

## 13. Extending the stack

**A new scene type** (`src/video/scenes.tsx`):
1. Add its data shape to the `Scene` union in `src/types.ts`.
2. Write a `SceneDef`: `layout(scene, beat, stage)` returns `{ anchors: { id: Box }, fonts: { id: size } }` using
   `stage.content` (the box to fill), `stage.u` (unit), `stage.wide` (row or column); `Component` draws from
   `layout`, popping each element in at `shown(id)` and lighting it with `pointed(id)` (0-1). Reuse `Panel`, `Words`,
   `Text`, `Arrow`, `Strike`, `fitFont`, `textHeight`.
3. Register it in `SCENES` and list its element ids in `elementIds` (`src/video/plan.ts`).
4. Check it with `--sheet` in all three formats, then document it in section 4.

**A new composition** (another kind of video, e.g. footage-based): write a component and add it to `compositions` in
`src/video/Root.tsx` with a `calculateMetadata` that loads its data and returns `scenes`; `src/render.ts` renders the
`Video` composition, so pass another id there (or add an option).

**Another voice**: anything that writes `build/voice/<beat>.wav` (16-bit mono) and `build/timeline.json` works with
the rest; `src/whisper.ts` times any voice recording.

## 14. Commands

| Command | What it does |
|---|---|
| `npm run voice -- <name> [--only a,b [--try "text"] [--note "..."]] [--voice v] [--speed s]` | Voice + word timing; previews with `--only` |
| `npm run voicelab -- <name> [--beats a,b]` | Compare voices on the same lines |
| `npm run render -- <name> [--sheet [--frames ...]] [--beats a,b] [--scenes [a,b]] [--fresh]` | Render (section 9) |
| `npm run kit -- <name>` | Posting kit + cover |
| `npm run studio [-- --port 3000 --host 0.0.0.0]` | Live preview |
| `npm run still -- <Composition> <out.png\|.jpg> [--frame=N] [--props=JSON]` | One frame |
| `npm run music -- [...]` / `npm run loop -- music/<track>.wav [--bpm n]` | Generate music / make loops |
| `npm run typecheck` | TypeScript check |
| `docker compose up -d` | Review page on port 8796 |

Scripts run with plain `node` (Node 22.18+ strips TypeScript types); there is no build step besides esbuild's bundle
of the video code, which the renderer does itself.

## 15. Limits and known behaviour

- English narration: whisper's model is `base.en` and the default voices are English.
- The scene kit draws diagrams, text and still pictures; video clips inside scenes aren't supported yet (no `<Video>`
  in the engine).
- Text fitting estimates glyph widths; very long words in narrow boxes may still crowd.
- whisper.cpp 1.5 has to be installed by hand (README); the model downloads itself.
- Renders take RAM (each Chromium tab ~150-300 MB); lower the tab count with the engine's `concurrency` option on
  small machines.
- Colours are encoded full-range BT.601, which every major platform handles; some hardware players ignore the range
  flag.

## 16. Licenses

The stack itself has no usage conditions:

| Component | License |
|---|---|
| Kokoro (model and voices), kokoro-js, transformers.js, Playwright, TypeScript | Apache-2.0 |
| whisper.cpp and the Whisper model, React, esbuild, ONNX Runtime | MIT |
| Montserrat (`@fontsource/montserrat`) | SIL OFL 1.1 (free in videos, commercially too) |
| Chromium | BSD-3-Clause and others |
| ACE-Step 1.5 (optional music generation, installed on first use) | MIT |
| ffmpeg (`ffmpeg-static`), eSpeak NG (inside `phonemizer`) | GPL-3.0: conditions apply only to distributing the software, not to the videos it makes |
| libvips (inside `sharp`, used by transformers.js) | LGPL-3.0: same |

The tools used around it have their own terms: Docker Desktop (free for personal use and small businesses) serves the
review page, and any web server can replace it.

**Content you put in videos** has its own rights, and the agent is responsible for them:
- Pictures: your own, generated, public domain or CC0 need nothing; CC BY needs credit (author, license, link, and
  "cropped" if cropped) in the description; CC BY-SA also needs credit, and an adapted picture stays BY-SA. Avoid
  NonCommercial (NC) material for monetized videos, and anything without a clear license (most images on the web).
- Music: your own, generated, or licensed for commercial use; Creative Commons ShareAlike music synced to video makes
  the whole video ShareAlike.
- Facts: check them against reliable sources; a script that teaches something wrong is the worst failure.
- Platform rules: monetization programs reward original, varied videos; templated, repetitive uploads at volume risk
  losing monetization.
