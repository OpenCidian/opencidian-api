import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Caller } from "./env.ts";
import { annotate, MAX_TEXT } from "./lib/annotate.ts";
import { openIssue } from "./lib/corrections.ts";
import { datasetMeta, resetMetaCache } from "./lib/meta.ts";
import { byMeaning, getChar, getEntry, lookup, suggest, wordsWith } from "./lib/queries.ts";
import { secretsMatch } from "./lib/secret.ts";
import { fetchRelease, syncRelease } from "./lib/sync.ts";

export const MCP_SECRET_HEADER = "X-MCP-Secret";
export const API_SECRET_HEADER = "X-API-Secret";
export const SYNC_SECRET_HEADER = "X-Sync-Secret";

const app = new Hono<AppEnv>();

const notFound = (c: Context) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
const bad = (c: Context, message: string) => c.json({ error: { code: "BAD_REQUEST", message } }, 400);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
});
app.notFound(notFound);

/**
 * The API is internal: /v1 answers 404 unless the caller is opencidian-mcp (X-MCP-Secret, over its service
 * binding) or hieu-chu-han's server (X-API-Secret). With a secret unset, nothing matches it: closed, never open.
 */
app.use("/v1/*", async (c, next) => {
  const checks: [Caller, string | undefined, string | undefined][] = [
    ["mcp", c.env.MCP_SECRET, c.req.header(MCP_SECRET_HEADER)],
    ["app", c.env.API_SECRET, c.req.header(API_SECRET_HEADER)],
  ];
  for (const [caller, expected, provided] of checks) {
    if (expected && provided && (await secretsMatch(provided, expected))) {
      c.set("caller", caller);
      return next();
    }
  }
  return notFound(c);
});

/** Every answer: { data, meta: { dataset, license, licenseUrl, attribution } }. */
async function ok(c: Context<AppEnv>, data: unknown) {
  const { meta } = await datasetMeta(c.env.DB);
  return c.json({ data, meta });
}

const limitOf = (v: string | undefined, def: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.trunc(n)), max) : def;
};
const ONE_HAN = /^\p{Script=Han}$/u;

app.get("/v1/lookup", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return bad(c, "q is required");
  const by = c.req.query("by");
  if (by && !["hanzi", "pinyin", "vi"].includes(by)) return bad(c, "by is hanzi, pinyin or vi");
  return ok(c, await lookup(c.env.DB, q.slice(0, 100), limitOf(c.req.query("limit"), 10, 50), by as "hanzi" | "pinyin" | "vi" | undefined));
});

app.get("/v1/entries/:id", async (c) => {
  const e = await getEntry(c.env.DB, c.req.param("id"));
  return e ? ok(c, e) : c.json({ error: { code: "NOT_FOUND", message: "No such entry" } }, 404);
});

app.get("/v1/chars/:char", async (c) => {
  const ch = c.req.param("char");
  if (!ONE_HAN.test(ch)) return bad(c, "one Han character");
  const rec = await getChar(c.env.DB, ch);
  return rec ? ok(c, rec) : c.json({ error: { code: "NOT_FOUND", message: "Character not in the dataset" } }, 404);
});

app.get("/v1/words-with/:char", async (c) => {
  const ch = c.req.param("char");
  if (!ONE_HAN.test(ch)) return bad(c, "one Han character");
  return ok(c, await wordsWith(c.env.DB, ch, limitOf(c.req.query("limit"), 20, 100)));
});

app.get("/v1/search", async (c) => {
  const meaning = c.req.query("meaning")?.trim();
  const lang = c.req.query("lang") ?? "vi";
  if (!meaning) return bad(c, "meaning is required");
  if (lang !== "vi" && lang !== "en") return bad(c, "lang is vi or en");
  return ok(c, await byMeaning(c.env.DB, meaning.slice(0, 100), lang, limitOf(c.req.query("limit"), 10, 50)));
});

app.get("/v1/suggest", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return ok(c, []);
  return ok(c, await suggest(c.env.DB, q.slice(0, 50), limitOf(c.req.query("limit"), 8, 20)));
});

app.post("/v1/annotate", async (c) => {
  const body = z.object({ text: z.string().min(1).max(MAX_TEXT) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, `text is required, up to ${MAX_TEXT} characters`);
  return ok(c, await annotate(c.env.DB, body.data.text));
});

export const CorrectionInput = z.object({
  word: z.string().trim().min(1).max(40),
  pinyin: z.string().trim().max(60).optional(),
  field: z.enum(["hanviet", "vi", "en", "pinyin", "missing", "other"]),
  current: z.string().trim().max(2000).optional(),
  suggested: z.string().trim().min(1).max(2000),
  evidence: z.string().trim().min(1).max(2000),
  /** An opaque id for the end user (hashed by the caller), for the rate limit. Never published. */
  callerId: z.string().max(100).optional(),
});

app.post("/v1/corrections", async (c) => {
  const body = CorrectionInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const caller = c.get("caller");
  const key = `${caller}:${body.data.callerId ?? c.req.header("cf-connecting-ip") ?? "anon"}`;
  const { success } = await c.env.CORRECTIONS_LIMITER.limit({ key });
  if (!success) return c.json({ error: { code: "RATE_LIMITED", message: "Too many suggestions; try again in a minute" } }, 429);
  if (!c.env.GITHUB_TOKEN) return c.json({ error: { code: "DISABLED", message: "Corrections are not configured" } }, 503);
  const issue = await openIssue({ api: c.env.GITHUB_API_URL, repo: c.env.DATA_REPO, token: c.env.GITHUB_TOKEN }, body.data, caller);
  return ok(c, issue);
});

app.get("/v1/meta", async (c) => {
  const { full } = await datasetMeta(c.env.DB);
  const rows = (await c.env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('release_tag', 'synced_at')").all<{ key: string; value: string }>()).results;
  return ok(c, { dataset: full, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

/** Called by opencidian-data's release workflow. Body (optional): { "tag": "data-…" }; default: the latest release. */
app.post("/internal/sync", async (c) => {
  const expected = c.env.SYNC_SECRET;
  if (!expected) return c.json({ error: { code: "SYNC_DISABLED", message: "SYNC_SECRET is not configured" } }, 503);
  const provided = c.req.header(SYNC_SECRET_HEADER);
  if (!provided || !(await secretsMatch(provided, expected))) return c.json({ error: { code: "UNAUTHORIZED", message: `Missing or invalid ${SYNC_SECRET_HEADER}` } }, 401);
  const body = z.object({ tag: z.string().max(100).optional() }).safeParse(await c.req.json().catch(() => ({})));
  const release = await fetchRelease({ api: c.env.GITHUB_API_URL, repo: c.env.DATA_REPO, token: c.env.GITHUB_TOKEN, tag: body.success ? body.data.tag : undefined });
  const result = await syncRelease(c.env.DB, release);
  resetMetaCache();
  return c.json({ data: result });
});

export default app;
