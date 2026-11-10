import assert from "node:assert/strict";
import { before, test } from "node:test";
import { annotate } from "../src/lib/annotate.ts";
import { byMeaning, getChar, lookup, suggest, wordsWith } from "../src/lib/queries.ts";
import { syncRelease } from "../src/lib/sync.ts";
import { testD1 } from "./d1.ts";
import { fixtureRelease } from "./helpers.ts";
import { SENTENCES } from "./sentences.ts";

let db: D1Database;
before(async () => {
  db = testD1().db;
  await syncRelease(db, fixtureRelease());
});

test("lookup by hanzi: exact word first, simplified or traditional", async () => {
  const r = await lookup(db, "觉得", 5);
  assert.deepEqual(r.kinds, ["hanzi"]);
  assert.equal(r.entries[0]!.id, "觉得|覺得|jue2 de5");
  assert.equal((await lookup(db, "覺得", 5)).entries[0]!.id, "觉得|覺得|jue2 de5");
});

test("one character with two pronunciations returns both (觉 jué, jiào)", async () => {
  const ids = (await lookup(db, "觉", 10)).entries.filter((e) => e.simp === "觉").map((e) => e.pinyin);
  assert.ok(ids.includes("jué") && ids.includes("jiào"), ids.join(","));
});

test("lookup by pinyin: with tone marks, tone numbers, or none", async () => {
  for (const q of ["jué de", "juéde", "jue2 de5", "juede", "jue de"]) {
    const r = await lookup(db, q, 5);
    assert.equal(r.kinds[0], "pinyin", q);
    assert.ok(r.entries.some((e) => e.id === "觉得|覺得|jue2 de5"), q);
  }
  // A tone that doesn't match finds nothing for that word.
  assert.ok(!(await lookup(db, "jue4 de5", 5, "pinyin")).entries.some((e) => e.id === "觉得|覺得|jue2 de5"));
});

test("lookup by Vietnamese, with or without diacritics: an exact sense ranks first", async () => {
  for (const q of ["cảm thấy", "cam thay"]) {
    const r = await lookup(db, q, 5);
    assert.ok(r.kinds.includes("vi"), q);
    const top = r.entries.filter((e) => e.match === "vi")[0]!;
    assert.ok(top.vi!.senses.some((s) => s.split(/[;,]/).some((p) => p.trim() === "cảm thấy")), `${q}: ${top.id}`);
  }
});

test("search by English meaning", async () => {
  const r = await byMeaning(db, "to feel", "en", 8);
  const ids = r.map((e) => e.id);
  assert.ok(ids.includes("觉|覺|jue2") && ids.includes("感觉|感覺|gan3 jue2"), ids.join(", "));
});

test("words with a character: HSK words first, the character itself left out", async () => {
  const r = await wordsWith(db, "觉", 10);
  assert.ok(r.length > 3);
  assert.ok(r.every((e) => e.simp.includes("觉") && [...e.simp].length > 1));
  assert.equal(r[0]!.hsk?.hsk3 ?? r[0]!.hsk?.hsk2, 1, "an HSK 1 word first");
  assert.ok(r.slice(0, 5).some((e) => e.simp === "觉得"));
});

test("a character record carries its Hán Việt and breakdown", async () => {
  const c = (await getChar(db, "说")) as { hanviet: { readings: string[] }; decomposition: { ids: string } };
  assert.equal(c.hanviet.readings[0], "thuyết");
  assert.equal(c.decomposition.ids, "⿰讠兑");
});

test("suggest: hanzi prefix and pinyin prefix", async () => {
  assert.ok((await suggest(db, "觉", 8)).some((s) => s.simp === "觉得"));
  assert.ok((await suggest(db, "jued", 8)).some((s) => s.simp === "觉得"));
});

for (const s of SENTENCES) {
  test(`annotate a lesson sentence (${s.lesson}): ${s.text}`, { todo: s.todo }, async () => {
    const tokens = await annotate(db, s.text);
    assert.deepEqual(tokens.map((t) => t.text), s.words);
    for (const t of tokens.filter((t) => t.kind === "word")) {
      assert.ok(t.pinyin, t.text);
      assert.equal(t.hanviet!.length, [...t.text].length, t.text);
    }
  });
}

test("annotate gives Hán Việt for every character of a word", async () => {
  const t = (await annotate(db, "认识")).find((x) => x.text === "认识")!;
  assert.deepEqual(t.hanviet!.map((h) => h.readings[0]), ["nhận", "thức"]);
});
