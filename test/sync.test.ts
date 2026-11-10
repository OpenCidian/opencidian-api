import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fetchRelease, syncRelease } from "../src/lib/sync.ts";
import { testD1 } from "./d1.ts";
import { fixtureLines, fixtureRelease } from "./helpers.ts";

test("first sync loads everything, in a handful of queries", async () => {
  const { db, sqlite, queries } = testD1();
  const r = await syncRelease(db, fixtureRelease());
  const n = fixtureLines("entries").length;
  assert.equal(r.entries.total, n);
  assert.equal(r.entries.written, n);
  assert.equal(r.chars.written, fixtureLines("chars").length);
  assert.equal((sqlite.prepare("SELECT count(*) n FROM entries").get() as { n: number }).n, n);
  assert.equal((sqlite.prepare("SELECT count(*) n FROM entries_fts").get() as { n: number }).n, n);
  assert.ok(queries.n < 15, `${queries.n} queries`);
  const meta = sqlite.prepare("SELECT value FROM meta WHERE key = 'release_tag'").get() as { value: string };
  assert.equal(meta.value, "data-test");
});

test("a second sync of the same release writes nothing; a changed or removed line is the only write", async () => {
  const { db, sqlite } = testD1();
  await syncRelease(db, fixtureRelease());
  const again = await syncRelease(db, fixtureRelease());
  assert.deepEqual([again.entries.written, again.entries.deleted, again.chars.written], [0, 0, 0]);

  const target = '"id":"觉得|覺得|jue2 de5"';
  const edited = await syncRelease(
    db,
    fixtureRelease("data-test-2", {
      entries: (lines) =>
        lines
          .filter((l) => !l.includes('"id":"觉|覺|jiao4"'))
          .map((l) => (l.includes(target) ? l.replace('"src":"cvdict"', '"src":"correction"') : l)),
    }),
  );
  assert.equal(edited.entries.written, 1);
  assert.equal(edited.entries.deleted, 1);
  const row = sqlite.prepare("SELECT data FROM entries WHERE id = ?").get("觉得|覺得|jue2 de5") as { data: string };
  assert.equal(JSON.parse(row.data).vi.src, "correction");
  assert.equal(sqlite.prepare("SELECT 1 FROM entries WHERE id = ?").get("觉|覺|jiao4"), undefined);
  // The FTS index follows: one row per entry, none left behind for the deleted one.
  const counts = sqlite.prepare("SELECT (SELECT count(*) FROM entries) e, (SELECT count(*) FROM entries_fts) f").get() as { e: number; f: number };
  assert.equal(counts.e, counts.f);
});

test("fetchRelease reads a GitHub release (assets through the API, gzip streamed)", async () => {
  const FIX = join(import.meta.dirname, "fixtures");
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const h = new Headers(init?.headers);
    assert.equal(h.get("authorization"), "Bearer tok");
    if (url.endsWith("/releases/latest")) {
      return Response.json({
        tag_name: "data-x",
        assets: ["entries.jsonl.gz", "chars.jsonl.gz", "meta.json"].map((name) => ({ name, url: `https://api.test/assets/${name}` })),
      });
    }
    const name = url.split("/").pop()!;
    assert.equal(h.get("accept"), "application/octet-stream");
    return new Response(readFileSync(join(FIX, name)));
  }) as typeof fetch;
  const rel = await fetchRelease({ api: "https://api.test", repo: "OpenCidian/opencidian-data", token: "tok", fetch: fakeFetch });
  const { db } = testD1();
  const r = await syncRelease(db, rel);
  assert.equal(r.tag, "data-x");
  assert.equal(r.entries.total, fixtureLines("entries").length);
  assert.ok(calls[0]!.endsWith("/repos/OpenCidian/opencidian-data/releases/latest"));
});
