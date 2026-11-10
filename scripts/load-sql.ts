/**
 * Workers Free: the first load of a release into D1, from this Mac, spread over days.
 *
 * Why: the in-Worker sync (POST /internal/sync) needs minutes of CPU and ~200 queries in one call; Free
 * allows 10 ms and 50. And D1 Free allows 100K rows written a day: an entry counts as 7 (the row, its 5
 * indexes, the FTS row), a character as 2, so a full load is ~907K writes, ~10 days.
 *
 * This writes the load as numbered SQL files under <out>/, smallest-first in value: every character,
 * then HSK entries (by level), then the rest. scripts/load-day.ts runs them up to a daily budget.
 * Same rows and hashes as src/lib/sync.ts, so a later sync on Workers Paid rewrites nothing unchanged.
 * Every statement skips rows already there: a file run twice writes nothing the second time.
 *
 *   tsx scripts/load-sql.ts <release dir with entries.jsonl, chars.jsonl, meta.json> <out dir> <tag>
 */
import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { entryRow, lineHash } from "../src/lib/sync.ts";

const [src, out, tag] = process.argv.slice(2);
if (!src || !out || !tag) throw new Error("usage: tsx scripts/load-sql.ts <release dir> <out dir> <tag>");
const ENTRIES_PER_FILE = 1000; // ~7K writes
const CHARS_PER_FILE = 2500; // ~5K writes

const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);

async function* lines(file: string) {
  for await (const l of createInterface({ input: createReadStream(file) })) if (l.trim()) yield l;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let fileNo = 0;
const files: { file: string; rows: number; kind: string }[] = [];
function write(kind: string, stmts: string[], rows: number) {
  const file = `${String(fileNo++).padStart(4, "0")}-${kind}.sql`;
  writeFileSync(`${out}/${file}`, stmts.join("\n") + "\n");
  files.push({ file, rows, kind });
}

// Characters
let buf: string[] = [];
let n = 0;
for await (const line of lines(`${src}/chars.jsonl`)) {
  const ch = (JSON.parse(line) as { char: string }).char;
  buf.push(`INSERT INTO chars (char, data, hash) VALUES (${q(ch)}, ${q(line)}, ${q(lineHash(line))}) ON CONFLICT (char) DO NOTHING;`);
  if (++n % CHARS_PER_FILE === 0) { write("chars", buf, CHARS_PER_FILE); buf = []; }
}
if (buf.length) write("chars", buf, buf.length);

// Entries: HSK first (lowest level first), then the rest in release order
const rows: { r: ReturnType<typeof entryRow>; order: number }[] = [];
let i = 0;
for await (const line of lines(`${src}/entries.jsonl`)) {
  const r = entryRow(line, lineHash(line));
  rows.push({ r, order: (r.hsk ?? 99) * 1e6 + i++ });
}
rows.sort((a, b) => a.order - b.order);
for (let k = 0; k < rows.length; k += ENTRIES_PER_FILE) {
  const chunk = rows.slice(k, k + ENTRIES_PER_FILE);
  const stmts = chunk.flatMap(({ r }) => [
    `INSERT INTO entries (id, simp, trad, pinyin_key, pinyin_tone_key, hsk, len, has_vi, data, hash) VALUES (${[r.id, r.simp, r.trad, r.pk, r.tk, r.hsk, r.len, r.hasVi, r.data, r.hash].map(q).join(", ")}) ON CONFLICT (id) DO NOTHING;`,
    `INSERT INTO entries_fts (rowid, hanzi, vi, en) SELECT e.rowid, ${q(r.hanzi)}, ${q(r.vi)}, ${q(r.en)} FROM entries e WHERE e.id = ${q(r.id)} AND NOT EXISTS (SELECT 1 FROM entries_fts f WHERE f.rowid = e.rowid);`,
  ]);
  write(chunk[0]!.r.hsk !== null ? "entries-hsk" : "entries", stmts, chunk.length);
}

// Meta: written with the first file run, so /v1/meta names the release while it loads
const meta = readFileSync(`${src}/meta.json`, "utf8");
writeFileSync(
  `${out}/meta.sql`,
  [
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('dataset', ${q(JSON.stringify(JSON.parse(meta)))});`,
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('release_tag', ${q(tag)});`,
  ].join("\n") + "\n",
);
writeFileSync(`${out}/files.json`, JSON.stringify({ tag, files }, null, 1));
console.log(JSON.stringify({ tag, files: files.length, chars: n, entries: rows.length, hsk: rows.filter((x) => x.r.hsk !== null).length }));
