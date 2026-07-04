import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { judgeResult } from "../../domain/agent-result.ts";
import type { AgentResult } from "../../domain/agent-result.ts";
import { spawnAgent } from "../../infrastructure/process-runner.ts";
import type { AgentHandle } from "../../infrastructure/process-runner.ts";
import type {
  CodingAgentPort,
  RunAgentParams,
} from "../../use-cases/ports/coding-agent-port.ts";

function startAgent(params: RunAgentParams): AgentHandle {
  const { config, prompt, systemPrompt, cwd, logFile, resultFile } = params;
  try {
    if (existsSync(resultFile)) rmSync(resultFile);
    mkdirSync(dirname(resultFile), { recursive: true });
  } catch {
    /* ignore */
  }
  const task = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const args = [...config.agent.takt.args, "--task", task];
  return spawnAgent(config.agent.takt.command, args, {
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
  return judgeResult({ resultFileText, exitCode, stdout });
}

/** takt CLI (`takt --pipeline --task ...`) による CodingAgentPort 実装。 */
export function createTaktAgentAdapter(): CodingAgentPort {
  return { start: startAgent, evaluateResult };
}
