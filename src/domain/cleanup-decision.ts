import type { PageState } from "./state.ts";
import type { KanbanPageSnapshot } from "./ticket.ts";

/**
 * terminal レーン到達時の後片付けアクション。
 * - skip: 対象外（そもそも terminal レーンにいない等）
 * - delete_state: state から entry を落とす。worktree があれば併せて削除。
 */
export type CleanupAction =
  | { type: "skip" }
  | {
      type: "delete_state";
      lane: string;
      worktree?: { repoDir: string; path: string };
    };

/**
 * 「snapshot が取れた前提」での terminal cleanup 判定。
 * IO 側で status/active による早期フィルタを済ませてから呼ぶ想定なので、
 * ここでは snapshot 情報とレーン設定のみに集中する。
 */
export function decideCleanup(input: {
  ps: PageState;
  snapshot: KanbanPageSnapshot | null;
  terminalLanes: string[];
  repoLocalDirPath: (repo: string) => string | undefined;
}): CleanupAction {
  const { ps, snapshot, terminalLanes, repoLocalDirPath } = input;
  if (!snapshot) return { type: "skip" };
  const lane = snapshot.ticket.lane;
  if (!lane || !terminalLanes.includes(lane)) return { type: "skip" };

  if (!ps.workspace) return { type: "delete_state", lane };

  const repoDir =
    ps.repoDir ?? (snapshot.ticket.repo ? repoLocalDirPath(snapshot.ticket.repo) : undefined);
  if (!repoDir) return { type: "delete_state", lane };

  return {
    type: "delete_state",
    lane,
    worktree: { repoDir, path: ps.workspace },
  };
}

/** IO を回避するための早期フィルタ。status が terminal 3種のいずれかで、かつ active でないものだけ判定対象。 */
export function isCleanupCandidate(ps: PageState, isActive: boolean): boolean {
  if (isActive) return false;
  return ps.status === "done" || ps.status === "failed" || ps.status === "needs_info";
}
