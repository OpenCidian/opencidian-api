import assert from "node:assert/strict";
import { before, test } from "node:test";
import app, { API_SECRET_HEADER, MCP_SECRET_HEADER, SYNC_SECRET_HEADER } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";
import { issueBody, quote } from "../src/lib/corrections.ts";
import { resetMetaCache } from "../src/lib/meta.ts";
import { syncRelease } from "../src/lib/sync.ts";
import { testD1 } from "./d1.ts";
import { fixtureRelease } from "./helpers.ts";

let env: Bindings;
const limiter = { calls: 0, limit: async () => ({ success: ++limiter.calls <= 2 }) };
before(async () => {
  const { db } = testD1();
  await syncRelease(db, fixtureRelease());
  resetMetaCache();
  env = { DB: db, CORRECTIONS_LIMITER: limiter as unknown as RateLimit, DATA_REPO: "OpenCidian/opencidian-data", GITHUB_API_URL: "https://api.test", MCP_SECRET: "mcp", API_SECRET: "app", SYNC_SECRET: "sync" };
});

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, env);

test("the lock: every /v1 route is 404 without a secret, or with a wrong one", async () => {
  for (const p of ["/v1/lookup?q=觉得", "/v1/meta", "/v1/chars/说", "/v1/nope", "/"]) {
    assert.equal((await get(p)).status, 404, p);
    assert.equal((await get(p, { [MCP_SECRET_HEADER]: "wrong" })).status, 404, p);
  }
  const closed = await app.request("/v1/meta", { headers: { [MCP_SECRET_HEADER]: "" } }, { ...env, MCP_SECRET: undefined, API_SECRET: undefined });
  assert.equal(closed.status, 404);
});

test("the MCP secret and the app secret both open /v1; answers carry the dataset and licence", async () => {
  for (const h of [{ [MCP_SECRET_HEADER]: "mcp" }, { [API_SECRET_HEADER]: "app" }] as Record<string, string>[]) {
    const res = await get(`/v1/lookup?q=${encodeURIComponent("觉得")}`, h);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { entries: { id: string }[] }; meta: { dataset: string; license: string; attribution: string } };
    assert.equal(body.data.entries[0]!.id, "觉得|覺得|jue2 de5");
    assert.equal(body.meta.license, "CC BY-SA 4.0");
    assert.ok(body.meta.dataset);
    assert.ok(body.meta.attribution.includes("Perxel"));
  }
});

test("entries by id, and a missing one is 404", async () => {
  const h = { [MCP_SECRET_HEADER]: "mcp" };
  assert.equal((await get(`/v1/entries/${encodeURIComponent("觉得|覺得|jue2 de5")}`, h)).status, 200);
  assert.equal((await get(`/v1/entries/${encodeURIComponent("没有|沒有|xx5")}`, h)).status, 404);
  assert.equal((await get("/v1/chars/ab", h)).status, 400);
});

test("annotate over HTTP", async () => {
  const res = await app.request("/v1/annotate", { method: "POST", headers: { [MCP_SECRET_HEADER]: "mcp", "content-type": "application/json" }, body: JSON.stringify({ text: "很高兴认识你。" }) }, env);
  const body = (await res.json()) as { data: { text: string }[] };
  assert.deepEqual(body.data.map((t) => t.text), ["很", "高兴", "认识", "你", "。"]);
});

test("/internal/sync needs its own secret", async () => {
  assert.equal((await app.request("/internal/sync", { method: "POST" }, env)).status, 401);
  assert.equal((await app.request("/internal/sync", { method: "POST", headers: { [SYNC_SECRET_HEADER]: "mcp" } }, env)).status, 401);
  assert.equal((await app.request("/internal/sync", { method: "POST" }, { ...env, SYNC_SECRET: undefined })).status, 503);
});

test("corrections: validated, rate-limited, and closed without a GitHub token", async () => {
  const post = (body: unknown) =>
    app.request("/v1/corrections", { method: "POST", headers: { [MCP_SECRET_HEADER]: "mcp", "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  assert.equal((await post({ word: "办" })).status, 400);
  const good = { word: "办", field: "hanviet", suggested: "biện", evidence: "Thiều Chửu" };
  limiter.calls = 0;
  assert.equal((await post(good)).status, 503, "no GITHUB_TOKEN");
  assert.equal((await post(good)).status, 503);
  assert.equal((await post(good)).status, 429, "third call in the window");
});

test("an issue from the MCP is labelled and can't mention or link anyone", () => {
  const { title, body, labels } = issueBody({ word: "办", field: "hanviet", suggested: "biện @someone", evidence: "see #12 <script>" }, "mcp");
  assert.equal(title, "Correction: 办");
  assert.deepEqual(labels, ["correction", "from-ai", "hanviet"]);
  assert.ok(body.includes("OpenCidian MCP (an AI assistant)"));
  assert.ok(!body.includes("@someone") && !body.includes("#12") && !body.includes("<script>"));
  assert.equal(quote(""), "_No response_");
});
