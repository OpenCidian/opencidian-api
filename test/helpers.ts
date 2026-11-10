import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ReleaseInput } from "../src/lib/sync.ts";

const FIX = join(import.meta.dirname, "fixtures");

export function fixtureLines(name: "entries" | "chars"): string[] {
  return gunzipSync(readFileSync(join(FIX, `${name}.jsonl.gz`))).toString("utf8").trim().split("\n");
}

async function* iter(lines: string[]) { yield* lines; }

export function fixtureRelease(tag = "data-test", edit?: { entries?: (l: string[]) => string[] }): ReleaseInput {
  const entries = fixtureLines("entries");
  return {
    tag,
    meta: JSON.parse(readFileSync(join(FIX, "meta.json"), "utf8")),
    entries: iter(edit?.entries ? edit.entries(entries) : entries),
    chars: iter(fixtureLines("chars")),
  };
}
