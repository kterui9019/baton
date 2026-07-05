import type { PrCheck } from "../domain/review.ts";
import type { TicketUpdate } from "../domain/ticket.ts";
import { hhmm } from "../infrastructure/format.ts";

/**
 * Kanban へ post するアクティビティ 1 行文字列およびコメント本文の生成関数群。
 * すべて純粋関数（日時は hhmm() のみに閉じる）。orchestrator は生成された文字列を
 * KanbanPort.updateTicket / addComment にそのまま渡すだけ。
 */

/** dispatch 開始時のアクティビティ。 */
export function activityStart(opts: {
  agentLabel: string;
  attempt: number;
  resumeKind: "human_rework" | "ci_failure" | "needs_info_answer" | undefined;
}): string {
  const verb = opts.resumeKind
    ? opts.resumeKind === "needs_info_answer"
      ? "再開"
      : "やり直し"
    : "実行";
  return `🤖 ${opts.agentLabel} ${verb}開始 (attempt ${opts.attempt}) — ${hhmm()}`;
}

/**
 * 成功時に KanbanPort.updateTicket に渡す TicketUpdate を組む。
 * - PR あり: prUrl + "CI 待ち" アクティビティ（レーンは動かさない → 監視継続）
 * - PR なし: doneLane 移動 + "完了（PRなし）" アクティビティ
 */
export function ticketUpdateSuccess(prUrl: string | undefined, doneLane: string): TicketUpdate {
  if (prUrl) {
    return { prUrl, activity: `✅ PR 作成完了 — CI 待ち (${hhmm()})` };
  }
  return { lane: doneLane, activity: `✅ 完了（PRなし） — ${hhmm()}` };
}

/** リカバリ経由での成功時に渡す TicketUpdate。 */
export function ticketUpdateRecoveredSuccess(
  prUrl: string | undefined,
  doneLane: string,
): TicketUpdate {
  if (prUrl) {
    return {
      prUrl,
      activity: `✅ PR 作成完了（再起動時に確定） — CI 待ち (${hhmm()})`,
    };
  }
  return {
    lane: doneLane,
    activity: `✅ 完了（PRなし・再起動時に確定） — ${hhmm()}`,
  };
}

/** リトライ待機時のアクティビティ。 */
export function activityRetry(attempt: number, maxAttempts: number, shortReason: string): string {
  return `⚠️ 失敗 (attempt ${attempt}/${maxAttempts})、リトライ待ち: ${shortReason}`;
}

/** 上限到達時のアクティビティ。 */
export function activityFailed(attempt: number, maxAttempts: number, shortReason: string): string {
  return `❌ 失敗 (attempt ${attempt}/${maxAttempts}): ${shortReason}`;
}

/** needs_info 通知時のアクティビティ。 */
export function activityNeedsInfo(recovered: boolean): string {
  return `❓ 要回答 — 質問をコメントに投稿${recovered ? "（再起動時に確定）" : ""} — ${hhmm()}`;
}

/** CI green 検知時のアクティビティ。 */
export function activityCiGreen(): string {
  return `✅ CI グリーン — レビュー待ち (${hhmm()})`;
}

/** CI 自動修正上限到達時のアクティビティ。 */
export function activityCiLimit(count: number): string {
  return `🆘 CI 自動修正が上限 (${count}回) に到達 — 人間の対応が必要 — ${hhmm()}`;
}

/** 成功時のコメント本文。 */
export function commentSuccess(opts: {
  summary: string | undefined;
  prUrl: string | undefined;
  elapsedSec: number;
  attempt: number;
  sessionId: string | undefined;
}): string {
  return [
    opts.summary ??
      (opts.prUrl ? "PR を作成しました。" : "作業を完了しました（PR は作成していません）。"),
    opts.prUrl ? `PR: ${opts.prUrl}` : undefined,
    `実行時間: 約 ${opts.elapsedSec} 秒 (attempt ${opts.attempt})`,
    opts.sessionId ? `セッションID: ${opts.sessionId}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** リカバリ経由の成功コメント本文。 */
export function commentRecoveredSuccess(opts: {
  summary: string | undefined;
  prUrl: string | undefined;
}): string {
  return [
    opts.summary ??
      (opts.prUrl ? "PR を作成しました。" : "作業を完了しました（PR は作成していません）。"),
    opts.prUrl ? `PR: ${opts.prUrl}` : undefined,
    "（デーモン再起動時に完了を確定しました）",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** needs_info 通知コメント本文。 */
export function commentNeedsInfo(opts: {
  question: string;
  recovered: boolean;
  sessionId: string | undefined;
}): string {
  return [
    "❓ 実装を進めるには確認が必要です",
    "",
    opts.question,
    "",
    "このコメントに返信（またはページにコメント追加）してください。返信を検知したら自動で再開します。",
    ...(opts.recovered ? ["（デーモン再起動時に確定しました）"] : []),
    ...(opts.sessionId ? [`セッションID: ${opts.sessionId}`] : []),
  ].join("\n");
}

/** 失敗時のコメント本文（ログ末尾込み）。 */
export function commentFailed(opts: {
  attempt: number;
  maxAttempts: number;
  shortReason: string;
  sessionId: string | undefined;
  logTail: string;
}): string {
  return [
    `❌ 自動実装に失敗しました (attempt ${opts.attempt}/${opts.maxAttempts})`,
    `理由: ${opts.shortReason}`,
    opts.sessionId ? `セッションID: ${opts.sessionId}` : "",
    opts.logTail ? `\n--- ログ末尾 ---\n${opts.logTail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** CI 自動修正上限到達時のコメント本文（失敗 check 一覧付き）。 */
export function commentCiLimit(opts: {
  count: number;
  prUrl: string;
  failedChecks: PrCheck[];
}): string {
  const checkLines = opts.failedChecks.map(
    (chk) => `- ${chk.name}: ${chk.detailsUrl ?? "(詳細URLなし)"}`,
  );
  return [
    `🆘 CI の自動修正が上限 (${opts.count}回) に達しました。人間の対応が必要です。`,
    `PR: ${opts.prUrl}`,
    "失敗している check:",
    ...checkLines,
  ].join("\n");
}
