# VideoLab

Make videos from a prompt. An AI agent writes a script; VideoLab voices it, times every word, animates diagram
scenes in sync with the voice (with a narrator character who points at what's being said), mixes music, renders the
video and puts it on a review page you can open on your phone. Everything runs locally with free tools.

- **Any shape**: 16:9 for YouTube, 9:16 for Shorts, Reels and TikTok (with burned-in captions), 1:1.
- **Scenes from data**: titles, lists, comparisons, step flows, pictures with regions to point at, statements. The
  agent writes JSON; layouts and text sizes adapt to the frame.
- **Voice**: Kokoro text-to-speech with voice blending, exact pauses and pronunciation fixes; whisper.cpp word timing.
- **Own renderer**: React frames drawn in headless Chromium and encoded with ffmpeg; scene-by-scene rendering
  re-renders only the scenes that changed.
- **Review loop**: contact sheets in seconds, a live studio with sound, a phone-friendly review page, posting kits.

Agents: start with [AGENTS.md](AGENTS.md). The full reference is [docs/SPEC.md](docs/SPEC.md).

## Setup

Requirements: Node 22.18 or newer, ~1 GB of disk for models, Docker (optional, for the review page).

```
npm ci
npx playwright install chromium
```

whisper.cpp (word timing) is installed by hand into `.cache/whisper/`:
- Windows: unzip `whisper-bin-x64.zip` from
  [whisper.cpp v1.5.4](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.5.4) into `.cache/whisper/`.
- Linux/macOS: `git clone --branch v1.5.4 https://github.com/ggml-org/whisper.cpp .cache/whisper && make -C .cache/whisper main`.

The Kokoro voice model and the whisper model download themselves on first use.

## Make the example

```
npm run voice -- example                 # voice + word timing  -> projects/example/build/
npm run render -- example --sheet        # one frame per scene  -> out/example.sheet.png
npm run render -- example --scenes       # the video            -> out/example.mp4 (+ .preview.mp4)
docker compose up -d                     # review page          -> http://localhost:8796
npm run studio                           # live preview         -> http://localhost:3000
```

A new video is a new folder: `projects/<name>/script.json` (copy the example), then the same commands.

## Commands

| Command | |
|---|---|
| `npm run voice -- <name> [--only a,b]` | Voice and word timing (`--only`: previews of some beats) |
| `npm run voicelab -- <name>` | Compare voices on the same lines |
| `npm run render -- <name> [--sheet] [--beats a,b] [--scenes] [--fresh]` | Render (or a contact sheet) |
| `npm run kit -- <name>` | Posting kit (titles, descriptions, tags, cover) |
| `npm run studio` | Live preview with sound |
| `npm run still -- Video out.png --frame=N --props='{"project":"<name>"}'` | One frame |
| `npm run music -- --prompt "..."` / `npm run loop -- music/x.wav` | Generate music (ACE-Step) / make loops |

## Licenses

The stack uses permissively licensed parts (Apache-2.0, MIT, BSD, OFL); ffmpeg and eSpeak NG are GPL, which applies
to distributing the software, not to the videos. Content rights (pictures, music, facts) are covered in
[docs/SPEC.md](docs/SPEC.md#16-licenses).
