import { match } from "ts-pattern";
import type { PageState } from "./state.ts";
import type { Ticket } from "./ticket.ts";

/** decideEligibility が必要とする設定値のみを narrow に受け取る（Config 全体には依存しない）。 */
export interface EligibilityConfig {
  triggerLanes: string[];
  conditionValue: string;
}

export interface EligibilityDecision {
  eligible: boolean;
  reason: string;
  /** 人間による差し戻し再実行（done/failed からのやり直し）。attempt をリセットする。 */
  rework?: boolean;
  /** eligible な resume（rework 含む）の種別。attempt=1 で ResumeContext を組む。 */
  resumeKind?: ResumeContext["kind"];
  /**
   * needs_info でコメント確認が未実施（needsInfoAnswered 未指定）。
   * 呼び出し側にコメント確認（checkNeedsInfoAnswers）を要求する。
   */
  needsCommentCheck?: boolean;
}

/** resume（rework / CI 修正 / レビュー対応 / 質問回答）実行に引き継ぐ前回実行のコンテキスト。 */
export interface ResumeContext {
  kind: "human_rework" | "ci_failure" | "review_changes" | "needs_info_answer";
  /** 前回作成した PR（同じ PR を更新させるためプロンプトへ渡す）。 */
  prUrl?: string;
  /** 基準時刻（done/failed 記録時刻 or questionAskedAt）。これより新しいコメントを拾う。 */
  since?: string;
  /** needs_info_answer 用: 前回自分が投げた質問。 */
  question?: string;
  /** ci_failure 用: 失敗 check の要約 + ログ。 */
  ciFailures?: string;
  /** review_changes 用: CHANGES_REQUESTED レビュー一覧。 */
  reviews?: Array<{ author: string; body: string; submittedAt: string }>;
}

/**
 * ディスパッチ可否判定（純粋関数）。
 * 候補クエリ自体がレーン/実行環境でフィルタ済みだが、config 再読込との
 * ずれに備えてここでも検証する。
 *
 * done の再実行（rework）: 成功時に記録した lastEditedTime よりページの
 * last_edited_time が進んでいれば「人間がカードを触って差し戻した」とみなす。
 * 成功直後に結果整合性で古い lane=In Progress が返ってきても、
 * last_edited_time は記録値以下なので二重実行にはならない。
 */
export function decideEligibility(opts: {
  ticket: Ticket;
  cfg: EligibilityConfig;
  isActive: boolean;
  ps: PageState | undefined;
  /**
   * needs_info の回答コメント有無（checkNeedsInfoAnswers の結果）。
   * true=回答あり / false=回答なし / undefined=未確認（needsCommentCheck を返す）。
   */
  needsInfoAnswered?: boolean;
}): EligibilityDecision {
  const { ticket: t, cfg, isActive, ps, needsInfoAnswered } = opts;
  if (!t.repo) return { eligible: false, reason: "リポジトリ未設定" };
  if (!t.lane || !cfg.triggerLanes.includes(t.lane)) {
    return { eligible: false, reason: `レーン対象外(${t.lane})` };
  }
  if (t.condition !== cfg.conditionValue) {
    return { eligible: false, reason: `条件不一致(${t.condition})` };
  }
  if (isActive) {
    return { eligible: false, reason: "処理中" };
  }
  if (!ps) return { eligible: true, reason: "未処理" };

  return match(ps)
    .with({ status: "running" }, () => ({
      eligible: false,
      reason: "running",
    }))
    .with({ status: "done" }, (p) =>
      p.lastEditedTime && t.lastEditedTime > p.lastEditedTime
        ? {
            eligible: true,
            reason: "done→差し戻しで再実行",
            rework: true,
            resumeKind: "human_rework" as const,
          }
        : {
            eligible: false,
            reason: p.lastEditedTime ? "done(差し戻しなし)" : "done(基準時刻なし)",
          },
    )
    .with({ status: "failed" }, (p) =>
      p.lastEditedTime && t.lastEditedTime > p.lastEditedTime
        ? {
            eligible: true,
            reason: "failed→編集後の再実行",
            rework: true,
            resumeKind: "human_rework" as const,
          }
        : { eligible: false, reason: "failed(未編集)" },
    )
    .with({ status: "retry_queued" }, (p) => {
      if (Date.now() >= p.retryAt) {
        return { eligible: true, reason: "retry 満了" };
      }
      const waitS = Math.ceil((p.retryAt - Date.now()) / 1000);
      return { eligible: false, reason: `retry 待ち(${waitS}s)` };
    })
    .with({ status: "needs_info" }, (p) => {
      if (needsInfoAnswered === true) {
        return {
          eligible: true,
          reason: "needs_info→回答コメントあり",
          resumeKind: "needs_info_answer" as const,
        };
      }
      // ページ本文の編集（回答を本文に追記したケース）。回答コメントも一緒に拾う。
      if (p.lastEditedTime && t.lastEditedTime > p.lastEditedTime) {
        return {
          eligible: true,
          reason: "needs_info→ページ本文編集",
          resumeKind: "needs_info_answer" as const,
        };
      }
      if (needsInfoAnswered === undefined) {
        // 呼び出し側にコメント確認（checkNeedsInfoAnswers）を要求する
        return {
          eligible: false,
          reason: "needs_info(コメント未確認)",
          needsCommentCheck: true,
        };
      }
      return { eligible: false, reason: "needs_info(回答待ち)" };
    })
    .exhaustive();
}
