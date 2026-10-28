// Text -> Kokoro phonemes the way kokoro-js does it (espeak-ng via `phonemizer`, split at punctuation, then Kokoro's
// fixes), so single words can be given exact phonemes: script.json "say": {"quinoa": "/kˈiːnwɑː/"}.
// kokoro-js 1.2.1 doesn't export its phonemize; this mirrors it, minus its number/abbreviation normalization
// (voiceover text spells numbers out anyway). Stress marks: ˈ primary, ˌ secondary, placed before the syllable.
import { phonemize } from 'phonemizer';

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const SPLIT = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

/** espeak phonemes for plain text; punctuation passes through (Kokoro reads it for pauses and intonation). */
async function espeak(text: string): Promise<string> {
  text = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  let out = '', last = 0;
  for (const m of text.matchAll(SPLIT)) {
    if (m.index > last) out += (await phonemize(text.slice(last, m.index), 'en-us')).join(' ');
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < text.length) out += (await phonemize(text.slice(last), 'en-us')).join(' ');
  return out
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z')
    .replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
    .trim();
}

/** Phonemes for a list of words, where a word written as /phonemes/ (punctuation around it allowed) is used as-is. */
export async function toPhonemes(words: string[]): Promise<string> {
  const parts: string[] = [];
  let run: string[] = [];
  const flush = async () => { if (run.length) parts.push(await espeak(run.join(' '))); run = []; };
  for (const w of words) {
    const m = w.match(/^([^/]*)\/([^/]+)\/(.*)$/);
    if (!m) { run.push(w); continue; }
    if (m[1]) run.push(m[1]);
    await flush();
    parts.push(m[2]);
    if (m[3]) run.push(m[3]);
  }
  await flush();
  return parts.join(' ').replace(/\s+([;:,.!?…])/g, '$1');
}

export const hasPhonemes = (words: string[]) => words.some(w => /\/[^/]+\//.test(w));
