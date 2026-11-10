/**
 * Load an opencidian-data release into D1: only rows whose release line changed are written, rows gone
 * from the release are deleted. Idempotent, so a sync cut short is finished by running it again.
 *
 * D1 allows 1,000 queries per Worker call and 100 bound parameters per query, so rows go in batches as one
 * JSON parameter (about 1 MB) unpacked with json_each: a full load of 125K entries is about 150 queries.
 */
import { entryKeys, ftsText } from "./pinyin.ts";

const BATCH_BYTES = 900_000;

export interface ReleaseInput {
  tag: string;
  meta: { version: string; [k: string]: unknown };
  entries: AsyncIterable<string>; // JSON lines
  chars: AsyncIterable<string>;
}

export interface SyncResult {
  tag: string;
  version: string;
  entries: { total: number; written: number; deleted: number };
  chars: { total: number; written: number; deleted: number };
  queries: number;
}

/** cyrb53: a fast 53-bit string hash, enough to tell a changed line. */
export function lineHash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface EntryLine {
  id: string;
  simp: string;
  trad: string;
  pinyinNum: string;
  vi: { senses: string[] } | null;
  en: { senses: string[] };
  hsk?: { hsk2?: number; hsk3?: number };
}

export function entryRow(line: string, hash: string) {
  const e = JSON.parse(line) as EntryLine;
  const { pinyinKey, toneKey } = entryKeys(e.pinyinNum);
  const levels = [e.hsk?.hsk3, e.hsk?.hsk2].filter((n): n is number => typeof n === "number");
  const hanzi = [...new Set([...e.simp, ...e.trad])].filter((c) => /\p{Script=Han}/u.test(c)).join(" ");
  return {
    id: e.id,
    simp: e.simp,
    trad: e.trad,
    pk: pinyinKey,
    tk: toneKey,
    hsk: levels.length ? Math.min(...levels) : null,
    len: [...e.simp].length,
    hasVi: e.vi ? 1 : 0,
    data: line,
    hash,
    hanzi,
    vi: ftsText((e.vi?.senses ?? []).join(" ; ")),
    en: ftsText(e.en.senses.join(" ; ")),
  };
}

const UPSERT_ENTRIES = `
INSERT INTO entries (id, simp, trad, pinyin_key, pinyin_tone_key, hsk, len, has_vi, data, hash)
SELECT j.value->>'id', j.value->>'simp', j.value->>'trad', j.value->>'pk', j.value->>'tk', j.value->>'hsk',
       j.value->>'len', j.value->>'hasVi', j.value->>'data', j.value->>'hash'
FROM json_each(?1) j WHERE true
ON CONFLICT (id) DO UPDATE SET simp = excluded.simp, trad = excluded.trad, pinyin_key = excluded.pinyin_key,
  pinyin_tone_key = excluded.pinyin_tone_key, hsk = excluded.hsk, len = excluded.len, has_vi = excluded.has_vi,
  data = excluded.data, hash = excluded.hash`;
const FTS_DELETE = `DELETE FROM entries_fts WHERE rowid IN (SELECT e.rowid FROM entries e JOIN json_each(?1) j ON e.id = j.value->>'id')`;
const FTS_INSERT = `
INSERT INTO entries_fts (rowid, hanzi, vi, en)
SELECT e.rowid, j.value->>'hanzi', j.value->>'vi', j.value->>'en' FROM json_each(?1) j JOIN entries e ON e.id = j.value->>'id'`;
const UPSERT_CHARS = `
INSERT INTO chars (char, data, hash) SELECT j.value->>'char', j.value->>'data', j.value->>'hash' FROM json_each(?1) j WHERE true
ON CONFLICT (char) DO UPDATE SET data = excluded.data, hash = excluded.hash`;

async function* batches<T>(rows: AsyncIterable<T>, size: (t: T) => number): AsyncGenerator<T[]> {
  let cur: T[] = [];
  let bytes = 0;
  for await (const r of rows) {
    cur.push(r);
    bytes += size(r);
    if (bytes >= BATCH_BYTES) { yield cur; cur = []; bytes = 0; }
  }
  if (cur.length) yield cur;
}

export async function syncRelease(db: D1Database, input: ReleaseInput): Promise<SyncResult> {
  let queries = 0;

  // ── Entries
  const have = new Map<string, string>();
  for (const r of (await db.prepare("SELECT id, hash FROM entries").all<{ id: string; hash: string }>()).results) have.set(r.id, r.hash);
  queries++;
  const seen = new Set<string>();
  let total = 0;
  async function* changedEntries() {
    for await (const line of input.entries) {
      if (!line.trim()) continue;
      total++;
      const hash = lineHash(line);
      const id = (JSON.parse(line) as { id: string }).id;
      seen.add(id);
      if (have.get(id) !== hash) yield entryRow(line, hash);
    }
  }
  let written = 0;
  for await (const batch of batches(changedEntries(), (r) => r.data.length * 2)) {
    const json = JSON.stringify(batch);
    await db.batch([db.prepare(FTS_DELETE).bind(json), db.prepare(UPSERT_ENTRIES).bind(json), db.prepare(FTS_INSERT).bind(json)]);
    queries += 3;
    written += batch.length;
  }
  const gone = [...have.keys()].filter((id) => !seen.has(id));
  for (let i = 0; i < gone.length; i += 5000) {
    const json = JSON.stringify(gone.slice(i, i + 5000));
    await db.batch([
      db.prepare("DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries WHERE id IN (SELECT value FROM json_each(?1)))").bind(json),
      db.prepare("DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?1))").bind(json),
    ]);
    queries += 2;
  }
  const entries = { total, written, deleted: gone.length };

  // ── Characters
  const haveC = new Map<string, string>();
  for (const r of (await db.prepare("SELECT char, hash FROM chars").all<{ char: string; hash: string }>()).results) haveC.set(r.char, r.hash);
  queries++;
  const seenC = new Set<string>();
  let totalC = 0;
  async function* changedChars() {
    for await (const line of input.chars) {
      if (!line.trim()) continue;
      totalC++;
      const hash = lineHash(line);
      const ch = (JSON.parse(line) as { char: string }).char;
      seenC.add(ch);
      if (haveC.get(ch) !== hash) yield { char: ch, data: line, hash };
    }
  }
  let writtenC = 0;
  for await (const batch of batches(changedChars(), (r) => r.data.length * 2)) {
    await db.prepare(UPSERT_CHARS).bind(JSON.stringify(batch)).run();
    queries++;
    writtenC += batch.length;
  }
  const goneC = [...haveC.keys()].filter((c) => !seenC.has(c));
  if (goneC.length) {
    await db.prepare("DELETE FROM chars WHERE char IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(goneC)).run();
    queries++;
  }

  // ── Meta last: a sync cut short leaves the old version showing until it's run again.
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('dataset', ?1)").bind(JSON.stringify(input.meta)),
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('release_tag', ?1)").bind(input.tag),
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('synced_at', ?1)").bind(now),
  ]);
  queries += 3;

  return { tag: input.tag, version: input.meta.version, entries, chars: { total: totalC, written: writtenC, deleted: goneC.length }, queries };
}

// ── Reading a release from GitHub

/** Lines of a gzipped text stream. */
export async function* gzLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}

interface Asset { name: string; url: string }

export async function fetchRelease(opts: { api: string; repo: string; token?: string; tag?: string; fetch?: typeof fetch }): Promise<ReleaseInput> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = { "user-agent": "opencidian-api", accept: "application/vnd.github+json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const path = opts.tag ? `releases/tags/${encodeURIComponent(opts.tag)}` : "releases/latest";
  const res = await f(`${opts.api}/repos/${opts.repo}/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub release ${opts.tag ?? "latest"}: HTTP ${res.status}`);
  const rel = (await res.json()) as { tag_name: string; assets: Asset[] };
  const asset = async (name: string) => {
    const a = rel.assets.find((x) => x.name === name);
    if (!a) throw new Error(`release ${rel.tag_name} has no ${name}`);
    const r = await f(a.url, { headers: { ...headers, accept: "application/octet-stream" } });
    if (!r.ok || !r.body) throw new Error(`${name}: HTTP ${r.status}`);
    return r;
  };
  const meta = (await (await asset("meta.json")).json()) as ReleaseInput["meta"];
  return {
    tag: rel.tag_name,
    meta,
    // Opened lazily, one after the other, so only one download is in flight.
    entries: (async function* () { yield* gzLines((await asset("entries.jsonl.gz")).body!); })(),
    chars: (async function* () { yield* gzLines((await asset("chars.jsonl.gz")).body!); })(),
  };
}
