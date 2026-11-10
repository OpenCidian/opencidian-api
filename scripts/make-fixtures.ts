/**
 * npm run fixtures -- [path to opencidian-data/dist]
 * Takes a slice of a real build for the tests: every word the test sentences can contain, every word with 觉,
 * every entry whose Vietnamese mentions "cảm thấy", and the characters they use. Written as a release
 * (entries.jsonl.gz, chars.jsonl.gz, meta.json) so the tests load it through the real sync.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { candidates } from "../src/lib/annotate.ts";
import { SENTENCES } from "../test/sentences.ts";

const dist = process.argv[2] ?? path.resolve(import.meta.dirname, "../../opencidian-data/dist");
const out = path.resolve(import.meta.dirname, "../test/fixtures");
const lines = (f: string) => readFileSync(path.join(dist, f), "utf8").trim().split("\n");

const want = new Set(SENTENCES.flatMap((s) => candidates(s.text)));
for (const w of ["觉", "觉得", "办法", "说话", "爸爸", "细", "值"]) want.add(w);
const entries = lines("entries.jsonl").filter((l) => {
  const e = JSON.parse(l) as { simp: string; trad: string; vi: { senses: string[] } | null };
  return want.has(e.simp) || want.has(e.trad) || e.simp.includes("觉") || (e.vi?.senses.some((s) => s.includes("cảm thấy")) ?? false);
});
const used = new Set(entries.flatMap((l) => { const e = JSON.parse(l) as { simp: string; trad: string }; return [...e.simp, ...e.trad]; }));
const chars = lines("chars.jsonl").filter((l) => used.has((JSON.parse(l) as { char: string }).char));

writeFileSync(path.join(out, "entries.jsonl.gz"), gzipSync(entries.join("\n") + "\n"));
writeFileSync(path.join(out, "chars.jsonl.gz"), gzipSync(chars.join("\n") + "\n"));
writeFileSync(path.join(out, "meta.json"), readFileSync(path.join(dist, "meta.json")));
console.log(`fixtures: ${entries.length} entries, ${chars.length} chars from ${dist}`);
