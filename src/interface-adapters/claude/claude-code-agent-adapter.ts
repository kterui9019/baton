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
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ...config.agent.claude.args,
  ];
  return spawnAgent(config.agent.claude.command, args, {
    cwd,
    input: prompt,
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

/** Claude Code CLI (`claude -p ...`) による CodingAgentPort 実装。 */
export function createClaudeCodeAgentAdapter(): CodingAgentPort {
  return { start: startAgent, evaluateResult };
}
