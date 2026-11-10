/** Read queries over D1. Entries come back exactly as the release has them (the `data` column). */
import { classify, couldBePinyinPrefix, ftsPhrase, ftsText, pinyinKey, pinyinToneKey, type QueryKind } from "./pinyin.ts";

export interface Entry {
  id: string;
  simp: string;
  trad: string;
  pinyin: string;
  pinyinNum: string;
  hanviet: { char: string; trad?: string; readings: string[]; src: string; via?: string }[];
  vi: { senses: string[]; src: string } | null;
  en: { senses: string[]; src: string };
  hsk?: { hsk2?: number; hsk3?: number; src: string };
  [k: string]: unknown;
}

type Row = { data: string };
const parse = (rows: Row[]) => rows.map((r) => JSON.parse(r.data) as Entry);

// Ranking for lists: HSK words first (lowest level first), then shorter words, then dictionary order.
const RANK = "ORDER BY hsk IS NULL, hsk, len, rowid";

export async function getEntry(db: D1Database, id: string): Promise<Entry | null> {
  const r = await db.prepare("SELECT data FROM entries WHERE id = ?").bind(id).first<Row>();
  return r ? (JSON.parse(r.data) as Entry) : null;
}

export async function getChar(db: D1Database, ch: string): Promise<Record<string, unknown> | null> {
  const r = await db.prepare("SELECT data FROM chars WHERE char = ?").bind(ch).first<Row>();
  return r ? (JSON.parse(r.data) as Record<string, unknown>) : null;
}

/** Exact simplified or traditional form first, then words that start with it. */
export async function byHanzi(db: D1Database, q: string, limit: number): Promise<Entry[]> {
  const exact = await db.prepare(`SELECT data FROM entries WHERE simp = ?1 OR trad = ?1 ${RANK} LIMIT ?2`).bind(q, limit).all<Row>();
  const out = parse(exact.results);
  if (out.length < limit) {
    const more = await db
      .prepare(`SELECT data FROM entries WHERE simp > ?1 AND simp < ?1 || char(1114111) ${RANK} LIMIT ?2`)
      .bind(q, limit - out.length)
      .all<Row>();
    out.push(...parse(more.results));
  }
  return out;
}

/** Tone-exact when the query has tones ("jué", "jue2"), otherwise any tone ("jue"). */
export async function byPinyin(db: D1Database, q: string, limit: number): Promise<Entry[]> {
  const hasTone = /[1-5]/.test(q) || /[̀-ͯ]/.test(q.normalize("NFD"));
  const tone = hasTone ? pinyinToneKey(q) : null;
  const [col, key] = tone ? ["pinyin_tone_key", tone] : ["pinyin_key", pinyinKey(q)];
  if (!key) return [];
  const r = await db.prepare(`SELECT data FROM entries WHERE ${col} = ? ${RANK} LIMIT ?`).bind(key, limit).all<Row>();
  return parse(r.results);
}

/**
 * Meaning search (Vietnamese or English), with or without diacritics. A sense that is exactly the query
 * ranks first, then HSK words, then FTS relevance.
 */
export async function byMeaning(db: D1Database, q: string, lang: "vi" | "en", limit: number): Promise<Entry[]> {
  const phrase = ftsPhrase(q);
  if (!phrase) return [];
  const r = await db
    .prepare(
      `SELECT e.data FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
       WHERE entries_fts MATCH ? ORDER BY e.hsk IS NULL, bm25(entries_fts), e.len LIMIT ?`,
    )
    .bind(`${lang} : ${phrase}`, Math.max(limit * 5, 50))
    .all<Row>();
  const want = ftsText(q).normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const plain = (s: string) => ftsText(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const senseHit = (e: Entry) => {
    const senses = lang === "vi" ? (e.vi?.senses ?? []) : e.en.senses;
    return senses.some((s) => s.split(/[;,]/).some((part) => plain(part) === want)) ? 0 : 1;
  };
  return parse(r.results)
    .map((e, i) => ({ e, i, k: senseHit(e) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

export interface LookupResult {
  q: string;
  kinds: QueryKind[];
  entries: (Entry & { match: QueryKind })[];
}

/** One box for everything: hanzi, pinyin (with or without tones) or Vietnamese. */
export async function lookup(db: D1Database, q: string, limit: number, by?: QueryKind): Promise<LookupResult> {
  const kinds = by ? [by] : classify(q);
  const seen = new Set<string>();
  const entries: LookupResult["entries"] = [];
  for (const kind of kinds) {
    if (entries.length >= limit) break;
    const n = limit - entries.length;
    const found = kind === "hanzi" ? await byHanzi(db, q, n) : kind === "pinyin" ? await byPinyin(db, q, n) : await byMeaning(db, q, "vi", n);
    for (const e of found) if (!seen.has(e.id)) { seen.add(e.id); entries.push({ ...e, match: kind }); }
  }
  return { q, kinds, entries };
}

/** Words (two characters or more) that contain a character, in its simplified or traditional form. */
export async function wordsWith(db: D1Database, ch: string, limit: number): Promise<Entry[]> {
  const r = await db
    .prepare(
      `SELECT e.data FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
       WHERE entries_fts MATCH ? AND e.len > 1 ORDER BY e.hsk IS NULL, e.hsk, e.len, e.rowid LIMIT ?`,
    )
    .bind(`hanzi : "${ch}"`, limit)
    .all<Row>();
  return parse(r.results);
}

export interface Suggestion {
  id: string;
  simp: string;
  trad: string;
  pinyin: string;
  vi: string | null;
}

/** Search as you type: hanzi prefix, pinyin prefix (no tones), or the start of a Vietnamese meaning. */
export async function suggest(db: D1Database, q: string, limit: number): Promise<Suggestion[]> {
  const kinds = classify(q);
  let rows: Row[] = [];
  if (kinds[0] === "hanzi") {
    rows = (await db.prepare(`SELECT data FROM entries WHERE (simp >= ?1 AND simp < ?1 || char(1114111)) OR trad = ?1 ${RANK} LIMIT ?2`).bind(q, limit).all<Row>()).results;
  } else {
    const key = pinyinKey(q);
    if (kinds.includes("pinyin") || (!/[đơưăâêô]/i.test(q) && couldBePinyinPrefix(key))) {
      rows = (await db.prepare(`SELECT data FROM entries WHERE pinyin_key >= ?1 AND pinyin_key < ?1 || '{' ${RANK} LIMIT ?2`).bind(key, limit).all<Row>()).results;
    }
    const phrase = ftsPhrase(q, true);
    if (rows.length < limit && phrase) {
      const more = await db
        .prepare(`SELECT e.data FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ? ORDER BY e.hsk IS NULL, e.hsk, e.len LIMIT ?`)
        .bind(`vi : ${phrase}`, limit - rows.length)
        .all<Row>();
      rows = [...rows, ...more.results];
    }
  }
  const seen = new Set<string>();
  return parse(rows)
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .map((e) => ({ id: e.id, simp: e.simp, trad: e.trad, pinyin: e.pinyin, vi: e.vi?.senses[0] ?? null }));
}

/** Entries whose simplified or traditional form is one of `words` (one query, any number of words). */
export async function entriesFor(db: D1Database, words: string[]): Promise<Map<string, Entry[]>> {
  const out = new Map<string, Entry[]>();
  if (!words.length) return out;
  const r = await db
    .prepare(`SELECT simp, trad, data FROM entries WHERE simp IN (SELECT value FROM json_each(?1)) OR trad IN (SELECT value FROM json_each(?1)) ${RANK}`)
    .bind(JSON.stringify(words))
    .all<Row & { simp: string; trad: string }>();
  for (const row of r.results) {
    const e = JSON.parse(row.data) as Entry;
    for (const w of new Set([row.simp, row.trad])) if (words.includes(w)) out.set(w, [...(out.get(w) ?? []), e]);
  }
  return out;
}
