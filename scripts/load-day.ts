/**
 * Run the next files of a load made by scripts/load-sql.ts against the remote D1, until today's budget
 * of rows written (UTC day) would be passed. D1 Free fails every query, reads too, on EVERY database of
 * the account (openrace, perxel-mcp-ask, ...) once the account passes 100K rows written in a day. So the
 * budget counts the whole account: today's rows written from Cloudflare's GraphQL analytics (with
 * wrangler's login), falling back to this script's own count if that fails. 85K leaves room for the rest.
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

/** Rows written today by every D1 database of the account, or null if analytics can't be read. */
function accountWritesToday(): number | null {
  try {
    const who = execFileSync("npx", ["wrangler", "whoami"], { encoding: "utf8" }); // also refreshes the OAuth token
    const account = who.match(/[0-9a-f]{32}/)?.[0];
    const cfg = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, "utf8");
    const token = cfg.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
    if (!account || !token) return null;
    const query = `{viewer{accounts(filter:{accountTag:"${account}"}){d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:"${today}"}){sum{rowsWritten}}}}}`;
    const out = execFileSync("curl", ["-sf", "https://api.cloudflare.com/client/v4/graphql", "-H", `Authorization: Bearer ${token}`, "-H", "content-type: application/json", "-d", JSON.stringify({ query })], { encoding: "utf8" });
    const groups = JSON.parse(out).data.viewer.accounts[0].d1AnalyticsAdaptiveGroups as { sum: { rowsWritten: number } }[];
    return groups.reduce((t, g) => t + g.sum.rowsWritten, 0);
  } catch (e) {
    console.error(String(e).split("\n")[0]);
    return null;
  }
}

const account = accountWritesToday();
console.log(account === null ? "account analytics unavailable: budget counts this script's own writes" : `account rows written today so far: ${account}`);
let used = Math.max(account ?? 0, state.days[today] ?? 0);
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
