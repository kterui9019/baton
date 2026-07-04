import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import type { AgentResult } from "../domain/agent-result.ts";
import { parseResultFile } from "../domain/agent-result.ts";
import {
  toDoneRecovered,
  toNeedsInfoRecovered,
  type PageState,
  type StateFile,
} from "../domain/state.ts";
import type { Config } from "../infrastructure/config.ts";
import { nowIso, oneLine } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { KanbanIo } from "./kanban-io.ts";
import {
  activityNeedsInfo,
  commentNeedsInfo,
  commentRecoveredSuccess,
  ticketUpdateRecoveredSuccess,
} from "./messages.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";

/**
 * 起動時リカバリ: `running` のまま残ったページを、result_file の内容に応じて
 * done / needs_info に確定させるか、retry_queued(retryAt=0) に降格する。
 * 副作用は state 書き換え / KanbanPort 呼び出し（安全ラッパ経由）に閉じる。
 */
export interface StartupRecoveryDeps {
  resultsDir: string;
  getState: () => StateFile;
  persist: () => void;
  cfg: () => Config;
  kanban: () => KanbanPort;
  kanbanIo: KanbanIo;
  log: Logger;
}

export function createStartupRecovery(
  deps: StartupRecoveryDeps,
): { recoverOnStartup: () => Promise<void> } {
  function readResult(pageId: string): AgentResult | null {
    const file = join(deps.resultsDir, `${pageId}.json`);
    try {
      if (!existsSync(file)) return null;
      return parseResultFile(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function demoteToRetryQueued(pageId: string, ps: PageState): void {
    const state = deps.getState();
    state.pages[pageId] = { ...ps, status: "retry_queued", retryAt: 0, updatedAt: nowIso() };
    deps.log.info("tick", {
      page_id: pageId,
      msg: "起動リカバリ: running → retry_queued に降格",
    });
  }

  async function notifyNeedsInfo(pageId: string, question: string): Promise<void> {
    await deps.kanbanIo.safeUpdate("recovered_needs_info_update", pageId, (k) =>
      k.updateTicket(pageId, { activity: activityNeedsInfo(true) }),
    );
    await deps.kanbanIo.safeUpdate("recovered_needs_info_comment", pageId, (k) =>
      k.addComment(pageId, commentNeedsInfo({ question, recovered: true, sessionId: undefined })),
    );
    await deps.kanbanIo.refreshLastEditedTime(
      "recovered_needs_info_refresh",
      pageId,
      "needs_info",
    );
  }

  async function finalizeSuccess(
    pageId: string,
    ps: PageState,
    prUrl: string | undefined,
    summary: string | undefined,
  ): Promise<void> {
    const c = deps.cfg();
    deps.getState().pages[pageId] = toDoneRecovered({ prev: ps, prUrl });
    deps.log.info("recovered_success", {
      page_id: pageId,
      msg: `起動リカバリ: 完遂済みを検出し done 確定 — ${prUrl ?? "(PRなし)"}`,
    });
    await deps.kanbanIo.safeUpdate("recovered_success_update", pageId, (k) =>
      k.updateTicket(pageId, ticketUpdateRecoveredSuccess(prUrl, c.kanban.doneLane)),
    );
    await deps.kanbanIo.safeUpdate("recovered_success_comment", pageId, (k) =>
      k.addComment(pageId, commentRecoveredSuccess({ summary, prUrl })),
    );
    await deps.kanbanIo.refreshLastEditedTime("recovered_success_refresh", pageId, "done");
  }

  async function finalizeNeedsInfo(
    pageId: string,
    ps: PageState,
    question: string,
  ): Promise<void> {
    const questionAskedAt = nowIso();
    deps.getState().pages[pageId] = toNeedsInfoRecovered({
      prev: ps,
      question,
      questionAskedAt,
    });
    deps.log.info("recovered_needs_info", {
      page_id: pageId,
      msg: `起動リカバリ: needs_info を確定 — ${oneLine(question, 160)}`,
    });
    await notifyNeedsInfo(pageId, question);
  }

  async function recoverOnStartup(): Promise<void> {
    const state = deps.getState();
    const orphans = Object.entries(state.pages).filter(([, ps]) => ps.status === "running");
    if (orphans.length === 0) return;

    for (const [pageId, ps] of orphans) {
      const result = readResult(pageId);
      if (result === null) {
        demoteToRetryQueued(pageId, ps);
        continue;
      }
      await match(result)
        .with({ status: "success" }, (r) => finalizeSuccess(pageId, ps, r.prUrl, r.summary))
        .with({ status: "needs_info" }, (r) =>
          r.question
            ? finalizeNeedsInfo(pageId, ps, r.question)
            : Promise.resolve(demoteToRetryQueued(pageId, ps)),
        )
        .with({ status: "failure" }, () => Promise.resolve(demoteToRetryQueued(pageId, ps)))
        .exhaustive();
    }
    deps.persist();
  }

  return { recoverOnStartup };
}
