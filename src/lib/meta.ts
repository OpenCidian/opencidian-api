/** The dataset's meta.json (stored at sync), cut down to what every response carries. */

export interface ResponseMeta {
  dataset: string | null;
  license: string;
  licenseUrl: string;
  attribution: string;
}

const FALLBACK: ResponseMeta = {
  dataset: null,
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "OpenCidian by Perxel (github.com/OpenCidian)",
};

let cached: { at: number; meta: ResponseMeta; full: unknown } | null = null;

export async function datasetMeta(db: D1Database): Promise<{ meta: ResponseMeta; full: unknown }> {
  if (cached && Date.now() - cached.at < 60_000) return cached;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'dataset'").first<{ value: string }>();
  if (!row) return { meta: FALLBACK, full: null };
  const full = JSON.parse(row.value) as { version: string; license: { url: string; attribution: string } };
  const meta: ResponseMeta = { dataset: full.version, license: "CC BY-SA 4.0", licenseUrl: full.license.url, attribution: full.license.attribution };
  cached = { at: Date.now(), meta, full };
  return cached;
}

export function resetMetaCache(): void {
  cached = null;
}
