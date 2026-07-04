import { z } from "zod";

export interface AgentResult {
  status: "success" | "failure" | "needs_info";
  prUrl?: string;
  summary?: string;
  reason?: string;
  /** needs_info のとき必須: 人間へ確認したい内容。 */
  question?: string;
  /** claude -p が払い出した session_id。`claude --resume <id>` でネイティブ再開できる。 */
  sessionId?: string;
}

/** claude/PR 由来の GitHub PR URL 抽出。 */
export function extractPrUrl(text: string): string | null {
  const m = text.match(
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/,
  );
  return m ? m[0] : null;
}

/**
 * claude の stdout (stream-json/json) から session_id を抽出する。
 * stream-json は行ごとに session_id を含むため、末尾から走査して最初に見つかったものを採用する。
 */
export function extractSessionId(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { session_id?: unknown };
      if (typeof obj.session_id === "string" && obj.session_id) return obj.session_id;
    } catch {
      /* JSONL 中の非 JSON 行や部分行はスキップ */
    }
  }
  return undefined;
}

/**
 * claude の stdout をパースして最終的な結果 JSON オブジェクトを取り出す。
 * `--output-format stream-json` では 1 行 1 JSON (JSONL) で流れてくるため、
 * 末尾から最初にパースできた JSON オブジェクトを返す（通常 `type:"result"` 行）。
 * 従来の単一 JSON (`--output-format json`) でも 1 行として同じ経路で扱える。
 */
export function parseFinalJson(stdout: string): unknown | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object") return obj;
    } catch {
      /* JSONL 中の非 JSON 行や部分行はスキップ */
    }
  }
  return null;
}

/**
 * result_file が従う自前プロトコル（プロンプトテンプレートで規定）。
 * エージェント自己申告の結果 JSON であり我々が形を決めているので strict に検証する。
 */
const ResultFileSchema = z.object({
  status: z.enum(["success", "failure", "needs_info"]),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
  question: z.string().optional(),
});

/** result_file テキストを AgentResult へ（失敗時 null）。 */
export function parseResultFile(text: string): AgentResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ResultFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const j = parsed.data;

  if (j.status === "success" || j.status === "failure") {
    return { status: j.status, prUrl: j.pr_url, summary: j.summary };
  }

  const question = j.question?.trim() ?? "";
  // 質問なしの needs_info は不正（人間が何に答えればいいか分からない）→ failure に落とす
  if (question === "") {
    return {
      status: "failure",
      reason:
        "needs_info 報告に question がありません（質問なし needs_info は不正）",
      summary: j.summary,
    };
  }
  return { status: "needs_info", question, prUrl: j.pr_url, summary: j.summary };
}

/**
 * 結果判定の 3 段フォールバック。
 *   1. result_file JSON があればそれ
 *   2. exit 0 かつ claude JSON が is_error:false → stdout から PR URL 抽出
 *   3. それ以外 failure
 */
export function judgeResult(opts: {
  resultFileText?: string | null;
  exitCode: number | null;
  stdout: string;
}): AgentResult {
  const sessionId = extractSessionId(opts.stdout);
  if (opts.resultFileText) {
    const fromFile = parseResultFile(opts.resultFileText);
    if (fromFile) return { ...fromFile, sessionId };
  }
  if (opts.exitCode === 0) {
    const parsed = parseFinalJson(opts.stdout) as
      | { is_error?: boolean }
      | null;
    if (parsed && parsed.is_error === true) {
      return { status: "failure", reason: "claude が is_error:true を報告", sessionId };
    }
    const url = extractPrUrl(opts.stdout);
    if (url) return { status: "success", prUrl: url, sessionId };
    return { status: "failure", reason: "PR URL が確認できない", sessionId };
  }
  return {
    status: "failure",
    reason: `claude 異常終了 (exit=${opts.exitCode})`,
    sessionId,
  };
}
