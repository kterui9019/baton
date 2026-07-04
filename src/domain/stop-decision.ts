import { match } from "ts-pattern";
import type { KanbanPageSnapshot } from "./ticket.ts";

/**
 * running なエントリの Kanban 側スナップショット。IO 側で例外を握って ADT に落としてから
 * 純粋関数 classifyRunningEntry へ渡す。domain 層は Error クラスに依存しない。
 */
export type RunningEntrySnapshot =
  | { type: "snapshot"; value: KanbanPageSnapshot }
  | { type: "not_found" }
  | { type: "fetch_error"; message: string };

/**
 * running エントリを「今どう扱うべきか」に分類した結果。
 * - kill_gone: ページが消えた／アーカイブ→プロセス kill
 * - kill_moved: 対象レーンから人間が動かした→プロセス kill
 * - keep: 通常続行
 * - fetch_error: 一時的な取得失敗、今回はスキップ（次 tick で再判定）
 */
export type RunningEntryStatus =
  | { type: "kill_gone"; reason: "not_found" | "archived_or_deleted" }
  | { type: "kill_moved"; lane: string | null }
  | { type: "keep" }
  | { type: "fetch_error"; message: string };

/**
 * running エントリのスナップショットと設定から扱いを決める純粋関数。
 * dispatchedByUs は「オーケストレーター自身がレーンを動かした直後」の race を避けるための旗印。
 */
export function classifyRunningEntry(input: {
  snapshot: RunningEntrySnapshot;
  triggerLanes: string[];
  dispatchedByUs: boolean;
}): RunningEntryStatus {
  return match<RunningEntrySnapshot, RunningEntryStatus>(input.snapshot)
    .with({ type: "not_found" }, () => ({ type: "kill_gone", reason: "not_found" }))
    .with({ type: "fetch_error" }, ({ message }) => ({ type: "fetch_error", message }))
    .with({ type: "snapshot" }, ({ value }) => {
      if (value.isArchived || value.isDeleted) {
        return { type: "kill_gone", reason: "archived_or_deleted" };
      }
      const lane = value.ticket.lane;
      const stillTrigger = lane !== null && input.triggerLanes.includes(lane);
      if (!stillTrigger && !input.dispatchedByUs) {
        return { type: "kill_moved", lane };
      }
      return { type: "keep" };
    })
    .exhaustive();
}
