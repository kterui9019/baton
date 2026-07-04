import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import type { AgentResult } from "../domain/agent-result.ts";
import { computeBackoff } from "../domain/backoff.ts";
import {
  buildResumeContext,
  decideEligibility,
  nextDispatchParams,
  resolveResumePlan,
  type EligibilityDecision,
  type ResumeContext,
  type ResumeInput,
} from "../domain/eligibility.ts";
import type { Result } from "../domain/result.ts";
import { err as errResult, ok } from "../domain/result.ts";
import { toDone, toFailed, toNeedsInfo, toRetryQueued, toRunning, type PageState, type StateFile } from "../domain/state.ts";
import type { Ticket } from "../domain/ticket.ts";
import type { WorkspaceInfo } from "../domain/workspace.ts";
import type { AgentProvider, Config } from "../infrastructure/config.ts";
import { nowIso, oneLine, tail } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { AgentHandle } from "../infrastructure/process-runner.ts";
import type { KanbanIo } from "./kanban-io.ts";
import type { RunningEntry } from "./lifecycle-runner.ts";
import {
  activityFailed,
  activityNeedsInfo,
  activityRetry,
  activityStart,
  commentFailed,
  commentNeedsInfo,
  commentSuccess,
  ticketUpdateSuccess,
} from "./messages.ts";
import type { CodeHostPort } from "./ports/code-host-port.ts";
import type { CodingAgentPort } from "./ports/coding-agent-port.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";
import { buildPromptVars, renderDispatchPrompts, renderResumeSection } from "./prompt-builder.ts";
import { tryAsync } from "./result-helpers.ts";

const AGENT_LABELS: Record<AgentProvider, string> = {
  claude: "Claude Code",
  takt: "takt",
  opencode: "opencode",
  grok: "Grok",
  codex: "Codex",
};

/**
 * dispatch まわりの中核。ticket と ResumeContext を受けて worktree を作成し、
 * エージェント CLI を起動、結果を state に反映する（onSuccess / onNeedsInfo /
 * onFailure）。副作用は WorkspacePort / KanbanPort / CodingAgentPort と state 書き換えのみ。
 */
export interface DispatchRunnerDeps {
  dataHome: string;
  resultsDir: string;
  runsDir: string;
  cfg: () => Config;
  kanban: () => KanbanPort;
  codeHost: () => CodeHostPort;
  workspace: () => WorkspacePort;
  agent: () => CodingAgentPort;
  kanbanIo: KanbanIo;
  log: Logger;
  getState: () => StateFile;
  persist: () => void;
  /** 実行中の active Map を dispatch runner が保持し、lifecycle runner に共有する。 */
  active: Map<string, ActiveEntry>;
  /** shutdown 中は新規 rework を発火しない。 */
  isShuttingDown: () => boolean;
}

/**
 * dispatch runner が保持する 1 タスクの実行状態。lifecycle runner にも
 * 部分的（RunningEntry）に見せる。
 */
export interface ActiveEntry extends RunningEntry {
  attempt: number;
  workspace?: WorkspaceInfo;
  logFile?: string;
  startedAt: number;
}

export function createDispatchRunner(deps: DispatchRunnerDeps): {
  dispatchAutoRework: (pageId: string, input: ResumeInput) => Promise<void>;
  /**
   * 候補チケット一覧を受け取り、eligibility 判定を行った上で dispatch を発火する。
   * needs_info の回答検知結果を needsInfoAnswers で受け取る。
   */
  processTick: (
    candidates: Ticket[],
    needsInfoAnswers: Map<string, boolean>,
    operatorUserId: string | null,
  ) => void;
  /**
   * dry-run 用: 各候補の eligibility 判定結果を返すのみ（副作用なし）。
   */
  planEligibility: (ticket: Ticket, operatorUserId: string | null) => EligibilityDecision;
  /** needs_info の回答有無を全候補について解決する。副作用なし（KanbanPort 読み取りのみ）。 */
  resolveNeedsInfoAnswers: (candidates: Ticket[]) => Promise<Map<string, boolean>>;
} {
  function readLogTail(logFile: string | undefined): string {
    if (!logFile) return "";
    try {
      if (!existsSync(logFile)) return "";
      return tail(readFileSync(logFile, "utf8"), 1000);
    } catch {
      return "";
    }
  }

  async function prepareWorkspace(
    ticket: Ticket,
    entry: ActiveEntry,
  ): Promise<Result<WorkspaceInfo, string>> {
    const wsRes = await tryAsync(() =>
      deps.workspace().createWorktree(ticket.pageId, ticket.title, ticket.repo as string),
    );
    if (wsRes.type === "err") return errResult(`workspace 作成失敗: ${wsRes.reason}`);
    const ws = wsRes.value;
    entry.workspace = ws;
    const prev = deps.getState().pages[ticket.pageId];
    if (prev) {
      deps.getState().pages[ticket.pageId] = {
        ...prev,
        branch: ws.branch,
        workspace: ws.path,
        repoDir: ws.repoDir,
        updatedAt: nowIso(),
      };
      deps.persist();
    }

    const setupRes = await tryAsync(() =>
      deps.workspace().setupWorktree(ws, ticket.repo as string),
    );
    if (setupRes.type === "err") return errResult(`環境セットアップ失敗: ${setupRes.reason}`);
    return ok(ws);
  }

  async function runAgentToResult(
    pageId: string,
    handle: AgentHandle,
    resultFile: string,
  ): Promise<Result<AgentResult, string>> {
    const runRes = await tryAsync(() => handle.done);
    if (runRes.type === "err") return errResult(runRes.reason);
    const run = runRes.value;
    deps.log.info("agent_exit", {
      page_id: pageId,
      msg: `exit=${run.code} signal=${run.signal ?? "-"} timedOut=${run.timedOut}`,
    });
    return ok(deps.agent().evaluateResult(resultFile, run.code, run.stdout));
  }

  async function onSuccess(
    ticket: Ticket,
    attempt: number,
    prUrl: string | undefined,
    summary: string | undefined,
    ws: WorkspaceInfo,
    resume: ResumeContext | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    const state = deps.getState();
    const entry = deps.active.get(ticket.pageId);
    if (entry) entry.dispatchedByUs = true;
    state.pages[ticket.pageId] = toDone({
      prev: state.pages[ticket.pageId],
      attempt,
      workspace: ws,
      prUrl,
      keepPrWatchCount: resume?.kind === "ci_failure",
      sessionId,
    });
    deps.persist();
    deps.log.info("success", { page_id: ticket.pageId, msg: prUrl ?? "(PRなし)" });

    await deps.kanbanIo.safeUpdate("success_update", ticket.pageId, (k) =>
      k.updateTicket(ticket.pageId, ticketUpdateSuccess(prUrl, deps.cfg().kanban.doneLane)),
    );
    const elapsedSec = entry ? Math.round((Date.now() - entry.startedAt) / 1000) : 0;
    await deps.kanbanIo.safeUpdate("success_comment", ticket.pageId, (k) =>
      k.addComment(
        ticket.pageId,
        commentSuccess({ summary, prUrl, elapsedSec, attempt, sessionId }),
      ),
    );
    await deps.kanbanIo.refreshLastEditedTime("success_refresh", ticket.pageId, "done");
  }

  async function onNeedsInfo(
    ticket: Ticket,
    attempt: number,
    question: string,
    ws: WorkspaceInfo,
    sessionId: string | undefined,
  ): Promise<void> {
    const questionAskedAt = nowIso();
    const state = deps.getState();
    state.pages[ticket.pageId] = toNeedsInfo({
      prev: state.pages[ticket.pageId],
      attempt,
      workspace: ws,
      question,
      questionAskedAt,
      sessionId,
    });
    deps.persist();
    deps.log.info("needs_info", {
      page_id: ticket.pageId,
      msg: `質問を投稿して回答待ちへ: ${oneLine(question, 160)}`,
    });
    await deps.kanbanIo.safeUpdate("needs_info_update", ticket.pageId, (k) =>
      k.updateTicket(ticket.pageId, { activity: activityNeedsInfo(false) }),
    );
    await deps.kanbanIo.safeUpdate("needs_info_comment", ticket.pageId, (k) =>
      k.addComment(
        ticket.pageId,
        commentNeedsInfo({ question, recovered: false, sessionId }),
      ),
    );
    await deps.kanbanIo.refreshLastEditedTime("needs_info_refresh", ticket.pageId, "needs_info");
  }

  async function onFailure(
    ticket: Ticket,
    attempt: number,
    reason: string,
    logFile: string | undefined,
    sessionId?: string,
  ): Promise<void> {
    const c = deps.cfg();
    const max = c.agent.maxAttempts;
    const shortReason = oneLine(reason, 160);
    const state = deps.getState();

    if (attempt < max) {
      const delay = computeBackoff(attempt);
      state.pages[ticket.pageId] = toRetryQueued({
        prev: state.pages[ticket.pageId],
        attempt,
        retryAt: Date.now() + delay,
        sessionId,
      });
      deps.persist();
      deps.log.warn("retry", {
        page_id: ticket.pageId,
        msg: `attempt ${attempt}/${max}, ${Math.round(delay / 1000)}s 後に再試行: ${shortReason}`,
      });
      await deps.kanbanIo.safeUpdate("retry_update", ticket.pageId, (k) =>
        k.updateTicket(ticket.pageId, { activity: activityRetry(attempt, max, shortReason) }),
      );
      return;
    }

    state.pages[ticket.pageId] = toFailed({
      prev: state.pages[ticket.pageId],
      attempt,
      ticketLastEditedTime: ticket.lastEditedTime,
      sessionId,
    });
    deps.persist();
    deps.log.error("failed", { page_id: ticket.pageId, msg: `attempt ${attempt}/${max}: ${shortReason}` });
    await deps.kanbanIo.safeUpdate("failed_update", ticket.pageId, (k) =>
      k.updateTicket(ticket.pageId, { activity: activityFailed(attempt, max, shortReason) }),
    );
    const logTail = readLogTail(logFile);
    await deps.kanbanIo.safeUpdate("failed_comment", ticket.pageId, (k) =>
      k.addComment(
        ticket.pageId,
        commentFailed({ attempt, maxAttempts: max, shortReason, sessionId, logTail }),
      ),
    );
    await deps.kanbanIo.refreshLastEditedTime("failed_refresh", ticket.pageId, "failed");
  }

  function eligibilityCfg(operatorUserId: string | null) {
    const c = deps.cfg();
    // GitHub provider は condition フィルタを queryCandidates の --label で消化済みで
    // Ticket.condition は常に null（github-kanban-adapter.ts 参照）のため、
    // conditionValue も null にして常に一致させる（Notion 用の "Local" と比較しない）。
    const conditionValue = c.kanban.provider === "github" ? null : c.kanban.notion.conditionValue;
    return {
      triggerLanes: c.kanban.triggerLanes,
      conditionValue,
      onlyOwnTickets: c.onlyOwnTickets,
      operatorUserId,
    };
  }

  function planEligibility(ticket: Ticket, operatorUserId: string | null): EligibilityDecision {
    return decideEligibility({
      ticket,
      cfg: eligibilityCfg(operatorUserId),
      isActive: deps.active.has(ticket.pageId),
      ps: deps.getState().pages[ticket.pageId],
    });
  }

  async function resolveNeedsInfoAnswers(candidates: Ticket[]): Promise<Map<string, boolean>> {
    const answers = new Map<string, boolean>();
    for (const t of candidates) {
      const ps = deps.getState().pages[t.pageId];
      if (ps?.status !== "needs_info") continue;
      const comments = await deps.kanbanIo.fetchFeedbackComments(t.pageId, ps.questionAskedAt);
      const answered = comments.length > 0;
      answers.set(t.pageId, answered);
      if (answered) {
        deps.log.info("needs_info", {
          page_id: t.pageId,
          msg: `回答コメント ${comments.length} 件を検知`,
        });
      }
    }
    return answers;
  }

  function processTick(
    candidates: Ticket[],
    needsInfoAnswers: Map<string, boolean>,
    operatorUserId: string | null,
  ): void {
    const c = deps.cfg();
    const state = deps.getState();
    for (const t of candidates) {
      const ps = state.pages[t.pageId];
      if (ps?.status === "done" && !ps.lastEditedTime && t.lastEditedTime) {
        state.pages[t.pageId] = { ...ps, lastEditedTime: t.lastEditedTime, updatedAt: nowIso() };
        deps.persist();
        deps.log.info("candidates", {
          page_id: t.pageId,
          msg: "done の基準時刻をバックフィル（今回はスキップ）",
        });
      }
    }
    const eligible = candidates
      .map((t) => ({
        t,
        decision: decideEligibility({
          ticket: t,
          cfg: eligibilityCfg(operatorUserId),
          isActive: deps.active.has(t.pageId),
          ps: state.pages[t.pageId],
          needsInfoAnswered: needsInfoAnswers.get(t.pageId),
        }),
      }))
      .filter(
        (e): e is { t: Ticket; decision: EligibilityDecision & { eligible: true } } =>
          e.decision.eligible,
      );
    deps.log.info("candidates", {
      msg: `${candidates.length} 件中 ${eligible.length} 件が dispatch 可能`,
    });
    for (const { t, decision } of eligible) {
      if (deps.isShuttingDown()) break;
      if (deps.active.size >= c.maxConcurrent) break;
      const { attempt, resume } = nextDispatchParams(decision.run, state.pages[t.pageId]);
      claim(t, attempt);
      void dispatch(t, attempt, resume).catch((err) => {
        deps.log.error("dispatch_error", { page_id: t.pageId, msg: oneLine(String(err)) });
        deps.active.delete(t.pageId);
      });
    }
  }

  /**
   * dispatch エントリを active Map に登録して返す。呼び出し側は返却された entry を
   * ベースに `void dispatch(...)` を起動する。
   */
  function claim(ticket: Ticket, attempt: number): ActiveEntry {
    const entry: ActiveEntry = {
      pageId: ticket.pageId,
      attempt,
      phase: "dispatching",
      startedAt: Date.now(),
      dispatchedByUs: false,
    };
    deps.active.set(ticket.pageId, entry);
    return entry;
  }

  async function dispatch(
    ticket: Ticket,
    attempt: number,
    resume?: ResumeContext,
  ): Promise<void> {
    const c = deps.cfg();
    const entry = deps.active.get(ticket.pageId);
    if (!entry) return;

    const state = deps.getState();
    const prevPs: PageState | undefined = state.pages[ticket.pageId];
    state.pages[ticket.pageId] = toRunning(prevPs, attempt);
    deps.persist();
    deps.log.info("claim", {
      page_id: ticket.pageId,
      msg: `${ticket.title} (attempt ${attempt}${resume ? `, resume:${resume.kind}` : ""})`,
    });
    await deps.kanbanIo.safeUpdate("claim_update", ticket.pageId, (k) =>
      k.updateTicket(ticket.pageId, {
        activity: activityStart({
          agentLabel: AGENT_LABELS[c.agent.provider],
          attempt,
          resumeKind: resume?.kind,
        }),
      }),
    );
    const prepRes = await prepareWorkspace(ticket, entry);
    if (prepRes.type === "err") {
      await onFailure(ticket, attempt, prepRes.reason, undefined);
      deps.active.delete(ticket.pageId);
      return;
    }
    const ws = prepRes.value;

    const body = await deps.kanban().getPageMarkdown(ticket.pageId);
    let resumeSection = "";
    if (resume) {
      const comments = await deps.kanbanIo.fetchFeedbackComments(ticket.pageId, resume.since);
      resumeSection = renderResumeSection(resume, comments);
      deps.log.info("resume", {
        page_id: ticket.pageId,
        msg: `[${resume.kind}] フィードバックコメント ${comments.length} 件を取り込み`,
      });
    }
    const resultFile = join(deps.resultsDir, `${ticket.pageId}.json`);
    const logFile = join(deps.runsDir, `${ticket.pageId}-attempt${attempt}.log`);
    entry.logFile = logFile;
    const promptVars = buildPromptVars({
      ticket,
      workspace: ws,
      resultFile,
      attempt,
      body,
      resumeSection,
    });
    const { sessionIdForAgent, useNativeResume } = resolveResumePlan(resume, prevPs?.sessionId);
    const { prompt, systemPrompt } = renderDispatchPrompts({
      dataHome: deps.dataHome,
      templates: {
        prompt: c.promptTemplate,
        resumePrompt: c.resumePromptTemplate,
        systemPrompt: c.systemPromptTemplate,
      },
      vars: promptVars,
      useNativeResume,
    });

    deps.log.info("agent_start", {
      page_id: ticket.pageId,
      msg: `cwd=${ws.path}${useNativeResume ? " (native resume)" : ""}`,
    });
    const handle = deps.agent().start({
      config: c,
      prompt,
      systemPrompt,
      cwd: ws.path,
      logFile,
      resultFile,
      sessionId: sessionIdForAgent,
    });
    entry.phase = "running";
    entry.handle = handle;

    const runRes = await runAgentToResult(ticket.pageId, handle, resultFile);
    if (runRes.type === "err") {
      await onFailure(ticket, attempt, `${c.agent.provider} 起動失敗: ${runRes.reason}`, logFile);
      deps.active.delete(ticket.pageId);
      return;
    }
    const result = runRes.value;

    await match(result)
      .with({ status: "success" }, (r) =>
        onSuccess(ticket, attempt, r.prUrl, r.summary, ws, resume, r.sessionId),
      )
      .with({ status: "needs_info" }, (r) =>
        r.question
          ? onNeedsInfo(ticket, attempt, r.question, ws, r.sessionId)
          : onFailure(ticket, attempt, r.reason ?? r.summary ?? "失敗", logFile, r.sessionId),
      )
      .with({ status: "failure" }, (r) =>
        onFailure(ticket, attempt, r.reason ?? r.summary ?? "失敗", logFile, r.sessionId),
      )
      .exhaustive();
    deps.active.delete(ticket.pageId);
  }

  async function dispatchAutoRework(pageId: string, input: ResumeInput): Promise<void> {
    if (deps.isShuttingDown()) return;
    const snapshot = await deps.kanban().getPage(pageId);
    const ticket = snapshot.ticket;
    if (!ticket.repo) {
      deps.log.warn("pr_watch", {
        page_id: pageId,
        msg: "自動 rework 対象のリポジトリが未設定（スキップ）",
      });
      return;
    }
    const attempt = 1;
    const resume = buildResumeContext(input);
    const entry = claim(ticket, attempt);
    entry.dispatchedByUs = true;
    deps.log.info("auto_rework", {
      page_id: pageId,
      msg: `[${resume.kind}] 自動 rework を開始: ${resume.prUrl ?? "-"}`,
    });
    void dispatch(ticket, attempt, resume).catch((err) => {
      deps.log.error("dispatch_error", { page_id: pageId, msg: oneLine(String(err)) });
      deps.active.delete(pageId);
    });
  }

  return { dispatchAutoRework, processTick, planEligibility, resolveNeedsInfoAnswers };
}
