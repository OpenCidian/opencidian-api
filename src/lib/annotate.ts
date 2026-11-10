/**
 * Split text into words and annotate each: forward longest match against the dictionary (up to 8 characters).
 * Runs of Han characters are segmented; anything else (Latin, digits, punctuation) passes through as is.
 */
import { entriesFor, getChar, type Entry } from "./queries.ts";

export const MAX_WORD = 8;
export const MAX_TEXT = 2000;
const IS_HAN = /^\p{Script=Han}$/u;

export interface Token {
  text: string;
  /** Han word found in the dictionary, a Han character that isn't, or anything else. */
  kind: "word" | "unknown" | "other";
  pinyin?: string;
  /** One item per character. */
  hanviet?: { char: string; readings: string[] }[];
  vi?: string[] | null;
  en?: string[];
  /** The entry used, and how many other pronunciations the word has. */
  id?: string;
  otherReadings?: number;
}

/** Pure segmentation, given the set of words the dictionary has. */
export function segment(text: string, has: (w: string) => boolean): { text: string; han: boolean }[] {
  const chars = [...text];
  const out: { text: string; han: boolean }[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!IS_HAN.test(chars[i]!)) {
      let j = i;
      while (j < chars.length && !IS_HAN.test(chars[j]!)) j++;
      out.push({ text: chars.slice(i, j).join(""), han: false });
      i = j;
      continue;
    }
    let len = 1;
    for (let l = Math.min(MAX_WORD, chars.length - i); l > 1; l--) {
      const w = chars.slice(i, i + l);
      if (w.every((c) => IS_HAN.test(c)) && has(w.join(""))) { len = l; break; }
    }
    out.push({ text: chars.slice(i, i + len).join(""), han: true });
    i += len;
  }
  return out;
}

/** Every Han substring up to MAX_WORD long: the candidates to look up in one query. */
export function candidates(text: string): string[] {
  const chars = [...text];
  const set = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    for (let l = 1; l <= MAX_WORD && i + l <= chars.length; l++) {
      const w = chars.slice(i, i + l);
      if (!w.every((c) => IS_HAN.test(c))) break;
      set.add(w.join(""));
    }
  }
  return [...set];
}

/** The pronunciation to show when a word has several: an HSK one first, then the first with a Vietnamese meaning. */
function pick(list: Entry[]): Entry {
  return list.find((e) => e.hsk && e.vi) ?? list.find((e) => e.vi) ?? list[0]!;
}

export async function annotate(db: D1Database, text: string): Promise<Token[]> {
  const found = await entriesFor(db, candidates(text));
  const tokens: Token[] = [];
  for (const seg of segment(text, (w) => found.has(w))) {
    if (!seg.han) { tokens.push({ text: seg.text, kind: "other" }); continue; }
    const list = found.get(seg.text);
    if (!list?.length) {
      const ch = await getChar(db, seg.text);
      const hv = (ch?.hanviet as { readings: string[] } | null | undefined)?.readings ?? [];
      tokens.push({ text: seg.text, kind: "unknown", hanviet: [{ char: seg.text, readings: hv }] });
      continue;
    }
    const e = pick(list);
    tokens.push({
      text: seg.text,
      kind: "word",
      id: e.id,
      pinyin: e.pinyin,
      hanviet: e.hanviet.map((h) => ({ char: h.char, readings: h.readings })),
      vi: e.vi?.senses ?? null,
      en: e.en.senses,
      otherReadings: list.length - 1,
    });
  }
  return tokens;
}
