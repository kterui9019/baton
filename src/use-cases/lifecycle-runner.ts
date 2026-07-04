import { match } from "ts-pattern";
import { decideCleanup, isCleanupCandidate } from "../domain/cleanup-decision.ts";
import { KanbanPageNotFoundError } from "../domain/errors.ts";
import type { StateFile } from "../domain/state.ts";
import { classifyRunningEntry, type RunningEntrySnapshot } from "../domain/stop-decision.ts";
import type { KanbanPageSnapshot } from "../domain/ticket.ts";
import type { Config } from "../infrastructure/config.ts";
import { oneLine, sleep } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { AgentHandle } from "../infrastructure/process-runner.ts";
import { tryAsync } from "./result-helpers.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";

/**
 * running なエントリのライフサイクル管理（trigger lane からの離脱・削除の検出→kill、
 * terminal lane 到達時の worktree/state cleanup、shutdown 時の一括 SIGTERM）。
 * dispatch runner が保持する active Map を購読する形で協調する。
 */
export interface RunningEntry {
  pageId: string;
  phase: "dispatching" | "running";
  handle?: AgentHandle;
  dispatchedByUs: boolean;
}

export interface LifecycleRunnerDeps {
  cfg: () => Config;
  kanban: () => KanbanPort;
  workspace: () => WorkspacePort;
  log: Logger;
  getState: () => StateFile;
  persist: () => void;
  /** dispatch runner が保持する active Map。key=pageId。 */
  listActive: () => RunningEntry[];
  /** kill 対象のエントリを消し込む（dispatch runner 側の active Map から）。 */
  releaseActive: (pageId: string) => void;
}

export function createLifecycleRunner(deps: LifecycleRunnerDeps): {
  stopMovedOrDeletedRuns: () => Promise<void>;
  terminalCleanup: () => Promise<void>;
  shutdown: (timeoutMs?: number) => Promise<void>;
} {
  async function fetchRunningSnapshot(pageId: string): Promise<RunningEntrySnapshot> {
    try {
      return { type: "snapshot", value: await deps.kanban().getPage(pageId) };
    } catch (e) {
      if (e instanceof KanbanPageNotFoundError) return { type: "not_found" };
      return { type: "fetch_error", message: oneLine(String(e)) };
    }
  }

  function killAndRelease(entry: RunningEntry): void {
    entry.handle?.terminate(5000);
    deps.releaseActive(entry.pageId);
    delete deps.getState().pages[entry.pageId];
    deps.persist();
  }

  async function stopMovedOrDeletedRuns(): Promise<void> {
    const c = deps.cfg();
    const running = deps.listActive().filter((e) => e.phase === "running" && e.handle);
    for (const entry of running) {
      const snapshot = await fetchRunningSnapshot(entry.pageId);
      const status = classifyRunningEntry({
        snapshot,
        triggerLanes: c.kanban.triggerLanes,
        dispatchedByUs: entry.dispatchedByUs,
      });
      match(status)
        .with({ type: "kill_gone" }, ({ reason }) => {
          deps.log.warn("stop_stray_kill", {
            page_id: entry.pageId,
            msg:
              reason === "not_found"
                ? "ページが存在しない、停止"
                : "アーカイブ/削除済み、停止",
          });
          killAndRelease(entry);
        })
        .with({ type: "kill_moved" }, ({ lane }) => {
          deps.log.warn("stop_stray_kill", {
            page_id: entry.pageId,
            msg: `レーンが対象外(${lane})に移動、停止`,
          });
          killAndRelease(entry);
        })
        .with({ type: "fetch_error" }, ({ message }) => {
          deps.log.warn("stop_stray", {
            page_id: entry.pageId,
            msg: `ページ取得失敗（スキップ）: ${message}`,
          });
        })
        .with({ type: "keep" }, () => {})
        .exhaustive();
    }
  }

  async function tryFetchPage(pageId: string): Promise<KanbanPageSnapshot | null> {
    try {
      return await deps.kanban().getPage(pageId);
    } catch {
      return null;
    }
  }

  async function terminalCleanup(): Promise<void> {
    const c = deps.cfg();
    const state = deps.getState();
    const activeIds = new Set(deps.listActive().map((e) => e.pageId));
    for (const [pageId, ps] of Object.entries(state.pages)) {
      if (!isCleanupCandidate(ps, activeIds.has(pageId))) continue;
      const snapshot = await tryFetchPage(pageId);
      const action = decideCleanup({
        ps,
        snapshot,
        terminalLanes: c.kanban.terminalLanes,
        repoLocalDirPath: (repo) => c.repoConfig[repo]?.localDirPath,
      });
      if (action.type === "skip") continue;
      if (action.worktree) {
        const removeRes = await tryAsync(() =>
          deps.workspace().removeWorktree(action.worktree!.repoDir, action.worktree!.path),
        );
        if (removeRes.type === "err") {
          deps.log.warn("cleanup", {
            page_id: pageId,
            msg: `worktree 削除失敗: ${removeRes.reason}`,
          });
        }
      }
      delete state.pages[pageId];
      deps.persist();
      deps.log.info("cleanup", {
        page_id: pageId,
        msg: `terminal(${action.lane}) 到達、state から削除`,
      });
    }
  }

  async function shutdown(timeoutMs = 10_000): Promise<void> {
    const running = deps.listActive().filter((e) => e.handle);
    deps.log.info("tick", { msg: `shutdown: running ${running.length} 件に SIGTERM` });
    for (const e of running) {
      e.handle?.terminate(timeoutMs);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const alive = deps.listActive().some((e) => e.handle);
      if (!alive) break;
      await sleep(200);
    }
    deps.persist();
  }

  return { stopMovedOrDeletedRuns, terminalCleanup, shutdown };
}
