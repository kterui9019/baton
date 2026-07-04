/** 正規化済みの PR チェック 1 件（CheckRun / StatusContext の共通形）。 */
export interface PrCheck {
  name: string;
  status: "pending" | "success" | "failure";
  detailsUrl?: string;
}

/** PR 1 件のスナップショット。CodeHostPort 実装がこの形へ正規化する。 */
export interface PrSnapshot {
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
  reviewDecision: string; // "CHANGES_REQUESTED" | "APPROVED" | "REVIEW_REQUIRED" | ""
  checks: PrCheck[];
}

/** PR レビュー 1 件（インラインコメントも state:"INLINE" でこの形に寄せる）。 */
export interface ReviewInfo {
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

/** state.ts の PrWatchState と構造互換の narrow な入力型（domain 内部の相互依存を避けるため独立させている）。 */
export interface PrWatchInput {
  phase: "ci" | "review";
  reworkedSha?: string;
  autoReworkCount: number;
  handledReviewAt?: string;
  awaitingHuman?: boolean;
}

/** PR 監視 1 回分の判定結果。 */
export type PrWatchAction =
  | { type: "merged" }
  | { type: "closed" }
  | { type: "ci_green" }
  | { type: "ci_rework"; headSha: string; failedChecks: PrCheck[] }
  | { type: "ci_limit"; failedChecks: PrCheck[] }
  | { type: "review_rework"; reviews: ReviewInfo[]; latestSubmittedAt: string }
  | { type: "none"; reason: string };

/** チェック配列の集計（pending / success / failure の件数と failure 一覧）。 */
export function summarizeChecks(checks: PrCheck[]): {
  pending: number;
  success: number;
  failure: number;
  failed: PrCheck[];
} {
  const failed = checks.filter((c) => c.status === "failure");
  return {
    pending: checks.filter((c) => c.status === "pending").length,
    success: checks.filter((c) => c.status === "success").length,
    failure: failed.length,
    failed,
  };
}

/**
 * PR 監視 1 回分の判定（純粋関数・判定の中核）。
 * 優先順: merged → closed → awaitingHuman → CHANGES_REQUESTED(phase review のみ)
 * → CI failure → CI pending → 全 green。
 * 複数の入力値にまたがる優先順位付きガードのため、判別子1つに対する
 * 網羅マッチである ts-pattern は当てはめず、素直な早期 return で表現する。
 */
export function decidePrWatchAction(opts: {
  snapshot: PrSnapshot;
  reviews: ReviewInfo[];
  watch: PrWatchInput;
  autoReworkLimit: number;
}): PrWatchAction {
  const { snapshot, reviews, watch, autoReworkLimit } = opts;

  if (snapshot.state === "MERGED") return { type: "merged" };
  if (snapshot.state === "CLOSED") return { type: "closed" };
  // 呼び出し側もフィルタするが防御
  if (watch.awaitingHuman) return { type: "none", reason: "awaiting human" };

  if (
    watch.phase === "review" &&
    snapshot.reviewDecision === "CHANGES_REQUESTED"
  ) {
    const changesRequested = reviews.filter(
      (r) => r.state === "CHANGES_REQUESTED",
    );
    // handledReviewAt 未設定なら無条件に「新しい」扱い
    const fresh = changesRequested.filter(
      (r) =>
        watch.handledReviewAt === undefined ||
        r.submittedAt > watch.handledReviewAt,
    );
    if (fresh.length > 0) {
      const latestSubmittedAt = fresh.reduce(
        (acc, r) => (r.submittedAt > acc ? r.submittedAt : acc),
        fresh[0]!.submittedAt,
      );
      return { type: "review_rework", reviews: fresh, latestSubmittedAt };
    }
    // CR レビュー本体が取れない / すべて処理済み → CI 判定へフォールスルー
  }

  const summary = summarizeChecks(snapshot.checks);
  if (summary.failure > 0) {
    if (
      watch.reworkedSha !== undefined &&
      snapshot.headSha === watch.reworkedSha
    ) {
      // この SHA の CI 失敗は対応済み（再発火防止）
      return { type: "none", reason: "ci failure already reworked (sha)" };
    }
    if (watch.autoReworkCount >= autoReworkLimit) {
      return { type: "ci_limit", failedChecks: summary.failed };
    }
    return {
      type: "ci_rework",
      headSha: snapshot.headSha,
      failedChecks: summary.failed,
    };
  }

  if (summary.pending > 0) return { type: "none", reason: "ci pending" };

  // checks 空 = CI 未設定でも green 扱いで doneLane へ進める
  if (watch.phase === "ci") return { type: "ci_green" };
  return { type: "none", reason: "all green, waiting review" };
}
