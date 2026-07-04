import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { judgeResult } from "../../domain/agent-result.ts";
import type { AgentResult } from "../../domain/agent-result.ts";
import type { Config } from "../../infrastructure/config.ts";
import { spawnAgent } from "../../infrastructure/process-runner.ts";
import type { AgentHandle } from "../../infrastructure/process-runner.ts";
import type {
  CodingAgentPort,
  RunAgentParams,
} from "../../use-cases/ports/coding-agent-port.ts";

/**
 * codex CLI の引数配列。
 * 通常起動: `codex exec [<extra args>] <prompt>`
 * resume:  `codex exec resume <session-id> [<extra args>] <prompt>`
 * 純粋関数なのでテストしやすい。
 */
export function buildCodexArgs(
  config: Config,
  sessionId: string | undefined,
  task: string,
): string[] {
  if (sessionId) {
    return ["exec", "resume", sessionId, ...config.agent.codex.args, task];
  }
  return ["exec", ...config.agent.codex.args, task];
}

function startAgent(params: RunAgentParams): AgentHandle {
  const { config, prompt, systemPrompt, cwd, logFile, resultFile, sessionId } = params;
  try {
    if (existsSync(resultFile)) rmSync(resultFile);
    mkdirSync(dirname(resultFile), { recursive: true });
  } catch {
    /* ignore */
  }
  const task = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const args = buildCodexArgs(config, sessionId, task);
  return spawnAgent(config.agent.codex.command, args, {
    cwd,
    logFile,
    timeoutMs: config.agent.timeoutMs,
  });
}

function evaluateResult(
  resultFile: string,
  exitCode: number | null,
  stdout: string,
): AgentResult {
  let resultFileText: string | null = null;
  try {
    if (existsSync(resultFile)) {
      resultFileText = readFileSync(resultFile, "utf8");
    }
  } catch {
    resultFileText = null;
  }
  return judgeResult({ resultFileText, exitCode, stdout, provider: "codex" });
}

/** codex CLI (`codex exec ...`) による CodingAgentPort 実装。 */
export function createCodexAgentAdapter(): CodingAgentPort {
  return { start: startAgent, evaluateResult };
}
