import { match } from "ts-pattern";
import type { ResumeInput } from "../domain/eligibility.ts";
import type { PageState, PrWatchState, StateFile } from "../domain/state.ts";
import { decidePrWatchAction, type PrWatchAction } from "../domain/review.ts";
import type { Config } from "../infrastructure/config.ts";
import { nowIso, oneLine } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { KanbanIo } from "./kanban-io.ts";
import { commentCiGreen, commentCiLimit } from "./messages.ts";
import type { CodeHostPort } from "./ports/code-host-port.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";

/**
 * PR 監視（advancePrWatch + handlePrWatchAction）の集約。
 * ドメイン層 decidePrWatchAction が返す純粋な PrWatchAction ADT を、
 * ここで state 変更 + KanbanPort/CodeHostPort 呼び出しに変換する。
 */
export interface PrWatchRunnerDeps {
  cfg: () => Config;
  kanban: () => KanbanPort;
  codeHost: () => CodeHostPort;
  kanbanIo: KanbanIo;
  log: Logger;
  getState: () => StateFile;
  persist: () => void;
  isActive: (pageId: string) => boolean;
  /** PR 監視から自動 rework を発火できるか（スロット・シャットダウン状況）。 */
  canStartRework: () => boolean;
  /** 実際の自動 rework 発火 (dispatch runner 側)。 */
  dispatchAutoRework: (pageId: string, input: ResumeInput) => Promise<void>;
}

export function createPrWatchRunner(deps: PrWatchRunnerDeps): {
  advancePrWatch: () => Promise<void>;
} {
  let lastPrPollAt = 0;

  async function advancePrWatch(): Promise<void> {
    const c = deps.cfg();
    const now = Date.now();
    if (now - lastPrPollAt < c.prPollIntervalMs) return;
    lastPrPollAt = now;
    const ch = deps.codeHost();
    const state = deps.getState();
    for (const [pageId, ps] of Object.entries(state.pages)) {
      if (ps.status !== "done") continue;
      const watch = ps.prWatch;
      if (!watch || watch.awaitingHuman) continue;
      if (deps.isActive(pageId)) continue;
      try {
        const snapshot = await ch.fetchPrSnapshot(watch.prUrl);
        if (!snapshot) {
          deps.log.warn("pr_watch", {
            page_id: pageId,
            msg: `PR スナップショット取得失敗（スキップ）: ${watch.prUrl}`,
          });
          continue;
        }
        const action = decidePrWatchAction({
          snapshot,
          watch,
          autoReworkLimit: c.autoReworkLimit,
        });
        await handlePrWatchAction(pageId, ps, watch, action);
      } catch (err) {
        deps.log.warn("pr_watch", { page_id: pageId, msg: oneLine(String(err)) });
      }
    }
  }

  async function handleCiGreen(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
  ): Promise<void> {
    const c = deps.cfg();
    const snapshot = await deps.kanban().getPage(pageId);
    const lane = snapshot.ticket.lane;
    const moveLane = lane !== null && c.kanban.triggerLanes.includes(lane);
    const nextWatch: PrWatchState = { ...watch, phase: "review" };
    deps.getState().pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
    deps.persist();
    deps.log.info("pr_watch", {
      page_id: pageId,
      msg: `CI グリーン → レビュー待ち${
        moveLane ? `（${c.kanban.doneLane} へ移動）` : `（レーン ${lane} は維持）`
      }: ${watch.prUrl}`,
    });
    if (moveLane) {
      await deps.kanbanIo.safeUpdate("ci_green_update", pageId, (k) =>
        k.updateTicket(pageId, { lane: c.kanban.doneLane }),
      );
    }
    await deps.kanbanIo.safeUpdate("ci_green_comment", pageId, (k) =>
      k.addComment(pageId, commentCiGreen()),
    );
    await deps.kanbanIo.refreshLastEditedTime("ci_green_refresh", pageId, "done");
  }

  async function handleCiRework(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    a: Extract<PrWatchAction, { type: "ci_rework" }>,
  ): Promise<void> {
    const c = deps.cfg();
    if (!deps.canStartRework()) {
      deps.log.info("pr_watch", {
        page_id: pageId,
        msg: "CI rework をスキップ（スロット満杯/シャットダウン中）、次回へ持ち越し",
      });
      return;
    }
    const nextWatch: PrWatchState = {
      ...watch,
      reworkedSha: a.headSha,
      autoReworkCount: watch.autoReworkCount + 1,
    };
    deps.getState().pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
    deps.persist();
    deps.log.info("pr_watch", {
      page_id: pageId,
      msg: `CI 失敗を検知 → 自動 rework (${nextWatch.autoReworkCount}/${c.autoReworkLimit}) sha=${a.headSha}`,
    });
    const ciFailures = await deps.codeHost().fetchFailedCheckLogs(watch.prUrl, a.failedChecks);
    await deps.dispatchAutoRework(pageId, { kind: "ci_failure", from: ps, ciFailures });
  }

  async function handleCiLimit(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    a: Extract<PrWatchAction, { type: "ci_limit" }>,
  ): Promise<void> {
    const nextWatch: PrWatchState = { ...watch, awaitingHuman: true };
    deps.getState().pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
    deps.persist();
    deps.log.warn("pr_watch", {
      page_id: pageId,
      msg: `CI 自動修正が上限 (${watch.autoReworkCount}回) に到達 — 人間待ちへ: ${watch.prUrl}`,
    });
    await deps.kanbanIo.safeUpdate("ci_limit_comment", pageId, (k) =>
      k.addComment(
        pageId,
        commentCiLimit({
          count: watch.autoReworkCount,
          prUrl: watch.prUrl,
          failedChecks: a.failedChecks,
        }),
      ),
    );
    await deps.kanbanIo.refreshLastEditedTime("ci_limit_refresh", pageId, "done");
  }

  async function handlePrWatchAction(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    action: PrWatchAction,
  ): Promise<void> {
    await match(action)
      .with({ type: "ci_green" }, () => handleCiGreen(pageId, ps, watch))
      .with({ type: "ci_rework" }, (a) => handleCiRework(pageId, ps, watch, a))
      .with({ type: "ci_limit" }, (a) => handleCiLimit(pageId, ps, watch, a))
      .with({ type: "none" }, (a) => {
        deps.log.info("pr_watch", {
          page_id: pageId,
          msg: `変化なし (${a.reason}): ${watch.prUrl}`,
        });
        return Promise.resolve();
      })
      .exhaustive();
  }

  return { advancePrWatch };
}
