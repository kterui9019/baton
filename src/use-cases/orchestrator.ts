import { join } from "node:path";
import type { StateFile } from "../domain/state.ts";
import type { Config, ConfigManager } from "../infrastructure/config.ts";
import { validateConfig } from "../infrastructure/config.ts";
import { oneLine } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import { printStatus } from "../infrastructure/status-printer.ts";
import { createDispatchRunner, type ActiveEntry } from "./dispatch-runner.ts";
import { createKanbanIo } from "./kanban-io.ts";
import { createLifecycleRunner } from "./lifecycle-runner.ts";
import type { CodeHostPort } from "./ports/code-host-port.ts";
import type { CodingAgentPort } from "./ports/coding-agent-port.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";
import type { StateRepositoryPort } from "./ports/state-repository-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";
import { createPrWatchRunner } from "./pr-watch-runner.ts";
import { createStartupRecovery } from "./startup-recovery.ts";

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

/**
 * dispatch / PR 監視 / ライフサイクル / 起動リカバリの各 runner をコンポーズする薄い facade。
 * 実際のロジックはすべて domain 層の純粋関数か、use-cases/*-runner.ts 側にある。
 * ここに残す責務は「共有状態（state / active Map / shutdown フラグ）と cfg アクセサの提供」
 * および「tick 1 サイクルの並び順」のみ。
 */
export function createOrchestrator(opts: OrchestratorOptions): OrchestratorHandle {
  const { dataHome, configManager, log, dryRun = false } = opts;
  const resultsDir = join(dataHome, "state", "results");
  const runsDir = join(dataHome, "logs", "runs");
  const stateRepo = opts.stateRepository;

  let state: StateFile = stateRepo.load();
  const active = new Map<string, ActiveEntry>();
  let shuttingDown = false;

  const cfg = (): Config => configManager.get();
  const kanban = (): KanbanPort => opts.kanbanPortFactory(cfg());
  const codeHost = (): CodeHostPort => opts.codeHostPortFactory(cfg());
  const workspace = (): WorkspacePort => opts.workspacePortFactory(cfg());
  const agent = (): CodingAgentPort => opts.codingAgentPortFactory(cfg());

  function persist(): void {
    try {
      stateRepo.save(state);
    } catch (err) {
      log.error("state_save_error", { msg: String(err) });
    }
  }

  const kanbanIo = createKanbanIo({
    kanban,
    log,
    getState: () => state,
    persist,
  });

  const dispatchRunner = createDispatchRunner({
    dataHome,
    resultsDir,
    runsDir,
    cfg,
    kanban,
    codeHost,
    workspace,
    agent,
    kanbanIo,
    log,
    getState: () => state,
    persist,
    active,
    isShuttingDown: () => shuttingDown,
  });

  const lifecycleRunner = createLifecycleRunner({
    cfg,
    kanban,
    workspace,
    log,
    getState: () => state,
    persist,
    listActive: () => [...active.values()],
    releaseActive: (pageId) => {
      active.delete(pageId);
    },
  });

  const prWatchRunner = createPrWatchRunner({
    cfg,
    kanban,
    codeHost,
    kanbanIo,
    log,
    getState: () => state,
    persist,
    isActive: (pageId) => active.has(pageId),
    canStartRework: () => !shuttingDown && active.size < cfg().maxConcurrent,
    dispatchAutoRework: dispatchRunner.dispatchAutoRework,
  });

  const startupRecovery = createStartupRecovery({
    resultsDir,
    getState: () => state,
    persist,
    cfg,
    kanban,
    kanbanIo,
    log,
  });

  async function dryRunTick(): Promise<void> {
    try {
      const candidates = await kanban().queryCandidates();
      log.info("candidates", { msg: `${candidates.length} 件` });
      for (const t of candidates) {
        const decision = dispatchRunner.planEligibility(t);
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
      await lifecycleRunner.stopMovedOrDeletedRuns();
      await lifecycleRunner.terminalCleanup();
      await prWatchRunner.advancePrWatch();
      const candidates = await kanban().queryCandidates();
      const needsInfoAnswers = await dispatchRunner.resolveNeedsInfoAnswers(candidates);
      dispatchRunner.processTick(candidates, needsInfoAnswers);
    } catch (err) {
      log.warn("tracker_error", { msg: oneLine(String(err)) });
    }
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    await lifecycleRunner.shutdown();
  }

  return {
    tick,
    recoverOnStartup: startupRecovery.recoverOnStartup,
    shutdown,
    printStatus: () => printStatus(state, [...active.values()]),
    hasActive: () => active.size > 0,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
  };
}
