-- OpenCidian: the dataset from opencidian-data's releases. Only POST /internal/sync writes here.

-- One row per entry (simp|trad|pinyin). `data` is the entry exactly as the release has it;
-- the other columns exist to find it.
CREATE TABLE entries (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  simp TEXT NOT NULL,
  trad TEXT NOT NULL,
  pinyin_key TEXT NOT NULL,      -- no tones, no spaces, lowercase, ü as v: "juede"
  pinyin_tone_key TEXT NOT NULL, -- with tone numbers, neutral tone dropped: "jue2de"
  hsk INTEGER,                   -- lowest of HSK 3.0 / 2.0, for ranking; NULL when not in HSK
  len INTEGER NOT NULL,          -- characters in simp, for ranking
  has_vi INTEGER NOT NULL,
  data TEXT NOT NULL,
  hash TEXT NOT NULL             -- of the release line, so a sync only rewrites what changed
);
CREATE INDEX entries_simp ON entries (simp);
CREATE INDEX entries_trad ON entries (trad);
CREATE INDEX entries_pinyin_key ON entries (pinyin_key);
CREATE INDEX entries_pinyin_tone_key ON entries (pinyin_tone_key);

-- Full-text search, rowid = entries.rowid.
--   hanzi: every character of simp and trad, space-separated, so one character is one token (words_with)
--   vi, en: the senses, lowercase, đ folded to d; the tokenizer drops the other diacritics
CREATE VIRTUAL TABLE entries_fts USING fts5 (hanzi, vi, en, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE chars (
  char TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- dataset: the release's meta.json; synced_at, release_tag
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
