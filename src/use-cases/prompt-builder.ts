import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { match } from "ts-pattern";
import type { ResumeContext } from "../domain/eligibility.ts";
import type { Ticket } from "../domain/ticket.ts";
import type { WorkspaceInfo } from "../domain/workspace.ts";

export interface FeedbackComment {
  createdTime: string;
  text: string;
}

export interface PromptVars {
  title: string;
  body: string;
  repo: string;
  branch: string;
  base_branch: string;
  page_url: string;
  page_id: string;
  result_file: string;
  attempt: string;
  rework: string;
  [key: string]: string;
}

function commentBullets(comments: FeedbackComment[]): string[] {
  return comments
    .filter((c) => c.text.trim() !== "")
    .map((c) => {
      const ts = c.createdTime.slice(0, 16).replace("T", " ");
      return `- [${ts}] ${c.text.trim()}`;
    });
}

export function renderReworkSection(opts: {
  prUrl?: string;
  comments: FeedbackComment[];
}): string {
  const lines: string[] = [
    "# やり直し依頼（人間レビューによる差し戻し）",
    "",
    "このチケットは一度実装済みですが、人間のレビューで差し戻されました。",
    opts.prUrl ? `前回の PR: ${opts.prUrl}` : "前回の PR: （記録なし）",
    "",
    "## レビューフィードバック（コメント）",
    "",
  ];
  const bullets = commentBullets(opts.comments);
  if (bullets.length > 0) {
    lines.push(...bullets);
  } else {
    lines.push(
      "レビューコメントは見つかりませんでした。チケット本文の追記・変更内容を前回実装と見比べて対応してください。",
    );
  }
  lines.push(
    "",
    "## やり直し時の作業条件",
    "",
    "- フィードバックとチケット本文の最新内容を踏まえて修正してください。",
    "- 既存の作業ブランチに追加コミットを積み、同じブランチへ push してください（前回の PR がそのまま更新されます）。新しい PR は作らないこと。",
    "- 前回の PR が close/merge 済みの場合のみ、新しい PR を作成してください。",
    "- 完了報告の `pr_url` には更新した（既存の）PR の URL を書いてください。",
    "",
  );
  return lines.join("\n");
}

export function renderNeedsInfoResumeSection(opts: {
  question?: string;
  prUrl?: string;
  comments: FeedbackComment[];
}): string {
  const lines: string[] = [
    "# 作業再開（質問への回答受領）",
    "",
    "あなたは前回、以下の質問をして作業を中断しました。人間の回答を踏まえて作業を続行してください。",
    opts.prUrl ? `前回の PR: ${opts.prUrl}` : "前回の PR: （なし）",
    "",
    "## あなたの質問",
    "",
    opts.question?.trim() ? opts.question.trim() : "（質問の記録なし）",
    "",
    "## 人間の回答（コメント）",
    "",
  ];
  const bullets = commentBullets(opts.comments);
  if (bullets.length > 0) {
    lines.push(...bullets);
  } else {
    lines.push(
      "回答コメントは見つかりませんでした。チケット本文の追記・変更内容を確認して対応してください。",
    );
  }
  lines.push(
    "",
    "## 再開時の作業条件",
    "",
    "- 回答内容とチケット本文の最新内容を踏まえて実装を進めてください。",
    "- 前回の PR がある場合は既存の作業ブランチに追加コミットを積み、同じブランチへ push してください（新しい PR は作らないこと）。",
    "- 回答を読んでもなお続行できない場合のみ、再度 needs_info で具体的な質問を報告してください（同じ質問の繰り返しは避けること）。",
    "",
  );
  return lines.join("\n");
}

export function renderCiFixSection(opts: {
  prUrl?: string;
  ciFailures?: string;
}): string {
  const lines: string[] = [
    "# CI 失敗の修正依頼（自動検知）",
    "",
    "あなたが作成した PR の CI が失敗しました。以下の失敗内容を解析して修正してください。",
    opts.prUrl ? `対象の PR: ${opts.prUrl}` : "対象の PR: （記録なし）",
    "",
    "## 失敗した check の要約とログ",
    "",
  ];
  const failures = opts.ciFailures?.trim();
  if (failures) {
    lines.push(failures);
  } else {
    lines.push(
      "失敗ログを取得できませんでした。PR の checks を `gh pr checks` 等で確認し、失敗原因を特定してください。",
    );
  }
  lines.push(
    "",
    "## 修正時の作業条件",
    "",
    "- 既存の作業ブランチに追加コミットを積み、同じブランチへ push してください（PR がそのまま更新されます）。PR は作り直さないこと。",
    "- 修正後は失敗していたテスト・チェックをローカルで再現・実行し、解消したことを確認してから push してください。",
    "- 完了報告の `pr_url` には既存の PR の URL を書いてください。",
    "",
  );
  return lines.join("\n");
}

/** resume 種別に応じたプロンプト差し込みセクションを組み立てる。テンプレート変数 `{{rework}}` に埋め込まれる。 */
export function renderResumeSection(
  ctx: ResumeContext,
  comments: FeedbackComment[],
): string {
  return match(ctx)
    .with({ kind: "human_rework" }, (c) =>
      renderReworkSection({ prUrl: c.prUrl, comments }),
    )
    .with({ kind: "needs_info_answer" }, (c) =>
      renderNeedsInfoResumeSection({ question: c.question, prUrl: c.prUrl, comments }),
    )
    .with({ kind: "ci_failure" }, (c) =>
      renderCiFixSection({ prUrl: c.prUrl, ciFailures: c.ciFailures }),
    )
    .exhaustive();
}

/** `{{var}}` を置換。未定義変数は空文字。 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** dispatch 時にテンプレートへ渡す変数を組む。orchestrator に散らばっていた変数マップの集約。 */
export function buildPromptVars(opts: {
  ticket: Ticket;
  workspace: WorkspaceInfo;
  resultFile: string;
  attempt: number;
  body: string;
  resumeSection: string;
}): PromptVars {
  const { ticket, workspace: ws, resultFile, attempt, body, resumeSection } = opts;
  return {
    title: ticket.title,
    body,
    repo: ticket.repo ?? "",
    branch: ws.branch,
    base_branch: ws.baseBranch,
    page_url: ticket.url,
    page_id: ticket.pageId,
    result_file: resultFile,
    attempt: String(attempt),
    rework: resumeSection,
  };
}

/**
 * テンプレートファイルを読み込んで render する。
 * templatePathConfig が絶対パスならそのまま、相対パスなら dataHome 基準で解決する。
 */
export function renderTemplateFile(
  templatePathConfig: string,
  dataHome: string,
  vars: PromptVars,
): string {
  const path = isAbsolute(templatePathConfig)
    ? templatePathConfig
    : join(dataHome, templatePathConfig);
  const template = readFileSync(path, "utf8");
  return renderTemplate(template, vars);
}

/**
 * dispatch 時に必要な 3 種のプロンプト（本文/システム/resume 用）をまとめて描画する。
 * systemPromptTemplate が "" のときは systemPrompt を undefined にし、
 * `--append-system-prompt` を付与しない。
 */
export function renderDispatchPrompts(opts: {
  dataHome: string;
  templates: {
    prompt: string;
    resumePrompt: string;
    systemPrompt: string;
  };
  vars: PromptVars;
  useNativeResume: boolean;
}): { prompt: string; systemPrompt: string | undefined } {
  const { dataHome, templates, vars, useNativeResume } = opts;
  const prompt = useNativeResume
    ? renderTemplateFile(templates.resumePrompt, dataHome, vars)
    : renderTemplateFile(templates.prompt, dataHome, vars);
  const systemPrompt = templates.systemPrompt
    ? renderTemplateFile(templates.systemPrompt, dataHome, vars)
    : undefined;
  return { prompt, systemPrompt };
}
