// Word-by-word captions: a few words per page, the spoken word highlighted, in a band near the bottom of the frame.
import type React from 'react';
import { useMemo } from 'react';
import { useCurrentFrame, useVideoConfig } from '../engine/index.ts';
import type { Timeline } from '../types.ts';
import { fontFamily } from './fonts.ts';

/** A word as shown: pause marks after "!" or "?" are dropped ("Wow!..." -> "Wow!"), a short pause ".." reads "...". */
const caption = (word: string) => word.replace(/([!?])\.{2,}$/, '$1').replace(/(?<!\.)\.\.$/, '...');

/** A black outline around the letters, for a font size. */
const outline = (size: number) => [[-4, -4], [4, -4], [-4, 4], [4, 4], [0, 6], [0, -5], [6, 0], [-6, 0]]
  .map(([x, y]) => `${(x * size) / 82}px ${(y * size) / 82}px 0 #000`).join(', ');

/**
 * Where captions go for a frame shape: two lines at most, above the bottom (portrait leaves room for the platforms'
 * buttons). Scenes and the narrator stay above `top`.
 */
export function captionBox(w: number, h: number) {
  const portrait = h > w;
  const fontSize = portrait ? 0.074 * w : 0.052 * h;
  const bottom = portrait ? 0.83 * h : 0.95 * h;
  return { fontSize, top: bottom - 2 * 1.15 * fontSize, side: 0.06 * w };
}

interface Page { startMs: number; durationMs: number; tokens: Array<{ text: string; fromMs: number }> }

/** One beat's words in pages: a page takes words until it spans more than `spanMs`, and lasts until the next one starts. */
function paginate(words: Timeline['beats'][number]['words'], spanMs: number): Page[] {
  const pages: Page[] = [];
  let endMs = 0;
  for (const w of words) {
    const page = pages.at(-1);
    if (page && endMs - page.startMs <= spanMs) page.tokens.push({ text: w.text, fromMs: w.startMs });
    else {
      if (page) page.durationMs = w.startMs - page.startMs;
      pages.push({ startMs: w.startMs, durationMs: 0, tokens: [{ text: w.text, fromMs: w.startMs }] });
    }
    endMs = w.endMs;
  }
  const last = pages.at(-1);
  if (last) last.durationMs = endMs - last.startMs;
  return pages;
}

export const Captions: React.FC<{ timeline: Timeline; untilMs?: number }> = ({ timeline, untilMs = Infinity }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const box = captionBox(width, height);
  const t = (frame / fps) * 1000;

  // Pages never span two beats.
  const pages = useMemo(() => timeline.beats.flatMap(b => paginate(b.words, 1000)), [timeline]);

  const page = pages.findLast(p => p.startMs <= t);
  if (!page || t >= untilMs || t > page.startMs + page.durationMs + 400) return null;

  // One highlighted word at a time (whisper word times can overlap).
  const activeIndex = page.tokens.findLastIndex(tok => tok.fromMs <= t);

  return (
    <div
      style={{
        position: 'absolute', top: box.top, left: box.side, right: box.side, textAlign: 'center',
        fontFamily, fontWeight: 900, fontSize: box.fontSize, lineHeight: 1.15, color: '#fff', textShadow: outline(box.fontSize),
      }}
    >
      {page.tokens.map((tok, i) => {
        const active = i === activeIndex;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block', marginLeft: i === 0 ? 0 : '0.26em',
              color: active ? '#ffd84d' : '#fff',
            }}
          >
            {caption(tok.text.trim())}
          </span>
        );
      })}
    </div>
  );
};
