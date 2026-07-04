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
 * grok CLI (`grok [--session-id <id>] <extra args> -p <prompt>`) の引数配列。
 * `-p <prompt>` は headless モード。純粋関数。
 */
export function buildGrokArgs(
  config: Config,
  sessionId: string | undefined,
  task: string,
): string[] {
  return [
    ...(sessionId ? ["--session-id", sessionId] : []),
    ...config.agent.grok.args,
    "-p",
    task,
  ];
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
  const args = buildGrokArgs(config, sessionId, task);
  return spawnAgent(config.agent.grok.command, args, {
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
  return judgeResult({ resultFileText, exitCode, stdout, provider: "grok" });
}

/** grok CLI (`grok -p ...`) による CodingAgentPort 実装。 */
export function createGrokAgentAdapter(): CodingAgentPort {
  return { start: startAgent, evaluateResult };
}
