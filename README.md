# opencidian-api

The API behind OpenCidian by Perxel, an open Chinese ↔ Vietnamese dictionary: a Cloudflare Worker (Hono) over D1, loaded from [opencidian-data](https://github.com/OpenCidian/opencidian-data)'s releases.

**It is internal.** Every `/v1` route answers 404 unless the caller is [opencidian-mcp](https://github.com/OpenCidian/opencidian-mcp) (`X-MCP-Secret`, over its service binding) or Hiểu Chữ Hán's server (`X-API-Secret`). The public way in is the MCP server. This Worker is the only thing that reads or writes D1 or holds the GitHub token.

## Routes

| Route | What it answers |
|---|---|
| `GET /v1/lookup?q=&by=&limit=` | One box: hanzi (simplified or traditional), pinyin (tone marks, tone numbers or none) or Vietnamese (with or without diacritics). `by` forces `hanzi`, `pinyin` or `vi`. Each entry says how it matched. |
| `GET /v1/entries/{id}` | One entry by `simp\|trad\|pinyin` (URL-encoded) |
| `GET /v1/chars/{char}` | A character: Hán Việt, pinyin, radical, strokes, breakdown, meaning and sound parts |
| `GET /v1/words-with/{char}?limit=` | Words that contain a character, HSK words first |
| `GET /v1/search?meaning=&lang=vi\|en` | Reverse lookup by meaning |
| `POST /v1/annotate` `{ "text": "…" }` | Text split into words (longest match), each with pinyin, Hán Việt per character and meaning |
| `GET /v1/suggest?q=` | Search as you type (hanzi prefix, pinyin being typed, start of a Vietnamese meaning) |
| `POST /v1/corrections` | Opens a public issue in opencidian-data with the Correction form's fields, labelled `from-ai` or `from-app`. Rate-limited per caller. Never touches D1. |
| `GET /v1/meta` | Dataset version, sources, licence, last sync |
| `POST /internal/sync` | `X-Sync-Secret`. Loads a release (`{ "tag": … }`, default the latest) |

Every `/v1` answer is `{ data, meta: { dataset, license, licenseUrl, attribution } }`. The data is CC BY-SA 4.0.

## Sync

`POST /internal/sync` reads the release's `entries.jsonl.gz`, `chars.jsonl.gz` and `meta.json` from GitHub, compares each line's hash with D1, and writes only what changed. Rows go in about 1 MB batches as one JSON parameter unpacked with `json_each`, because D1 allows 1,000 queries per call and 100 parameters per query. Measured locally (wrangler dev, workerd D1) on release `data-2026-11-10-19f6dfd`: the first load is 125,397 entries and 14,534 characters in 10.7 s and 390 queries; a sync with nothing new takes 3 s and 5 queries. It needs Workers Paid (`limits.cpu_ms`).

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars   # MCP_SECRET, API_SECRET, SYNC_SECRET, GITHUB_TOKEN
pnpm db:migrate:local
pnpm dev                         # http://localhost:8788
curl -X POST -H "X-Sync-Secret: …" localhost:8788/internal/sync
pnpm test                        # real SQL on node:sqlite, real entries from test/fixtures
pnpm typecheck
pnpm fixtures -- ../opencidian-data/dist   # refresh the fixture slice from a build
```

`test/sentences.ts` holds lesson sentences from the OUC course (Kỹ năng đọc 1) and how they should split. One is a known gap: 大卫是哪国人 splits as 哪|国人, because CC-CEDICT has 国人 and longest match has no word frequencies to prefer 哪|国|人.

OpenCidian by [Perxel](https://perxel.com). Code MIT; data CC BY-SA 4.0.
