export interface Bindings {
  DB: D1Database;
  CORRECTIONS_LIMITER: RateLimit;
  DATA_REPO: string;
  GITHUB_API_URL: string;
  MCP_SECRET?: string;
  API_SECRET?: string;
  SYNC_SECRET?: string;
  GITHUB_TOKEN?: string;
}

export type Caller = "mcp" | "app";

export interface AppEnv {
  Bindings: Bindings;
  Variables: { caller: Caller };
}
