// Kit: projects/<name>/kit.json (title, description and tags per platform) -> a posting kit on the review page:
// out/<name>.kit.json + out/<name>.cover.jpg, shown next to the video with copy buttons.
// Usage: npm run kit -- <name>   (after npm run render). Checks each platform's length limits first.
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderStill } from './engine/render.ts';
import type { Kit, Script } from './types.ts';

const FPS = 30;
const hashtags = (text: string) => text.match(/#[\p{L}\p{N}_]+/gu) ?? [];

function check(kit: Kit): string[] {
  const problems: string[] = [];
  const limit = (what: string, text: string, max: number) => { if (text.length > max) problems.push(`${what}: ${text.length} characters, max ${max}`); };
  if (!kit.youtube && !kit.instagram && !kit.tiktok) problems.push('no platform: give youtube, instagram and/or tiktok');
  if (kit.youtube) {
    limit('youtube.title', kit.youtube.title, 100);
    if (/[<>]/.test(kit.youtube.title)) problems.push('youtube.title: YouTube rejects < and >');
    limit('youtube.description', kit.youtube.description, 5000);
    // YouTube counts a tag with spaces as if quoted, plus a comma between tags.
    const tagChars = kit.youtube.tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + kit.youtube.tags.length - 1;
    if (tagChars > 500) problems.push(`youtube.tags: ${tagChars} characters, max 500`);
  }
  if (kit.instagram) {
    limit('instagram.caption', kit.instagram.caption, 2200);
    if (hashtags(kit.instagram.caption).length > 5) problems.push('instagram.caption: more than 5 hashtags (Instagram limits posts to 5)');
  }
  if (kit.tiktok) limit('tiktok.caption', kit.tiktok.caption, 4000);
  return problems;
}

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error('usage: npm run kit -- <name>');
  const dir = path.join('projects', name);
  const kit = JSON.parse(await readFile(path.join(dir, 'kit.json'), 'utf8').catch(() => {
    throw new Error(`${dir}/kit.json missing (see docs/SPEC.md, Posting kit)`);
  })) as Kit;
  const problems = check(kit);
  if (problems.length) throw new Error(`${dir}/kit.json:\n  ${problems.join('\n  ')}`);

  const video = `${name}.mp4`;
  await access(path.resolve('out', video)).catch(() => { throw new Error(`out/${video} missing: run npm run render -- ${name} first`); });

  const cover = `${name}.cover.jpg`;
  const frame = Math.round((kit.cover?.at ?? 1) * FPS);
  await renderStill({ composition: 'Video', props: { project: name }, frame, output: path.resolve('out', cover), format: 'jpeg', quality: 92 });

  const script = JSON.parse(await readFile(path.join(dir, 'script.json'), 'utf8')) as Script;
  const out = { ...kit, project: name, title: script.title ?? kit.youtube?.title ?? name, video, preview: `${name}.preview.mp4`, cover };
  await writeFile(path.resolve('out', `${name}.kit.json`), JSON.stringify(out, null, 2));
  console.log(`posting kit ready: out/${name}.kit.json + ${cover} (on the review page)`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
