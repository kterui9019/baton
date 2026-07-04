import { match } from "ts-pattern";
import type { ResumeContext } from "../domain/eligibility.ts";

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

export function renderReviewFixSection(opts: {
  prUrl?: string;
  reviews?: Array<{ author: string; body: string; submittedAt: string }>;
}): string {
  const lines: string[] = [
    "# レビュー指摘への対応依頼（changes requested）",
    "",
    "あなたが作成した PR にレビューで修正依頼（changes requested）が来ました。以下の指摘に対応してください。",
    opts.prUrl ? `対象の PR: ${opts.prUrl}` : "対象の PR: （記録なし）",
    "",
    "## レビュー指摘",
    "",
  ];
  const reviews = (opts.reviews ?? []).filter((r) => r.body.trim() !== "");
  if (reviews.length > 0) {
    for (const r of reviews) {
      const ts = r.submittedAt.slice(0, 16).replace("T", " ");
      lines.push(`- [${ts}] @${r.author || "(不明)"}: ${r.body.trim()}`);
    }
  } else {
    lines.push(
      "レビュー本文を取得できませんでした。PR のレビューコメントを `gh pr view --comments` 等で確認して対応してください。",
    );
  }
  lines.push(
    "",
    "## 対応時の作業条件",
    "",
    "- 既存の作業ブランチに追加コミットを積み、同じブランチへ push してください（PR がそのまま更新されます）。PR は作り直さないこと。",
    "- 対応方針が指摘内容と異なる場合は、その理由を PR コメントで説明してください。その際は本文の先頭に「🤖 [baton](https://github.com/kterui9019/baton) 経由の自動エージェントによる返信です」と明記し、人間のレビュワーが自動投稿と分かるようにしてください。",
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
    .with({ kind: "review_changes" }, (c) =>
      renderReviewFixSection({ prUrl: c.prUrl, reviews: c.reviews }),
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
