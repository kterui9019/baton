import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { match } from "ts-pattern";
import type { AgentResult } from "../domain/agent-result.ts";
import { parseResultFile } from "../domain/agent-result.ts";
import { computeBackoff } from "../domain/backoff.ts";
import { KanbanPageNotFoundError } from "../domain/errors.ts";
import type { EligibilityDecision, ResumeContext } from "../domain/eligibility.ts";
import { decideEligibility, nextDispatchParams, resolveResumePlan } from "../domain/eligibility.ts";
import type { Result } from "../domain/result.ts";
import { err as errResult, ok } from "../domain/result.ts";
import type { PrCheck, PrWatchAction, ReviewInfo } from "../domain/review.ts";
import { decidePrWatchAction } from "../domain/review.ts";
import { rearmPrWatch } from "../domain/state.ts";
import type { RunningEntrySnapshot } from "../domain/stop-decision.ts";
import { classifyRunningEntry } from "../domain/stop-decision.ts";
import { decideCleanup, isCleanupCandidate } from "../domain/cleanup-decision.ts";
import type { PageState, PrWatchState, StateFile } from "../domain/state.ts";
import type { CommentInfo, KanbanPageSnapshot, Ticket } from "../domain/ticket.ts";
import type { WorkspaceInfo } from "../domain/workspace.ts";
import type { AgentProvider, Config, ConfigManager } from "../infrastructure/config.ts";
import { validateConfig } from "../infrastructure/config.ts";
import { hhmm, nowIso, oneLine, sleep, tail } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { AgentHandle } from "../infrastructure/process-runner.ts";
import { renderResumeSection, renderTemplate } from "./prompt-builder.ts";
import type { CodeHostPort } from "./ports/code-host-port.ts";
import type { CodingAgentPort } from "./ports/coding-agent-port.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";
import type { StateRepositoryPort } from "./ports/state-repository-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";

export interface OrchestratorOptions {
  /** ユーザーデータ（state/logs/workspaces/prompts）の基点。resolveDataHome() の値。 */
  dataHome: string;
  configManager: ConfigManager;
  log: Logger;
  dryRun?: boolean;
  kanbanPortFactory: (cfg: Config) => KanbanPort;
  codeHostPortFactory: (cfg: Config) => CodeHostPort;
  workspacePortFactory: (cfg: Config) => WorkspacePort;
  codingAgentPortFactory: (cfg: Config) => CodingAgentPort;
  stateRepository: StateRepositoryPort;
}

export interface OrchestratorHandle {
  tick: () => Promise<void>;
  recoverOnStartup: () => Promise<void>;
  shutdown: () => Promise<void>;
  printStatus: () => void;
  hasActive: () => boolean;
  getState: () => StateFile;
  setState: (state: StateFile) => void;
}

const AGENT_LABELS: Record<AgentProvider, string> = {
  claude: "Claude Code",
  takt: "takt",
  opencode: "opencode",
  grok: "Grok",
  codex: "Codex",
};

interface ActiveEntry {
  pageId: string;
  attempt: number;
  phase: "dispatching" | "running";
  handle?: AgentHandle;
  workspace?: WorkspaceInfo;
  logFile?: string;
  startedAt: number;
  /** オーケストレーター自身がレーンを動かしたか（stopMovedOrDeletedRuns の race 回避）。 */
  dispatchedByUs: boolean;
}

/** dispatch 判定・PR 監視・成功/失敗ハンドリングを行う中核ユースケース。可変状態はクロージャで保持し class は使わない。 */
export function createOrchestrator(opts: OrchestratorOptions): OrchestratorHandle {
  const { dataHome, configManager, log, dryRun = false } = opts;
  const resultsDir = join(dataHome, "state", "results");
  const runsDir = join(dataHome, "logs", "runs");
  const stateRepo = opts.stateRepository;

  let state: StateFile = stateRepo.load();
  const active = new Map<string, ActiveEntry>();
  let shuttingDown = false;
  let botUserId: string | null | undefined;
  let lastPrPollAt = 0;

  function cfg(): Config {
    return configManager.get();
  }
  function kanban(): KanbanPort {
    return opts.kanbanPortFactory(cfg());
  }
  function codeHost(): CodeHostPort {
    return opts.codeHostPortFactory(cfg());
  }
  function workspace(): WorkspacePort {
    return opts.workspacePortFactory(cfg());
  }
  function agent(): CodingAgentPort {
    return opts.codingAgentPortFactory(cfg());
  }

  function persist(): void {
    try {
      stateRepo.save(state);
    } catch (err) {
      log.error("state_save_error", { msg: String(err) });
    }
  }

  async function safeKanban(
    event: string,
    pageId: string,
    fn: (k: KanbanPort) => Promise<void>,
  ): Promise<void> {
    try {
      await fn(kanban());
    } catch (err) {
      log.warn("kanban_update_error", {
        page_id: pageId,
        msg: `${event}: ${oneLine(String(err))}`,
      });
    }
  }


  async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, string>> {
    try {
      return ok(await fn());
    } catch (e) {
      return errResult(oneLine(String(e)));
    }
  }

  function readRecoveredResult(pageId: string): AgentResult | null {
    const resultFile = join(resultsDir, `${pageId}.json`);
    try {
      if (!existsSync(resultFile)) return null;
      return parseResultFile(readFileSync(resultFile, "utf8"));
    } catch {
      return null;
    }
  }

  async function finalizeRecoveredSuccess(
    pageId: string,
    ps: PageState,
    prUrl: string | undefined,
    summary: string | undefined,
  ): Promise<void> {
    const c = cfg();
    state.pages[pageId] = {
      status: "done",
      attempt: ps.attempt,
      branch: ps.branch,
      workspace: ps.workspace,
      repoDir: ps.repoDir,
      prUrl,
      prWatch: prUrl ? rearmPrWatch(ps.prWatch, prUrl, true) : undefined,
      updatedAt: nowIso(),
    };
    log.info("recovered_success", {
      page_id: pageId,
      msg: `起動リカバリ: 完遂済みを検出し done 確定 — ${prUrl ?? "(PRなし)"}`,
    });
    await safeKanban("recovered_success_update", pageId, (k) =>
      k.updateTicket(
        pageId,
        prUrl
          ? {
              prUrl,
              activity: `✅ PR 作成完了（再起動時に確定） — CI 待ち (${hhmm()})`,
            }
          : {
              lane: c.kanban.doneLane,
              activity: `✅ 完了（PRなし・再起動時に確定） — ${hhmm()}`,
            },
      ),
    );
    await safeKanban("recovered_success_comment", pageId, (k) => {
      const comment = [
        summary ? summary : prUrl ? "PR を作成しました。" : "作業を完了しました（PR は作成していません）。",
        prUrl ? `PR: ${prUrl}` : undefined,
        "（デーモン再起動時に完了を確定しました）",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
      return k.addComment(pageId, comment);
    });
    await recordLastEditedTime("recovered_success_refresh", pageId, "done");
  }

  async function finalizeRecoveredNeedsInfo(
    pageId: string,
    ps: PageState,
    question: string,
  ): Promise<void> {
    const questionAskedAt = nowIso();
    state.pages[pageId] = {
      status: "needs_info",
      attempt: ps.attempt,
      branch: ps.branch,
      workspace: ps.workspace,
      repoDir: ps.repoDir,
      prUrl: ps.prUrl,
      prWatch: ps.prWatch,
      questionAskedAt,
      question,
      updatedAt: nowIso(),
    };
    log.info("recovered_needs_info", {
      page_id: pageId,
      msg: `起動リカバリ: needs_info を確定 — ${oneLine(question, 160)}`,
    });
    await notifyNeedsInfo(pageId, question, true);
  }

  async function recoverOnStartup(): Promise<void> {
    const orphans = Object.entries(state.pages).filter(
      ([, ps]) => ps.status === "running",
    );
    if (orphans.length === 0) return;

    for (const [pageId, ps] of orphans) {
      const result = readRecoveredResult(pageId);
      if (result === null) {
        demoteToRetryQueued(pageId, ps);
        continue;
      }
      await match(result)
        .with({ status: "success" }, (r) =>
          finalizeRecoveredSuccess(pageId, ps, r.prUrl, r.summary),
        )
        .with({ status: "needs_info" }, (r) =>
          r.question
            ? finalizeRecoveredNeedsInfo(pageId, ps, r.question)
            : Promise.resolve(demoteToRetryQueued(pageId, ps)),
        )
        .with({ status: "failure" }, () =>
          Promise.resolve(demoteToRetryQueued(pageId, ps)),
        )
        .exhaustive();
    }
    persist();
  }

  function demoteToRetryQueued(pageId: string, ps: PageState): void {
    state.pages[pageId] = { ...ps, status: "retry_queued", retryAt: 0, updatedAt: nowIso() };
    log.info("tick", {
      page_id: pageId,
      msg: "起動リカバリ: running → retry_queued に降格",
    });
  }


  async function tick(): Promise<void> {
    if (configManager.maybeReload()) {
      log.info("config_reload", { msg: "config.json を再読込" });
      for (const e of validateConfig(cfg())) {
        log.warn("config_reload", { msg: `設定検証エラー: ${e}` });
      }
    }
    log.info("tick", { msg: `active=${active.size} dryRun=${dryRun}` });

    if (dryRun) {
      await dryRunTick();
      return;
    }

    try {
      await stopMovedOrDeletedRuns();
      await terminalCleanup();
      await advancePrWatch();
      const candidates = await kanban().queryCandidates();
      const needsInfoAnswers = await checkNeedsInfoAnswers(candidates);
      dispatchLoop(candidates, needsInfoAnswers);
    } catch (err) {
      log.warn("tracker_error", { msg: oneLine(String(err)) });
    }
  }

  async function checkNeedsInfoAnswers(
    candidates: Ticket[],
  ): Promise<Map<string, boolean>> {
    const answers = new Map<string, boolean>();
    for (const t of candidates) {
      const ps = state.pages[t.pageId];
      if (ps?.status !== "needs_info") continue;
      const comments = await fetchFeedbackComments(t.pageId, ps.questionAskedAt);
      const answered = comments.length > 0;
      answers.set(t.pageId, answered);
      if (answered) {
        log.info("needs_info", {
          page_id: t.pageId,
          msg: `回答コメント ${comments.length} 件を検知`,
        });
      }
    }
    return answers;
  }

  async function dryRunTick(): Promise<void> {
    try {
      const candidates = await kanban().queryCandidates();
      log.info("candidates", { msg: `${candidates.length} 件` });
      for (const t of candidates) {
        const decision = eligibility(t);
        log.info("candidates", {
          page_id: t.pageId,
          msg: `${t.title} | repo=${t.repo ?? "-"} lane=${t.lane ?? "-"} → ${
            decision.eligible ? "DISPATCH" : "SKIP"
          } (${decision.reason})`,
        });
      }
      log.info("tick", { msg: "dry-run 完了（書き込みなし）" });
    } catch (err) {
      log.warn("tracker_error", { msg: oneLine(String(err)) });
    }
  }


  function eligibility(t: Ticket, needsInfoAnswered?: boolean): EligibilityDecision {
    const c = cfg();
    // GitHub provider は condition フィルタを queryCandidates の --label で消化済みで
    // Ticket.condition は常に null（github-kanban-adapter.ts 参照）のため、
    // conditionValue も null にして常に一致させる（Notion 用の "Local" と比較しない）。
    const conditionValue = c.kanban.provider === "github" ? null : c.kanban.notion.conditionValue;
    return decideEligibility({
      ticket: t,
      cfg: { triggerLanes: c.kanban.triggerLanes, conditionValue },
      isActive: active.has(t.pageId),
      ps: state.pages[t.pageId],
      needsInfoAnswered,
    });
  }

  function dispatchLoop(
    candidates: Ticket[],
    needsInfoAnswers?: Map<string, boolean>,
  ): void {
    const c = cfg();
    for (const t of candidates) {
      const ps = state.pages[t.pageId];
      if (ps?.status === "done" && !ps.lastEditedTime && t.lastEditedTime) {
        state.pages[t.pageId] = { ...ps, lastEditedTime: t.lastEditedTime, updatedAt: nowIso() };
        persist();
        log.info("candidates", {
          page_id: t.pageId,
          msg: "done の基準時刻をバックフィル（今回はスキップ）",
        });
      }
    }
    const eligible = candidates
      .map((t) => ({ t, decision: eligibility(t, needsInfoAnswers?.get(t.pageId)) }))
      .filter((e) => e.decision.eligible);
    log.info("candidates", {
      msg: `${candidates.length} 件中 ${eligible.length} 件が dispatch 可能`,
    });
    for (const { t, decision } of eligible) {
      if (shuttingDown) break;
      if (active.size >= c.maxConcurrent) break;
      const { attempt, resume } = nextDispatchParams(
        decision.resumeKind,
        state.pages[t.pageId],
      );
      active.set(t.pageId, {
        pageId: t.pageId,
        attempt,
        phase: "dispatching",
        startedAt: Date.now(),
        dispatchedByUs: false,
      });
      void dispatch(t, attempt, resume).catch((err) => {
        log.error("dispatch_error", { page_id: t.pageId, msg: oneLine(String(err)) });
        active.delete(t.pageId);
      });
    }
  }

  async function dispatch(
    ticket: Ticket,
    attempt: number,
    resume?: ResumeContext,
  ): Promise<void> {
    const c = cfg();
    const entry = active.get(ticket.pageId);
    if (!entry) return;

    const prevPs = state.pages[ticket.pageId];
    state.pages[ticket.pageId] = {
      status: "running",
      attempt,
      branch: prevPs?.branch,
      workspace: prevPs?.workspace,
      repoDir: prevPs?.repoDir,
      prUrl: prevPs?.prUrl,
      prWatch: prevPs?.prWatch,
      updatedAt: nowIso(),
    };
    persist();
    log.info("claim", {
      page_id: ticket.pageId,
      msg: `${ticket.title} (attempt ${attempt}${resume ? `, resume:${resume.kind}` : ""})`,
    });
    const startVerb = resume
      ? resume.kind === "needs_info_answer"
        ? "再開"
        : "やり直し"
      : "実行";
    await safeKanban("claim_update", ticket.pageId, (k) =>
      k.updateTicket(ticket.pageId, {
        activity: `🤖 ${AGENT_LABELS[c.agent.provider]} ${startVerb}開始 (attempt ${attempt}) — ${hhmm()}`,
      }),
    );

    const prepRes = await prepareWorkspace(ticket, entry);
    if (prepRes.type === "err") {
      await dispatchFail(ticket, attempt, prepRes.reason, undefined);
      return;
    }
    const ws = prepRes.value;

    const body = await kanban().getPageMarkdown(ticket.pageId);
    let resumeSection = "";
    if (resume) {
      const comments = await fetchFeedbackComments(ticket.pageId, resume.since);
      resumeSection = renderResumeSection(resume, comments);
      log.info("resume", {
        page_id: ticket.pageId,
        msg: `[${resume.kind}] フィードバックコメント ${comments.length} 件を取り込み`,
      });
    }
    const resultFile = join(resultsDir, `${ticket.pageId}.json`);
    const logFile = join(runsDir, `${ticket.pageId}-attempt${attempt}.log`);
    entry.logFile = logFile;
    const promptVars = buildPromptVars(ticket, ws, resultFile, attempt, body, resumeSection);
    const { sessionIdForAgent, useNativeResume } = resolveResumePlan(resume, prevPs?.sessionId);
    const prompt = useNativeResume ? renderResumePrompt(promptVars) : renderPrompt(promptVars);
    const systemPrompt = renderSystemPrompt(promptVars);

    log.info("agent_start", {
      page_id: ticket.pageId,
      msg: `cwd=${ws.path}${useNativeResume ? " (native resume)" : ""}`,
    });
    const handle = agent().start({
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
      await dispatchFail(
        ticket,
        attempt,
        `${c.agent.provider} 起動失敗: ${runRes.reason}`,
        logFile,
      );
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
          : onFailure(
              ticket,
              attempt,
              r.reason ?? r.summary ?? "失敗",
              logFile,
              r.sessionId,
            ),
      )
      .with({ status: "failure" }, (r) =>
        onFailure(
          ticket,
          attempt,
          r.reason ?? r.summary ?? "失敗",
          logFile,
          r.sessionId,
        ),
      )
      .exhaustive();
    active.delete(ticket.pageId);
  }

  /**
   * dispatch 準備段: worktree 作成 → state 反映 → 環境セットアップ。
   * どこで落ちても reason を持った err を返し、副作用は「成功時のみ」に閉じる。
   */
  async function prepareWorkspace(
    ticket: Ticket,
    entry: ActiveEntry,
  ): Promise<Result<WorkspaceInfo, string>> {
    const wsRes = await tryAsync(() =>
      workspace().createWorktree(ticket.pageId, ticket.title, ticket.repo as string),
    );
    if (wsRes.type === "err") return errResult(`workspace 作成失敗: ${wsRes.reason}`);
    const ws = wsRes.value;
    entry.workspace = ws;
    state.pages[ticket.pageId] = {
      ...state.pages[ticket.pageId]!,
      branch: ws.branch,
      workspace: ws.path,
      repoDir: ws.repoDir,
      updatedAt: nowIso(),
    };
    persist();

    const setupRes = await tryAsync(() =>
      workspace().setupWorktree(ws, ticket.repo as string),
    );
    if (setupRes.type === "err") return errResult(`環境セットアップ失敗: ${setupRes.reason}`);
    return ok(ws);
  }

  /**
   * エージェント起動〜結果評価。プロセス例外は err にまとめる（reason はメッセージのみ）。
   */
  async function runAgentToResult(
    pageId: string,
    handle: AgentHandle,
    resultFile: string,
  ): Promise<Result<AgentResult, string>> {
    const runRes = await tryAsync(() => handle.done);
    if (runRes.type === "err") return errResult(runRes.reason);
    const run = runRes.value;
    log.info("agent_exit", {
      page_id: pageId,
      msg: `exit=${run.code} signal=${run.signal ?? "-"} timedOut=${run.timedOut}`,
    });
    return ok(agent().evaluateResult(resultFile, run.code, run.stdout));
  }

  /** dispatch 内の失敗ハンドリング統一 helper（onFailure + active.delete）。 */
  async function dispatchFail(
    ticket: Ticket,
    attempt: number,
    reason: string,
    logFile: string | undefined,
  ): Promise<void> {
    await onFailure(ticket, attempt, reason, logFile);
    active.delete(ticket.pageId);
  }

  function buildPromptVars(
    ticket: Ticket,
    ws: WorkspaceInfo,
    resultFile: string,
    attempt: number,
    body: string,
    resumeSection: string,
  ): Record<string, string> {
    return {
      title: ticket.title,
      body,
      repo: ticket.repo ?? "",
      branch: ws.branch,
      base_branch: ws.baseBranch,
      page_url: ticket.url,
      page_id: ticket.pageId,
      result_file: resultFile,
      attempt: String(attempt),
      rework: resumeSection,
    };
  }

  function renderFromTemplate(templatePathConfig: string, vars: Record<string, string>): string {
    const templatePath = isAbsolute(templatePathConfig)
      ? templatePathConfig
      : join(dataHome, templatePathConfig);
    const template = readFileSync(templatePath, "utf8");
    return renderTemplate(template, vars);
  }

  function renderPrompt(vars: Record<string, string>): string {
    return renderFromTemplate(cfg().promptTemplate, vars);
  }

  /** ネイティブ resume 時に使う軽量プロンプト（チケット全文を含まない）。 */
  function renderResumePrompt(vars: Record<string, string>): string {
    return renderFromTemplate(cfg().resumePromptTemplate, vars);
  }

  /** systemPromptTemplate が未設定なら undefined（`--append-system-prompt` を付与しない）。 */
  function renderSystemPrompt(vars: Record<string, string>): string | undefined {
    const templatePathConfig = cfg().systemPromptTemplate;
    if (!templatePathConfig) return undefined;
    return renderFromTemplate(templatePathConfig, vars);
  }

  async function fetchFeedbackComments(
    pageId: string,
    since: string | undefined,
  ): Promise<CommentInfo[]> {
    try {
      if (botUserId === undefined) {
        try {
          botUserId = await kanban().getBotUserId();
        } catch {
          botUserId = null;
        }
      }
      const all = await kanban().listComments(pageId);
      return all.filter(
        (c) => (!since || c.createdTime > since) && (botUserId == null || c.authorId !== botUserId),
      );
    } catch (err) {
      log.warn("rework", {
        page_id: pageId,
        msg: `コメント取得失敗（本文のみで続行）: ${oneLine(String(err))}`,
      });
      return [];
    }
  }


  async function onSuccess(
    ticket: Ticket,
    attempt: number,
    prUrl: string | undefined,
    summary: string | undefined,
    ws: WorkspaceInfo,
    resume?: ResumeContext,
    sessionId?: string,
  ): Promise<void> {
    const entry = active.get(ticket.pageId);
    if (entry) entry.dispatchedByUs = true;
    const prevWatch = state.pages[ticket.pageId]?.prWatch;
    state.pages[ticket.pageId] = {
      status: "done",
      attempt,
      branch: ws.branch,
      workspace: ws.path,
      repoDir: ws.repoDir,
      prUrl,
      prWatch: prUrl ? rearmPrWatch(prevWatch, prUrl, resume?.kind === "ci_failure") : undefined,
      sessionId: sessionId ?? state.pages[ticket.pageId]?.sessionId,
      updatedAt: nowIso(),
    };
    persist();
    log.info("success", { page_id: ticket.pageId, msg: prUrl ?? "(PRなし)" });

    await safeKanban("success_update", ticket.pageId, (k) =>
      k.updateTicket(
        ticket.pageId,
        prUrl
          ? { prUrl, activity: `✅ PR 作成完了 — CI 待ち (${hhmm()})` }
          : { lane: cfg().kanban.doneLane, activity: `✅ 完了（PRなし） — ${hhmm()}` },
      ),
    );
    const elapsed = entry ? Math.round((Date.now() - entry.startedAt) / 1000) : 0;
    const comment = [
      summary ? summary : prUrl ? "PR を作成しました。" : "作業を完了しました（PR は作成していません）。",
      prUrl ? `PR: ${prUrl}` : undefined,
      `実行時間: 約 ${elapsed} 秒 (attempt ${attempt})`,
      sessionId ? `セッションID: ${sessionId}` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    await safeKanban("success_comment", ticket.pageId, (k) => k.addComment(ticket.pageId, comment));
    await recordLastEditedTime("success_refresh", ticket.pageId, "done");
  }

  async function onNeedsInfo(
    ticket: Ticket,
    attempt: number,
    question: string,
    ws: WorkspaceInfo,
    sessionId?: string,
  ): Promise<void> {
    const questionAskedAt = nowIso();
    const prev = state.pages[ticket.pageId];
    state.pages[ticket.pageId] = {
      status: "needs_info",
      attempt,
      branch: ws.branch,
      workspace: ws.path,
      repoDir: ws.repoDir,
      prUrl: prev?.prUrl,
      prWatch: prev?.prWatch,
      questionAskedAt,
      question,
      sessionId: sessionId ?? prev?.sessionId,
      updatedAt: nowIso(),
    };
    persist();
    log.info("needs_info", {
      page_id: ticket.pageId,
      msg: `質問を投稿して回答待ちへ: ${oneLine(question, 160)}`,
    });
    await notifyNeedsInfo(ticket.pageId, question, false, sessionId);
  }

  async function notifyNeedsInfo(
    pageId: string,
    question: string,
    recovered: boolean,
    sessionId?: string,
  ): Promise<void> {
    await safeKanban("needs_info_update", pageId, (k) =>
      k.updateTicket(pageId, {
        activity: `❓ 要回答 — 質問をコメントに投稿${recovered ? "（再起動時に確定）" : ""} — ${hhmm()}`,
      }),
    );
    await safeKanban("needs_info_comment", pageId, (k) => {
      const comment = [
        "❓ 実装を進めるには確認が必要です",
        "",
        question,
        "",
        "このコメントに返信（またはページにコメント追加）してください。返信を検知したら自動で再開します。",
        ...(recovered ? ["（デーモン再起動時に確定しました）"] : []),
        ...(sessionId ? [`セッションID: ${sessionId}`] : []),
      ].join("\n");
      return k.addComment(pageId, comment);
    });
    await recordLastEditedTime(
      recovered ? "recovered_needs_info_refresh" : "needs_info_refresh",
      pageId,
      "needs_info",
    );
  }

  async function recordLastEditedTime(
    event: string,
    pageId: string,
    expectStatus: "done" | "failed" | "needs_info",
  ): Promise<void> {
    await safeKanban(event, pageId, async (k) => {
      const snapshot = await k.getPage(pageId);
      const ps = state.pages[pageId];
      if (snapshot.ticket.lastEditedTime && ps?.status === expectStatus) {
        state.pages[pageId] = { ...ps, lastEditedTime: snapshot.ticket.lastEditedTime };
        persist();
      }
    });
  }

  async function onFailure(
    ticket: Ticket,
    attempt: number,
    reason: string,
    logFile: string | undefined,
    sessionId?: string,
  ): Promise<void> {
    const c = cfg();
    const max = c.agent.maxAttempts;
    const shortReason = oneLine(reason, 160);

    if (attempt < max) {
      const delay = computeBackoff(attempt);
      const prev = state.pages[ticket.pageId];
      state.pages[ticket.pageId] = {
        ...(prev ?? { attempt, updatedAt: nowIso() }),
        status: "retry_queued",
        attempt,
        retryAt: Date.now() + delay,
        sessionId: sessionId ?? prev?.sessionId,
        updatedAt: nowIso(),
      };
      persist();
      log.warn("retry", {
        page_id: ticket.pageId,
        msg: `attempt ${attempt}/${max}, ${Math.round(delay / 1000)}s 後に再試行: ${shortReason}`,
      });
      await safeKanban("retry_update", ticket.pageId, (k) =>
        k.updateTicket(ticket.pageId, {
          activity: `⚠️ 失敗 (attempt ${attempt}/${max})、リトライ待ち: ${shortReason}`,
        }),
      );
      return;
    }

    const prev = state.pages[ticket.pageId];
    state.pages[ticket.pageId] = {
      ...(prev ?? { attempt, updatedAt: nowIso() }),
      status: "failed",
      attempt,
      lastEditedTime: ticket.lastEditedTime,
      sessionId: sessionId ?? prev?.sessionId,
      updatedAt: nowIso(),
    };
    persist();
    log.error("failed", { page_id: ticket.pageId, msg: `attempt ${attempt}/${max}: ${shortReason}` });
    await safeKanban("failed_update", ticket.pageId, (k) =>
      k.updateTicket(ticket.pageId, { activity: `❌ 失敗 (attempt ${attempt}/${max}): ${shortReason}` }),
    );
    const logTail = readLogTail(logFile);
    const comment = [
      `❌ 自動実装に失敗しました (attempt ${attempt}/${max})`,
      `理由: ${shortReason}`,
      sessionId ? `セッションID: ${sessionId}` : "",
      logTail ? `\n--- ログ末尾 ---\n${logTail}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await safeKanban("failed_comment", ticket.pageId, (k) => k.addComment(ticket.pageId, comment));
    await recordLastEditedTime("failed_refresh", ticket.pageId, "failed");
  }

  function readLogTail(logFile: string | undefined): string {
    if (!logFile) return "";
    try {
      if (!existsSync(logFile)) return "";
      return tail(readFileSync(logFile, "utf8"), 1000);
    } catch {
      return "";
    }
  }


  async function stopMovedOrDeletedRuns(): Promise<void> {
    const c = cfg();
    const running = [...active.values()].filter((e) => e.phase === "running" && e.handle);
    for (const entry of running) {
      const snapshot = await fetchRunningSnapshot(entry.pageId);
      const status = classifyRunningEntry({
        snapshot,
        triggerLanes: c.kanban.triggerLanes,
        dispatchedByUs: entry.dispatchedByUs,
      });
      match(status)
        .with({ type: "kill_gone" }, ({ reason }) => {
          log.warn("stop_stray_kill", {
            page_id: entry.pageId,
            msg:
              reason === "not_found"
                ? "ページが存在しない、停止"
                : "アーカイブ/削除済み、停止",
          });
          killAndRelease(entry);
        })
        .with({ type: "kill_moved" }, ({ lane }) => {
          log.warn("stop_stray_kill", {
            page_id: entry.pageId,
            msg: `レーンが対象外(${lane})に移動、停止`,
          });
          killAndRelease(entry);
        })
        .with({ type: "fetch_error" }, ({ message }) => {
          log.warn("stop_stray", {
            page_id: entry.pageId,
            msg: `ページ取得失敗（スキップ）: ${message}`,
          });
        })
        .with({ type: "keep" }, () => {})
        .exhaustive();
    }
  }

  /** getPage を try/catch で ADT に落とす IO ヘルパ。 */
  async function fetchRunningSnapshot(pageId: string): Promise<RunningEntrySnapshot> {
    try {
      return { type: "snapshot", value: await kanban().getPage(pageId) };
    } catch (e) {
      if (e instanceof KanbanPageNotFoundError) return { type: "not_found" };
      return { type: "fetch_error", message: oneLine(String(e)) };
    }
  }

  function killAndRelease(entry: ActiveEntry): void {
    entry.handle?.terminate(5000);
    active.delete(entry.pageId);
    delete state.pages[entry.pageId];
    persist();
  }


  async function terminalCleanup(): Promise<void> {
    const c = cfg();
    for (const [pageId, ps] of Object.entries(state.pages)) {
      if (!isCleanupCandidate(ps, active.has(pageId))) continue;
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
          workspace().removeWorktree(action.worktree!.repoDir, action.worktree!.path),
        );
        if (removeRes.type === "err") {
          log.warn("cleanup", {
            page_id: pageId,
            msg: `worktree 削除失敗: ${removeRes.reason}`,
          });
        }
      }
      delete state.pages[pageId];
      persist();
      log.info("cleanup", {
        page_id: pageId,
        msg: `terminal(${action.lane}) 到達、state から削除`,
      });
    }
  }

  /** getPage を握って snapshot | null に落とす。cleanup では失敗種別を区別しないので単純化。 */
  async function tryFetchPage(pageId: string): Promise<KanbanPageSnapshot | null> {
    try {
      return await kanban().getPage(pageId);
    } catch {
      return null;
    }
  }


  async function advancePrWatch(): Promise<void> {
    const c = cfg();
    const now = Date.now();
    if (now - lastPrPollAt < c.prPollIntervalMs) return;
    lastPrPollAt = now;
    const ch = codeHost();
    for (const [pageId, ps] of Object.entries(state.pages)) {
      if (ps.status !== "done") continue;
      const watch = ps.prWatch;
      if (!watch || watch.awaitingHuman) continue;
      if (active.has(pageId)) continue;
      try {
        const snapshot = await ch.fetchPrSnapshot(watch.prUrl);
        if (!snapshot) {
          log.warn("pr_watch", {
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
        log.warn("pr_watch", { page_id: pageId, msg: oneLine(String(err)) });
      }
    }
  }

  async function handlePrWatchAction(
    pageId: string,
    ps: PageState,
    watch: PrWatchState,
    headSha: string,
    action: PrWatchAction,
  ): Promise<void> {
    const c = cfg();
    await match(action)
      .with({ type: "merged" }, async () => {
        state.pages[pageId] = { ...ps, prWatch: undefined, updatedAt: nowIso() };
        persist();
        log.info("pr_watch", { page_id: pageId, msg: `PR マージ検知 → ${c.kanban.mergedLane} へ: ${watch.prUrl}` });
        await safeKanban("pr_merged_update", pageId, (k) =>
          k.updateTicket(pageId, { lane: c.kanban.mergedLane, activity: `🚀 PR マージ検知 — ${hhmm()}` }),
        );
        await safeKanban("pr_merged_comment", pageId, (k) =>
          k.addComment(pageId, `PR がマージされました: ${watch.prUrl}`),
        );
        await recordLastEditedTime("pr_merged_refresh", pageId, "done");
      })
      .with({ type: "closed" }, async () => {
        state.pages[pageId] = { ...ps, prWatch: undefined, updatedAt: nowIso() };
        persist();
        log.info("pr_watch", {
          page_id: pageId,
          msg: `PR がマージされずクローズ（監視終了）: ${watch.prUrl}`,
        });
        await safeKanban("pr_closed_update", pageId, (k) =>
          k.updateTicket(pageId, { activity: `⏹ PR がマージされずクローズ — ${hhmm()}` }),
        );
        await safeKanban("pr_closed_comment", pageId, (k) =>
          k.addComment(pageId, `PR がマージされずクローズされました（監視を終了します）: ${watch.prUrl}`),
        );
        await recordLastEditedTime("pr_closed_refresh", pageId, "done");
      })
      .with({ type: "ci_green" }, async () => {
        const snapshot = await kanban().getPage(pageId);
        const lane = snapshot.ticket.lane;
        const moveLane = lane !== null && c.kanban.triggerLanes.includes(lane);
        const nextWatch: PrWatchState = { ...watch, phase: "review", headSha };
        state.pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
        persist();
        log.info("pr_watch", {
          page_id: pageId,
          msg: `CI グリーン → レビュー待ち${
            moveLane ? `（${c.kanban.doneLane} へ移動）` : `（レーン ${lane} は維持）`
          }: ${watch.prUrl}`,
        });
        await safeKanban("ci_green_update", pageId, (k) =>
          k.updateTicket(pageId, {
            ...(moveLane ? { lane: c.kanban.doneLane } : {}),
            activity: `✅ CI グリーン — レビュー待ち (${hhmm()})`,
          }),
        );
        await recordLastEditedTime("ci_green_refresh", pageId, "done");
      })
      .with({ type: "ci_rework" }, async (a) => {
        if (!canStartRework()) {
          log.info("pr_watch", {
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
        state.pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
        persist();
        log.info("pr_watch", {
          page_id: pageId,
          msg: `CI 失敗を検知 → 自動 rework (${nextWatch.autoReworkCount}/${c.autoReworkLimit}) sha=${a.headSha}`,
        });
        const ciFailures = await codeHost().fetchFailedCheckLogs(watch.prUrl, a.failedChecks);
        await dispatchAutoRework(pageId, {
          kind: "ci_failure",
          prUrl: watch.prUrl,
          since: ps.lastEditedTime,
          ciFailures,
        });
      })
      .with({ type: "ci_limit" }, async (a) => {
        const nextWatch: PrWatchState = { ...watch, awaitingHuman: true };
        state.pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
        persist();
        log.warn("pr_watch", {
          page_id: pageId,
          msg: `CI 自動修正が上限 (${watch.autoReworkCount}回) に到達 — 人間待ちへ: ${watch.prUrl}`,
        });
        await safeKanban("ci_limit_update", pageId, (k) =>
          k.updateTicket(pageId, {
            activity: `🆘 CI 自動修正が上限 (${watch.autoReworkCount}回) に到達 — 人間の対応が必要 — ${hhmm()}`,
          }),
        );
        await safeKanban("ci_limit_comment", pageId, (k) => {
          const checkLines = a.failedChecks.map(
            (chk: PrCheck) => `- ${chk.name}: ${chk.detailsUrl ?? "(詳細URLなし)"}`,
          );
          return k.addComment(
            pageId,
            [
              `🆘 CI の自動修正が上限 (${watch.autoReworkCount}回) に達しました。人間の対応が必要です。`,
              `PR: ${watch.prUrl}`,
              "失敗している check:",
              ...checkLines,
            ].join("\n"),
          );
        });
        await recordLastEditedTime("ci_limit_refresh", pageId, "done");
      })
      .with({ type: "review_rework" }, async (a) => {
        if (!canStartRework()) {
          log.info("pr_watch", {
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
        state.pages[pageId] = { ...ps, prWatch: nextWatch, updatedAt: nowIso() };
        persist();
        log.info("pr_watch", {
          page_id: pageId,
          msg: `changes requested を検知 (${a.reviews.length} 件) → 自動 rework: ${watch.prUrl}`,
        });
        const inline = await codeHost().fetchInlineComments(watch.prUrl);
        const reviews = [...a.reviews, ...inline].map((r) => ({
          author: r.author,
          body: r.body,
          submittedAt: r.submittedAt,
        }));
        const lane0 = c.kanban.triggerLanes[0];
        if (lane0) {
          await safeKanban("review_rework_lane", pageId, (k) => k.updateTicket(pageId, { lane: lane0 }));
        }
        await dispatchAutoRework(pageId, {
          kind: "review_changes",
          prUrl: watch.prUrl,
          since: ps.lastEditedTime,
          reviews,
        });
      })
      .with({ type: "none" }, (a) => {
        log.info("pr_watch", { page_id: pageId, msg: `変化なし (${a.reason}): ${watch.prUrl}` });
      })
      .exhaustive();
  }

  function canStartRework(): boolean {
    return !shuttingDown && active.size < cfg().maxConcurrent;
  }

  async function dispatchAutoRework(pageId: string, resume: ResumeContext): Promise<void> {
    const snapshot = await kanban().getPage(pageId);
    const ticket = snapshot.ticket;
    if (!ticket.repo) {
      log.warn("pr_watch", { page_id: pageId, msg: "自動 rework 対象のリポジトリが未設定（スキップ）" });
      return;
    }
    const attempt = 1;
    active.set(pageId, {
      pageId,
      attempt,
      phase: "dispatching",
      startedAt: Date.now(),
      dispatchedByUs: true,
    });
    log.info("auto_rework", {
      page_id: pageId,
      msg: `[${resume.kind}] 自動 rework を開始: ${resume.prUrl ?? "-"}`,
    });
    void dispatch(ticket, attempt, resume).catch((err) => {
      log.error("dispatch_error", { page_id: pageId, msg: oneLine(String(err)) });
      active.delete(pageId);
    });
  }


  async function shutdown(): Promise<void> {
    shuttingDown = true;
    const running = [...active.values()].filter((e) => e.handle);
    log.info("tick", { msg: `shutdown: running ${running.length} 件に SIGTERM` });
    for (const e of running) {
      e.handle?.terminate(10_000);
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const alive = [...active.values()].some((e) => e.handle);
      if (!alive) break;
      await sleep(200);
    }
    persist();
  }


  function printStatus(): void {
    const pages = Object.entries(state.pages);
    console.log(`baton status`);
    console.log(`pages: ${pages.length}`);
    for (const [pageId, ps] of pages) {
      const extra: string[] = [`attempt=${ps.attempt}`];
      if (ps.status === "retry_queued") {
        const waitS = Math.max(0, Math.round((ps.retryAt - Date.now()) / 1000));
        extra.push(`retryIn=${waitS}s`);
      }
      if (ps.status === "needs_info") {
        extra.push(`askedAt=${ps.questionAskedAt}`);
        if (ps.question) extra.push(`Q: ${oneLine(ps.question, 60)}`);
      }
      if (ps.prWatch) {
        extra.push(
          `prWatch=${ps.prWatch.phase} ciReworks=${ps.prWatch.autoReworkCount}${
            ps.prWatch.awaitingHuman ? " awaitingHuman" : ""
          }`,
        );
      }
      if (ps.prUrl) extra.push(ps.prUrl);
      if (ps.branch) extra.push(ps.branch);
      console.log(`  ${pageId}  ${ps.status.padEnd(12)} ${extra.join(" ")}`);
    }
    const running = [...active.values()].filter((e) => e.handle);
    console.log(`running processes (this instance): ${running.length}`);
    for (const e of running) {
      console.log(`  ${e.pageId}  pid=${e.handle?.pid ?? "-"} attempt=${e.attempt}`);
    }
  }

  return {
    tick,
    recoverOnStartup,
    shutdown,
    printStatus,
    hasActive: () => active.size > 0,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
  };
}
