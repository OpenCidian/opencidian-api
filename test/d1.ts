/**
 * A D1Database over node:sqlite, with the migrations applied, so the tests run the real SQL
 * (json_each batches, FTS5, ranking). Covers the parts of the D1 API the Worker uses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";

// Workers has crypto.subtle.timingSafeEqual (used by secretsMatch); Node doesn't.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a as ArrayBuffer), new Uint8Array(b as ArrayBuffer));

const MIGRATIONS = join(import.meta.dirname, "../migrations");

class Stmt {
  queries = 0;
  constructor(private db: DatabaseSync, private sql: string, private params: SQLInputValue[] = [], private counter: { n: number }) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params as SQLInputValue[], this.counter);
  }
  async all<T>() {
    this.counter.n++;
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }
  async first<T>() {
    this.counter.n++;
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async run() {
    this.counter.n++;
    this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: {} };
  }
}

export function testD1(): { db: D1Database; sqlite: DatabaseSync; queries: { n: number } } {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  const queries = { n: 0 };
  const db = {
    prepare: (sql: string) => new Stmt(sqlite, sql, [], queries),
    batch: async (stmts: Stmt[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;
  return { db, sqlite, queries };
}
