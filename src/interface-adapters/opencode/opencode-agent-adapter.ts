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
 * opencode CLI (`opencode run [--session <id>] <extra args> <prompt>`) 用の
 * 引数配列を組み立てる。純粋関数なのでテストしやすい。
 */
export function buildOpencodeArgs(
  config: Config,
  sessionId: string | undefined,
  task: string,
): string[] {
  return [
    "run",
    ...(sessionId ? ["--session", sessionId] : []),
    ...config.agent.opencode.args,
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
  const args = buildOpencodeArgs(config, sessionId, task);
  return spawnAgent(config.agent.opencode.command, args, {
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
  return judgeResult({ resultFileText, exitCode, stdout, provider: "opencode" });
}

/** opencode CLI (`opencode run ...`) による CodingAgentPort 実装。 */
export function createOpencodeAgentAdapter(): CodingAgentPort {
  return { start: startAgent, evaluateResult };
}
