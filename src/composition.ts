import { join } from "node:path";
import { match } from "ts-pattern";
import { createAgentAdapter } from "./interface-adapters/agent/cli-agent-adapter.ts";
import { createGitWorktreeAdapter } from "./interface-adapters/git/git-worktree-adapter.ts";
import { createGitHubCodeHostAdapter } from "./interface-adapters/github/github-code-host-adapter.ts";
import { createGitHubKanbanAdapter } from "./interface-adapters/github/github-kanban-adapter.ts";
import { createNotionKanbanAdapter } from "./interface-adapters/notion/notion-kanban-adapter.ts";
import { createJsonFileStateRepository } from "./interface-adapters/persistence/json-file-state-repository.ts";
import type { Config, ConfigManager } from "./infrastructure/config.ts";
import type { Logger } from "./infrastructure/logger.ts";
import { runCommand } from "./infrastructure/process-runner.ts";
import type { CommandRunner } from "./infrastructure/process-runner.ts";
import { createOrchestrator } from "./use-cases/orchestrator.ts";
import type { OrchestratorHandle } from "./use-cases/orchestrator.ts";

export interface BuildOrchestratorOptions {
  /** ユーザーデータ（state/logs/workspaces/prompts）の基点。resolveDataHome() の値。 */
  dataHome: string;
  configManager: ConfigManager;
  log: Logger;
  dryRun?: boolean;
  /** 省略時は本物のプロセス実行 (runCommand)。テストではスタブを注入する。 */
  runner?: CommandRunner;
}

/** Notion/Claude Code/GitHub/git worktree の各 Port アダプタを組み立てて Orchestrator を構築する。 */
export function buildOrchestrator(opts: BuildOrchestratorOptions): OrchestratorHandle {
  const run = opts.runner ?? runCommand;
  return createOrchestrator({
    dataHome: opts.dataHome,
    configManager: opts.configManager,
    log: opts.log,
    dryRun: opts.dryRun,
    kanbanPortFactory: (cfg: Config) =>
      match(cfg.kanban.provider)
        .with("github", () => createGitHubKanbanAdapter(cfg, run))
        .with("notion", () => createNotionKanbanAdapter(cfg, run))
        .exhaustive(),
    codeHostPortFactory: (cfg: Config) =>
      createGitHubCodeHostAdapter({ ghCommand: cfg.ghCommand }, run),
    workspacePortFactory: (cfg: Config) =>
      createGitWorktreeAdapter(cfg, opts.dataHome, run, opts.log),
    codingAgentPortFactory: (cfg: Config) => createAgentAdapter(cfg.agent.provider),
    stateRepository: createJsonFileStateRepository(join(opts.dataHome, "state", "state.json")),
  });
}
