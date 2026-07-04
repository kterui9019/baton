import { nowIso } from "../infrastructure/format.ts";

export type PageStatus =
  | "running"
  | "retry_queued"
  | "done"
  | "failed"
  | "needs_info";

/**
 * PR フィードバックループの監視状態（done + prWatch で PR 監視中を表す）。
 * CodeHostPort 実装の判定関数へそのまま渡せる構造互換の型。
 */
export interface PrWatchState {
  prUrl: string;
  phase: "ci" | "review";
  headSha?: string;
  /** この SHA の CI 失敗は対応済み（再発火防止）。 */
  reworkedSha?: string;
  /** CI 起因 rework 累計。human/review rework で 0 リセット。 */
  autoReworkCount: number;
  /** 処理済み CHANGES_REQUESTED の最新 submittedAt。 */
  handledReviewAt?: string;
  /** 上限到達。人間編集（human rework）でのみ解除。 */
  awaitingHuman?: boolean;
}

/** すべての状態で共通に持ち得るフィールド（rework 等で前状態から引き継がれる）。 */
interface PageStateCommon {
  attempt: number;
  branch?: string;
  workspace?: string;
  /** worktree 削除に使うメインリポジトリのパス。 */
  repoDir?: string;
  prUrl?: string;
  /** done + PR あり: PR フィードバックループ（CI/レビュー/マージ）の監視状態。 */
  prWatch?: PrWatchState;
  /**
   * done/failed 記録時のページ last_edited_time。
   * これより新しい編集（レーン差し戻し・本文追記）があれば人間の操作とみなし
   * 再ディスパッチ（rework）する。
   */
  lastEditedTime?: string;
  updatedAt: string;
}

/**
 * ページ 1 件の実行状態。status を判別子にした Union にすることで、
 * 「retry_queued なら retryAt が必ずある」「needs_info なら質問が必ずある」
 * ことを型で保証し、呼び出し側の `?? 0` 等の防御的フォールバックを排除する。
 */
export type PageState =
  | (PageStateCommon & { status: "running" })
  | (PageStateCommon & {
      status: "retry_queued";
      /** バックオフ満了時刻 (epoch ms)。 */
      retryAt: number;
    })
  | (PageStateCommon & { status: "done" })
  | (PageStateCommon & { status: "failed" })
  | (PageStateCommon & {
      status: "needs_info";
      /** 質問コメント投稿時刻の基準 (ISO8601)。これより新しい非 bot コメントを「人間の回答」とみなして再開する。 */
      questionAskedAt: string;
      /** エージェントが投げた質問（再開プロンプトに再掲する）。 */
      question: string;
    });

export interface StateFile {
  version: 1;
  pages: Record<string, PageState>;
}

export function emptyState(): StateFile {
  return { version: 1, pages: {} };
}

/**
 * PR 監視状態を（再）アームする。
 * - autoReworkCount: keepCount=true（ci_failure rework の成功）のときのみ維持。
 *   human/review rework・初回成功は 0 リセット。
 * - reworkedSha / handledReviewAt は常に引き継ぐ（同一 SHA 再発火防止・処理済みレビュー再発火防止のため）。
 * - awaitingHuman は引き継がない（rework 成功 = 人間介入の結果として自然解除）。
 */
export function rearmPrWatch(
  prev: PrWatchState | undefined,
  prUrl: string,
  keepCount: boolean,
): PrWatchState {
  return {
    prUrl,
    phase: "ci",
    autoReworkCount: keepCount ? (prev?.autoReworkCount ?? 0) : 0,
    reworkedSha: prev?.reworkedSha,
    handledReviewAt: prev?.handledReviewAt,
  };
}

/**
 * 起動時リカバリ: running のまま残ったページ（孤児）を retry_queued へ降格。
 * attempt 据え置き・即時再試行可 (retryAt=0)。変更があれば true。
 */
export function recoverOrphans(state: StateFile): boolean {
  let changed = false;
  for (const [pageId, ps] of Object.entries(state.pages)) {
    if (ps.status === "running") {
      state.pages[pageId] = {
        ...ps,
        status: "retry_queued",
        retryAt: 0,
        updatedAt: nowIso(),
      };
      changed = true;
    }
  }
  return changed;
}
