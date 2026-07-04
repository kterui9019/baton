import { match } from "ts-pattern";
import type { ResumeInput } from "../domain/eligibility.ts";
import type { PageState, PrWatchState, StateFile } from "../domain/state.ts";
import { decidePrWatchAction, type PrWatchAction, type ReviewInfo } from "../domain/review.ts";
import type { Config } from "../infrastructure/config.ts";
import { nowIso, oneLine } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { KanbanIo } from "./kanban-io.ts";
import {
  activityCiGreen,
  activityCiLimit,
  activityPrClosed,
  activityPrMerged,
  commentCiLimit,
  commentPrClosed,
  commentPrMerged,
} from "./messages.ts";
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
        let reviews: ReviewInfo[] = [];
        if (watch.phase === "review") {
          reviews = await ch.fetchReviews(watch.prUrl);
        }
        const action = decidePrWatchAction({
          snapshot,
          reviews,
          watch,
          autoReworkLimit: c.autoReworkLimit,
        });
        await handlePrWatchAction(pageId, ps, watch, snapshot.headSha, action);
      } catch (err) {
        deps.log.warn("pr_watch", { page_id: pageId, msg: oneLine(String(err)) });
      }
    }
  }

  async function handleMerged(pageId: string, ps: PageState, watch: PrWatchState): Promise<void> {
    const c = deps.cfg();
    deps.getState().pages[pageId] = { ...ps, prWatch: undefined, updatedAt: nowIso() };
    deps.persist();
    deps.log.info("pr_watch", {
      page_id: pageId,
      msg: `PR マージ検知 → ${c.kanban.mergedLane} へ: ${watch.prUrl}`,
    });
    await deps.kanbanIo.safeUpdate("pr_merged_update", pageId, (k) =>
      k.updateTicket(pageId, { lane: c.kanban.mergedLane, activity: activityPrMerged() }),
    );
    await deps.kanbanIo.safeUpdate("pr_merged_comment", pageId, (k) =>
      k.addComment(pageId, commentPrMerged(watch.prUrl)),
    );
    await deps.kanbanIo.refreshLastEditedTime("pr_merged_refresh", pageId, "done");
  }

  async function handleClosed(pageId: string, ps: PageState, watch: PrWatchState): Promise<void> {
    deps.getState().pages[pageId] = { ...ps, prWatch: undefined, updatedAt: nowIso() };
    deps.persist();
    deps.log.info("pr_watch", {
      page_id: pageId,
      msg: `PR がマージされずクローズ（監視終了）: ${watch.prUrl}`,
    });
    await deps.kanbanIo.safeUpdate("pr_closed_update", pageId, (k) =>
      k.updateTicket(pageId, { activity: activityPrClosed() }),
    );
    await deps.kanbanIo.safeUpdate("pr_closed_comment", pageId, (k) =>
      k.addComment(pageId, commentPrClosed(watch.prUrl)),
    );
    await deps.kanbanIo.refreshLastEditedTime("pr_closed_refresh", pageId, "done");
  }

  async function handleCiGreen(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    headSha: string,
  ): Promise<void> {
    const c = deps.cfg();
    const snapshot = await deps.kanban().getPage(pageId);
    const lane = snapshot.ticket.lane;
    const moveLane = lane !== null && c.kanban.triggerLanes.includes(lane);
    const nextWatch: PrWatchState = { ...watch, phase: "review", headSha };
    deps.getState().pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
    deps.persist();
    deps.log.info("pr_watch", {
      page_id: pageId,
      msg: `CI グリーン → レビュー待ち${
        moveLane ? `（${c.kanban.doneLane} へ移動）` : `（レーン ${lane} は維持）`
      }: ${watch.prUrl}`,
    });
    await deps.kanbanIo.safeUpdate("ci_green_update", pageId, (k) =>
      k.updateTicket(pageId, {
        ...(moveLane ? { lane: c.kanban.doneLane } : {}),
        activity: activityCiGreen(),
      }),
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
    await deps.kanbanIo.safeUpdate("ci_limit_update", pageId, (k) =>
      k.updateTicket(pageId, { activity: activityCiLimit(watch.autoReworkCount) }),
    );
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

  async function handleReviewRework(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    a: Extract<PrWatchAction, { type: "review_rework" }>,
  ): Promise<void> {
    const c = deps.cfg();
    if (!deps.canStartRework()) {
      deps.log.info("pr_watch", {
        page_id: pageId,
        msg: "レビュー rework をスキップ（スロット満杯/シャットダウン中）、次回へ持ち越し",
      });
      return;
    }
    const nextWatch: PrWatchState = {
      ...watch,
      handledReviewAt: a.latestSubmittedAt,
      autoReworkCount: 0,
    };
    deps.getState().pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
    deps.persist();
    deps.log.info("pr_watch", {
      page_id: pageId,
      msg: `changes requested を検知 (${a.reviews.length} 件) → 自動 rework: ${watch.prUrl}`,
    });
    const inline = await deps.codeHost().fetchInlineComments(watch.prUrl);
    const reviews = [...a.reviews, ...inline].map((r) => ({
      author: r.author,
      body: r.body,
      submittedAt: r.submittedAt,
    }));
    const lane0 = c.kanban.triggerLanes[0];
    if (lane0) {
      await deps.kanbanIo.safeUpdate("review_rework_lane", pageId, (k) =>
        k.updateTicket(pageId, { lane: lane0 }),
      );
    }
    await deps.dispatchAutoRework(pageId, { kind: "review_changes", from: ps, reviews });
  }

  async function handlePrWatchAction(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    headSha: string,
    action: PrWatchAction,
  ): Promise<void> {
    await match(action)
      .with({ type: "merged" }, () => handleMerged(pageId, ps, watch))
      .with({ type: "closed" }, () => handleClosed(pageId, ps, watch))
      .with({ type: "ci_green" }, () => handleCiGreen(pageId, ps, watch, headSha))
      .with({ type: "ci_rework" }, (a) => handleCiRework(pageId, ps, watch, a))
      .with({ type: "ci_limit" }, (a) => handleCiLimit(pageId, ps, watch, a))
      .with({ type: "review_rework" }, (a) => handleReviewRework(pageId, ps, watch, a))
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
