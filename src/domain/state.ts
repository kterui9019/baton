import { match } from "ts-pattern";
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
  /**
   * 直近実行でエージェント CLI が払い出した session_id。
   * rework/CI 起因の再実行時、対応 CLI（opencode/grok/codex 等）に
   * ネイティブ resume 引数として渡してセッションを引き継ぐ。
   */
  sessionId?: string;
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
 * ワークスペース情報（branch/workspace/repoDir）を PageStateCommon にマージする純粋関数。
 * dispatch 準備段階で作成した worktree を状態に反映するのに使う。
 */
export function assignWorkspace(
  prev: PageState | undefined,
  ws: { branch: string; path: string; repoDir: string },
  now: string = nowIso(),
): PageState {
  const base: PageStateCommon = {
    attempt: prev?.attempt ?? 1,
    branch: ws.branch,
    workspace: ws.path,
    repoDir: ws.repoDir,
    prUrl: prev?.prUrl,
    prWatch: prev?.prWatch,
    lastEditedTime: prev?.lastEditedTime,
    sessionId: prev?.sessionId,
    updatedAt: now,
  };
  if (!prev) return { ...base, status: "running" };
  return match<PageState, PageState>(prev)
    .with({ status: "retry_queued" }, (p) => ({ ...base, status: p.status, retryAt: p.retryAt }))
    .with({ status: "needs_info" }, (p) => ({
      ...base,
      status: p.status,
      questionAskedAt: p.questionAskedAt,
      question: p.question,
    }))
    .with({ status: "running" }, () => ({ ...base, status: "running" }))
    .with({ status: "done" }, () => ({ ...base, status: "done" }))
    .with({ status: "failed" }, () => ({ ...base, status: "failed" }))
    .exhaustive();
}

/** dispatch 開始時に prev から running 状態を組む。branch/workspace/repoDir/prUrl/prWatch は引き継ぐ。 */
export function toRunning(prev: PageState | undefined, attempt: number): PageState {
  return {
    status: "running",
    attempt,
    branch: prev?.branch,
    workspace: prev?.workspace,
    repoDir: prev?.repoDir,
    prUrl: prev?.prUrl,
    prWatch: prev?.prWatch,
    updatedAt: nowIso(),
  };
}

/**
 * 成功時の done 状態を組む。PR ありなら prWatch を rearm、なしなら prWatch なし。
 * keepPrWatchCount=true（ci_failure 由来 rework）のとき autoReworkCount を維持する。
 */
export function toDone(opts: {
  prev: PageState | undefined;
  attempt: number;
  workspace: { branch: string; path: string; repoDir: string };
  prUrl: string | undefined;
  keepPrWatchCount: boolean;
  sessionId: string | undefined;
}): PageState {
  const { prev, attempt, workspace: ws, prUrl, keepPrWatchCount, sessionId } = opts;
  return {
    status: "done",
    attempt,
    branch: ws.branch,
    workspace: ws.path,
    repoDir: ws.repoDir,
    prUrl,
    prWatch: prUrl ? rearmPrWatch(prev?.prWatch, prUrl, keepPrWatchCount) : undefined,
    sessionId: sessionId ?? prev?.sessionId,
    lastEditedTime: prev?.lastEditedTime,
    updatedAt: nowIso(),
  };
}

/** needs_info 状態を組む。question/questionAskedAt を確定し、sessionId は引き継ぎ or 更新。 */
export function toNeedsInfo(opts: {
  prev: PageState | undefined;
  attempt: number;
  workspace: { branch: string; path: string; repoDir: string };
  question: string;
  questionAskedAt: string;
  sessionId: string | undefined;
}): PageState {
  const { prev, attempt, workspace: ws, question, questionAskedAt, sessionId } = opts;
  return {
    status: "needs_info",
    attempt,
    branch: ws.branch,
    workspace: ws.path,
    repoDir: ws.repoDir,
    prUrl: prev?.prUrl,
    prWatch: prev?.prWatch,
    lastEditedTime: prev?.lastEditedTime,
    sessionId: sessionId ?? prev?.sessionId,
    questionAskedAt,
    question,
    updatedAt: nowIso(),
  };
}

/** 起動リカバリ経由の done 確定（前回 running の branch/workspace/repoDir をそのまま引き継ぐ）。 */
export function toDoneRecovered(opts: {
  prev: PageState;
  prUrl: string | undefined;
}): PageState {
  const { prev, prUrl } = opts;
  return {
    status: "done",
    attempt: prev.attempt,
    branch: prev.branch,
    workspace: prev.workspace,
    repoDir: prev.repoDir,
    prUrl,
    prWatch: prUrl ? rearmPrWatch(prev.prWatch, prUrl, true) : undefined,
    lastEditedTime: prev.lastEditedTime,
    sessionId: prev.sessionId,
    updatedAt: nowIso(),
  };
}

/** 起動リカバリ経由の needs_info 確定（前回 running の branch/workspace/repoDir/prUrl を引き継ぐ）。 */
export function toNeedsInfoRecovered(opts: {
  prev: PageState;
  question: string;
  questionAskedAt: string;
}): PageState {
  const { prev, question, questionAskedAt } = opts;
  return {
    status: "needs_info",
    attempt: prev.attempt,
    branch: prev.branch,
    workspace: prev.workspace,
    repoDir: prev.repoDir,
    prUrl: prev.prUrl,
    prWatch: prev.prWatch,
    lastEditedTime: prev.lastEditedTime,
    sessionId: prev.sessionId,
    questionAskedAt,
    question,
    updatedAt: nowIso(),
  };
}

/** retry_queued へ降格（onFailure 経由）。attempt 据え置きで retryAt=now+delay。sessionId 更新可。 */
export function toRetryQueued(opts: {
  prev: PageState | undefined;
  attempt: number;
  retryAt: number;
  sessionId: string | undefined;
}): PageState {
  const { prev, attempt, retryAt, sessionId } = opts;
  const base: PageStateCommon =
    prev ??
    ({ attempt, updatedAt: nowIso() } as PageStateCommon);
  return {
    ...base,
    status: "retry_queued",
    attempt,
    retryAt,
    sessionId: sessionId ?? prev?.sessionId,
    updatedAt: nowIso(),
  };
}

/** failed 確定（リトライ上限到達）。lastEditedTime を「今回失敗時点の ticket 値」で更新。 */
export function toFailed(opts: {
  prev: PageState | undefined;
  attempt: number;
  ticketLastEditedTime: string | undefined;
  sessionId: string | undefined;
}): PageState {
  const { prev, attempt, ticketLastEditedTime, sessionId } = opts;
  const base: PageStateCommon =
    prev ??
    ({ attempt, updatedAt: nowIso() } as PageStateCommon);
  return {
    ...base,
    status: "failed",
    attempt,
    lastEditedTime: ticketLastEditedTime,
    sessionId: sessionId ?? prev?.sessionId,
    updatedAt: nowIso(),
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
