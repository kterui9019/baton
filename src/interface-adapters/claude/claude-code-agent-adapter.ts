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
 * claude CLI の引数配列。
 * 通常起動: `claude -p --verbose --output-format stream-json [--append-system-prompt ...] [<extra args>]`
 * resume:  sessionId 指定時は `--resume <session-id>` を追加してセッションを引き継ぐ。
 * 純粋関数なのでテストしやすい。
 */
export function buildClaudeArgs(
  config: Config,
  sessionId: string | undefined,
  systemPrompt: string | undefined,
): string[] {
  return [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    ...(sessionId ? ["--resume", sessionId] : []),
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ...config.agent.claude.args,
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
  const args = buildClaudeArgs(config, sessionId, systemPrompt);
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
