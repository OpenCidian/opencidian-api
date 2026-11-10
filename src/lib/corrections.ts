/**
 * A suggestion becomes a public GitHub issue in opencidian-data, in the same shape as the Correction form.
 * It never touches D1: a maintainer turns it into a correction file.
 */
import type { Caller } from "../env.ts";

export interface Suggestion {
  word: string;
  pinyin?: string;
  field: "hanviet" | "vi" | "en" | "pinyin" | "missing" | "other";
  current?: string;
  suggested: string;
  evidence: string;
}

const FIELD_LABEL: Record<Suggestion["field"], string> = {
  hanviet: "Hán Việt reading / Âm Hán Việt",
  vi: "Vietnamese meaning / Nghĩa tiếng Việt",
  en: "English definition / Nghĩa tiếng Anh",
  pinyin: "Pinyin",
  missing: "Missing word / Thiếu từ",
  other: "Other / Khác",
};
const FIELD_TOPIC: Partial<Record<Suggestion["field"], string>> = { hanviet: "hanviet", vi: "meaning", en: "meaning", pinyin: "pinyin" };
const SOURCE: Record<Caller, { label: string; from: string }> = {
  mcp: { label: "from-ai", from: "OpenCidian MCP (an AI assistant)" },
  app: { label: "from-app", from: "Hiểu Chữ Hán" },
};

/** Markdown that GitHub won't turn into mentions, links to other issues, or HTML. */
export function quote(s: string | undefined): string {
  if (!s?.trim()) return "_No response_";
  return s.trim().replace(/@/g, "@​").replace(/#(\d)/g, "#​$1").replace(/</g, "&lt;");
}

export function issueBody(s: Suggestion, caller: Caller): { title: string; body: string; labels: string[] } {
  const title = `Correction: ${s.word.replace(/[\r\n]/g, " ")}${s.pinyin ? ` [${s.pinyin.replace(/[\r\n]/g, " ")}]` : ""}`.slice(0, 120);
  const body = [
    ["Word or character / Từ hoặc chữ", s.word],
    ["Pronunciation (pinyin), if the fix is for one reading only / Pinyin, nếu chỉ sửa cho một cách đọc", s.pinyin],
    ["What is wrong / Sai ở đâu", FIELD_LABEL[s.field]],
    ["Current value / Giá trị hiện tại", s.current],
    ["Suggested value / Giá trị đề xuất", s.suggested],
    ["Evidence / Nguồn dẫn chứng", s.evidence],
    ["Sent from / Gửi từ", SOURCE[caller].from],
  ]
    .map(([h, v]) => `### ${h}\n\n${h === "What is wrong / Sai ở đâu" || h === "Sent from / Gửi từ" ? v : quote(v)}`)
    .join("\n\n");
  const labels = ["correction", SOURCE[caller].label, ...(FIELD_TOPIC[s.field] ? [FIELD_TOPIC[s.field]!] : [])];
  return { title, body, labels };
}

export async function openIssue(
  gh: { api: string; repo: string; token: string; fetch?: typeof fetch },
  s: Suggestion,
  caller: Caller,
): Promise<{ number: number; url: string }> {
  const f = gh.fetch ?? fetch;
  const res = await f(`${gh.api}/repos/${gh.repo}/issues`, {
    method: "POST",
    headers: { authorization: `Bearer ${gh.token}`, accept: "application/vnd.github+json", "user-agent": "opencidian-api", "content-type": "application/json" },
    body: JSON.stringify(issueBody(s, caller)),
  });
  if (!res.ok) throw new Error(`GitHub issue: HTTP ${res.status} ${await res.text()}`);
  const issue = (await res.json()) as { number: number; html_url: string };
  return { number: issue.number, url: issue.html_url };
}
