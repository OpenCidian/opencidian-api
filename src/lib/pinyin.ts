/**
 * Pinyin keys for matching, and telling a pinyin query from a Vietnamese one.
 * The syllable set is generated from initials × finals (a superset of real Mandarin syllables
 * is fine here: it only decides whether a string *could* be pinyin).
 */

const INITIALS = ["", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "zh", "ch", "sh", "r", "z", "c", "s", "y", "w"];
const FINALS = [
  "a", "o", "e", "i", "u", "v", "ai", "ei", "ao", "ou", "an", "en", "ang", "eng", "ong", "er",
  "ia", "ie", "iao", "iu", "ian", "in", "iang", "ing", "iong",
  "ua", "uo", "uai", "ui", "uan", "un", "uang", "ueng", "ve", "van", "vn", "ue", "n", "ng", "m",
];
const SYLLABLES = new Set<string>();
for (const i of INITIALS) for (const f of FINALS) SYLLABLES.add(i + f);
const MAX_SYL = 6;

/** Split a toneless, lowercase string into pinyin syllables (longest first), or null if it can't be. */
export function splitSyllables(s: string): string[] | null {
  const memo = new Map<number, string[] | null>();
  const go = (pos: number): string[] | null => {
    if (pos === s.length) return [];
    if (memo.has(pos)) return memo.get(pos)!;
    let out: string[] | null = null;
    for (let len = Math.min(MAX_SYL, s.length - pos); len >= 1 && !out; len--) {
      const syl = s.slice(pos, pos + len);
      if (!SYLLABLES.has(syl)) continue;
      const rest = go(pos + len);
      if (rest) out = [syl, ...rest];
    }
    memo.set(pos, out);
    return out;
  };
  return go(0);
}

const TONE_OF: Record<string, number> = { "\u0304": 1, "\u0301": 2, "\u030C": 3, "\u0300": 4 };

/** "jué de", "jue2 de5", "juede", "Lu:4" → toneless key "juede", "lv". */
export function pinyinKey(s: string): string {
  return s.normalize("NFD").toLowerCase().replace(/u:|u\u0308/g, "v").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
}

/**
 * Tone key: syllables with their tone number, neutral tone dropped: "jue2de".
 * Accepts tone numbers ("jue2 de5") or tone marks ("jué de", "juéde"). Null when the tones can't be placed.
 */
export function pinyinToneKey(s: string): string | null {
  const t = s.normalize("NFD").toLowerCase().replace(/u:|u\u0308/g, "v");
  if (/[1-5]/.test(t)) return t.replace(/[\u0300-\u036f]/g, "").replace(/[^a-z1-4]/g, "");
  // Tone marks: find each syllable in the toneless string, then read the mark that falls inside it.
  const letters: { ch: string; tone: number }[] = [];
  for (const ch of t) {
    if (/[a-z]/.test(ch)) letters.push({ ch, tone: 0 });
    else if (TONE_OF[ch] && letters.length) letters[letters.length - 1]!.tone = TONE_OF[ch]!;
  }
  const plain = letters.map((l) => l.ch).join("");
  const sylls = splitSyllables(plain);
  if (!sylls) return null;
  let pos = 0;
  return sylls
    .map((syl) => {
      const tone = letters.slice(pos, pos + syl.length).find((l) => l.tone)?.tone ?? 0;
      pos += syl.length;
      return tone ? `${syl}${tone}` : syl;
    })
    .join("");
}

/** Keys for an entry, from its CEDICT pinyin ("jue2 de5"). */
export function entryKeys(pinyinNum: string): { pinyinKey: string; toneKey: string } {
  const t = pinyinNum.toLowerCase().replace(/u:/g, "v");
  return { pinyinKey: pinyinKey(pinyinNum), toneKey: t.replace(/5/g, "").replace(/[^a-z1-4]/g, "") };
}

// Vietnamese letters and tone marks that pinyin never uses: đ, ơ, ư, ă, â, ê, ô; hook above, tilde, dot below.
const VI_ONLY = /[đơưăâêô]|[\u0309\u0303\u0323\u031B\u0306\u0302]/;

export type QueryKind = "hanzi" | "pinyin" | "vi";

/** What a lookup query most likely is. Plain Latin that could be pinyin returns ["pinyin", "vi"]. */
export function classify(q: string): QueryKind[] {
  if (/\p{Script=Han}/u.test(q)) return ["hanzi"];
  const lower = q.toLowerCase();
  if (VI_ONLY.test(lower.normalize("NFD")) || VI_ONLY.test(lower)) return ["vi"];
  const key = pinyinKey(q);
  if (key && /^[a-zü:\s\u0300-\u036f1-5'·-]+$/u.test(lower.normalize("NFD")) && splitSyllables(key)) {
    // Tone numbers or pinyin tone marks: surely pinyin.
    if (/[1-5]/.test(lower) || /[\u0304\u030C]/.test(lower.normalize("NFD"))) return ["pinyin"];
    return ["pinyin", "vi"];
  }
  return ["vi"];
}

/** True when a toneless key could be pinyin being typed: whole syllables, then the start of one ("jued"). */
export function couldBePinyinPrefix(key: string): boolean {
  if (!key || !/^[a-z]+$/.test(key)) return false;
  for (let cut = 0; cut <= Math.min(MAX_SYL - 1, key.length - 1); cut++) {
    const head = key.slice(0, key.length - cut);
    const tail = key.slice(key.length - cut);
    if (splitSyllables(head) && (!tail || [...SYLLABLES].some((s) => s.startsWith(tail)))) return true;
  }
  return false;
}

/** Text for the vi/en full-text columns: lowercase, đ folded (the tokenizer folds the other diacritics). */
export function ftsText(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/đ/g, "d");
}

/** A user query as an FTS5 phrase, safe to bind. Prefix match on the last word when `prefix`. */
export function ftsPhrase(q: string, prefix = false): string | null {
  const words = ftsText(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  return `"${words.join(" ")}"${prefix ? " *" : ""}`;
}
