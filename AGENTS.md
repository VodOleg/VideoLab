# Operating VideoLab (for AI agents)

VideoLab is operated by an AI agent: a person asks for a video in plain words, and the agent writes the script, runs
the pipeline, checks its own work, and hands over a link to review. This is the workflow and the rules. The full
reference (file formats, scene kit, commands, engine) is [docs/SPEC.md](docs/SPEC.md); read the relevant section
before changing a file format or the code.

## The workflow

### 1. Understand the request

Settle these before writing, from the prompt or with at most one round of questions (pick sensible defaults rather
than asking about everything):

- **Subject and angle**: what the video is about, and the one thing a viewer should remember.
- **Format and length**: a 9:16 short (30-60 s, captions on) for Shorts/Reels/TikTok, a 16:9 video for YouTube, or 1:1.
- **Audience and tone**: who it's for; plain and friendly unless asked otherwise.
- **Voice and music**: default narrator and no music unless asked; offer the voice lab if the voice matters.
- **Sources**: where the facts and pictures come from, and their rights (SPEC section 16).

### 2. Write the script

Create `projects/<name>/script.json` (copy `projects/example/script.json`; the format is SPEC section 3).

- **Hook first**: the first beat states the most surprising or useful thing, in one sentence.
- **One idea per beat**, 5-15 seconds of speech each. Shorts: 4-8 beats. Long-form: chapters of 3-6 beats, each
  chapter opened by a `title` scene.
- **Narration style**: smooth, natural sentences joined with commas and "and"; plain periods. At most one `...`
  dramatic pause per video; `..` only where words would run together. No question-and-answer delivery, no
  pause-heavy lines. Spell numbers as they're said ("a fifth", "twelve thousand").
- **Pick the scene for the idea**: `title` (openers, chapters), `points` (reasons, features), `compare` (A vs B,
  myth vs fact), `flow` (steps, processes, timelines), `image` (anything visual), `text` (a statement or closer).
  Vary them: the same scene type five times in a row is monotonous.
- **Show each thing the moment it's named**: a cue with `at` (a phrase from the beat's text) for every element, and
  `point` for the one being talked about. Elements without a cue appear when the scene starts.
- **Keep on-screen text short**: items and labels under ~35 characters, headings under ~40; the voice carries the
  detail, the screen carries the keywords.
- **Facts**: only what you can stand behind; check claims against reliable sources. Don't present guesses as facts.
- **Pictures**: only ones you may use (your own, generated, public domain/CC0, or CC BY with credit in the
  description; no NonCommercial material in monetized videos, no random web images). Put them in
  `projects/<name>/assets/`.

### 3. Check the layout before anything else

```
npm run render -- <name> --sheet
```

Open `out/<name>.sheet.png` and look at it: one frame per scene, 70% into it, before any voice exists (timing is
estimated). Fix crowded text, too many items, unbalanced scenes and unknown cue ids (the render stops on those and
lists the valid ids) now; it costs seconds.

### 4. Voice

```
npm run voice -- <name>
```

Read the log: it prints what whisper heard for each beat. A misheard word usually means a mispronounced one (a
homophone like "flour" for "flower" is fine). Fix names and unusual words with `say` (a respelling, or phonemes
between slashes) and re-run. When pronunciation or delivery matters to the person, send previews before rendering:
`npm run voice -- <name> --only intro,why --note "..."` puts them on the review page; `--try "other wording"` previews
alternatives for one beat. A "phrase not found" warning at render means a cue's `at` no longer matches the text.

### 5. Render

```
npm run render -- <name> --sheet      # again, now with real timing
npm run render -- <name> --scenes     # the video, scene by scene
```

Look at the new sheet first. Render scene by scene: later changes re-render only the scenes they touch. Check a few
frames yourself if something is in doubt (`npm run still -- Video out/f.png --frame=N --props='{"project":"<name>"}'`)
rather than handing over unchecked work.

### 6. Hand over for review

The person reviews on the review page (`docker compose up -d`, port 8796), often on a phone: end every step that
needs their eyes or ears with the link, not a local path. The Review tab shows the new cut, the scenes that changed
(each with its line of narration) and voice previews.

### 7. Iterate on their notes

- Do the person's notes, not your own list. Offer suggestions briefly and wait for a yes.
- Re-run only what a change needs: on-screen changes (scene data, cues, theme) need only `render --scenes`; changed
  narration needs `voice` and then `render --scenes`; pronunciation needs `--only` previews first.
- After a voice re-run every later beat may shift in time; scene rendering still reuses the scenes whose pictures
  didn't change.

### 8. Posting kit

Write `projects/<name>/kit.json` (SPEC section 11): a title, description and tags per platform, credits for pictures
and music in the descriptions, `cover.at` at a frame that reads well as a thumbnail. Run `npm run kit -- <name>`; the
review page shows it under To post with copy buttons.

## Rules

- **Never invent sources, numbers or quotes.** If a fact can't be checked, leave it out or say it's uncertain.
- **Rights**: every picture, track and font in a video must be usable for the purpose (SPEC section 16). Credit what
  needs credit.
- **Look before you claim**: open the sheet (and frames if needed) before saying a video is ready. Report failures
  with their output.
- **Small, reversible changes**: commit only when the person asks; don't delete their projects or renders.
- **Code changes**: keep the engine deterministic (draw only from frame and props); run `npm run typecheck`; extend the
  scene kit rather than writing one-off scenes in a project (SPEC section 13); update `docs/SPEC.md` with any format or
  behaviour change.
- **Costs**: prefer the sheet (one image) to many stills; prefer `--scenes` to full re-renders; long sessions get
  expensive, so start fresh sessions for new videos.

## Environment notes

- Node 22.18+ runs the TypeScript directly (`node src/x.ts`); don't use tsx (it breaks Playwright's `page.evaluate`).
- Run renders in the foreground: a background shell can be killed when RAM runs low.
- Windows PowerShell 5.1: `Get-Content -Raw` / `Set-Content` corrupt UTF-8 without a BOM (phoneme characters become
  mojibake); edit files with an editor tool, or `[IO.File]::ReadAllText` / `WriteAllText` with
  `New-Object Text.UTF8Encoding $false`. Write commit messages to a file (`git commit -F file`).
- After editing `serve/index.html`, restart the review container (`docker compose restart`, with a timeout).
