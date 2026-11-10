/**
 * Run the next files of a load made by scripts/load-sql.ts against the remote D1, until today's budget
 * of rows written (UTC day) would be passed. D1 Free fails every query, reads too, once an account
 * passes 100K rows written in a day, so the default budget leaves room for the API's own writes.
 * Progress is kept in <load dir>/state.json; run it once a day until it says "done".
 *
 *   tsx scripts/load-day.ts <load dir> [--budget 85000] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: tsx scripts/load-day.ts <load dir> [--budget N] [--dry-run]");
const bi = process.argv.indexOf("--budget");
const budget = bi > 0 ? Number(process.argv[bi + 1]) : 85_000;
const dry = process.argv.includes("--dry-run");
const WRITES_PER_ROW: Record<string, number> = { chars: 2, "entries-hsk": 7, entries: 7 };

const plan = JSON.parse(readFileSync(`${dir}/files.json`, "utf8")) as { tag: string; files: { file: string; rows: number; kind: string }[] };
const statePath = `${dir}/state.json`;
interface State { done: string[]; days: Record<string, number>; metaDone?: boolean }
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { done: [], days: {} };
const today = new Date().toISOString().slice(0, 10);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1));

function run(file: string): number {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "opencidian", "--remote", "--yes", "--json", "--file", `${dir}/${file}`], { encoding: "utf8", maxBuffer: 1 << 28 });
  const res = JSON.parse(out.slice(out.indexOf("["))) as { meta?: { rows_written?: number } }[];
  return res.reduce((s, r) => s + (r.meta?.rows_written ?? 0), 0);
}

let used = state.days[today] ?? 0;
if (!state.metaDone && !dry) { used += run("meta.sql"); state.metaDone = true; state.days[today] = used; save(); }
const todo = plan.files.filter((f) => !state.done.includes(f.file));
for (const f of todo) {
  const est = f.rows * (WRITES_PER_ROW[f.kind] ?? 7);
  if (used + est > budget) break;
  if (dry) { console.log(`would run ${f.file} (~${est})`); used += est; continue; }
  const w = run(f.file);
  used += w;
  state.done.push(f.file);
  state.days[today] = used;
  save();
  console.log(`${f.file}: ${w} rows written (today ${used}/${budget})`);
}
const left = plan.files.filter((f) => !state.done.includes(f.file));
const leftWrites = left.reduce((s, f) => s + f.rows * (WRITES_PER_ROW[f.kind] ?? 7), 0);
console.log(left.length ? `today ${used}; ${left.length} files left (~${leftWrites} writes, ~${Math.ceil(leftWrites / budget)} more days). Run again after 00:00 UTC.` : `done: ${plan.tag} fully loaded`);
