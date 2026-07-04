import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProvider, AgentResult } from "../../domain/agent-result.ts";
import { judgeResult } from "../../domain/agent-result.ts";
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

/**
 * codex CLI の引数配列。
 * 通常起動: `codex exec [<extra args>] <task>`
 * resume:  `codex exec resume <session-id> [<extra args>] <task>`
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

/** grok CLI (`grok [--session-id <id>] <extra args> -p <task>`) の引数配列。`-p` は headless モード。 */
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

/** opencode CLI (`opencode run [--session <id>] <extra args> <task>`) の引数配列。 */
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

/** takt CLI (`takt <extra args> --task <task>`) の引数配列。takt は sessionId を使わない。 */
export function buildTaktArgs(config: Config, task: string): string[] {
  return [...config.agent.takt.args, "--task", task];
}

/** systemPrompt を task 引数に畳み込む CLI（claude 以外）用の入力文字列。 */
function foldTask(prompt: string, systemPrompt: string | undefined): string {
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

/**
 * 各コーディングエージェント CLI の差分。共通の start/evaluateResult に注入する。
 * - command: 実行コマンド名
 * - build: 引数配列と（claude のみ）stdin へ流す input を返す
 * - provider: judgeResult の session_id 抽出・エラー表記の切替。省略時は claude 相当。
 */
interface AgentSpec {
  command: (c: Config) => string;
  build: (p: RunAgentParams) => { args: string[]; input?: string };
  provider?: AgentProvider;
}

const SPECS: Record<AgentProvider, AgentSpec> = {
  claude: {
    command: (c) => c.agent.claude.command,
    build: (p) => ({
      args: buildClaudeArgs(p.config, p.sessionId, p.systemPrompt),
      input: p.prompt,
    }),
  },
  takt: {
    command: (c) => c.agent.takt.command,
    build: (p) => ({ args: buildTaktArgs(p.config, foldTask(p.prompt, p.systemPrompt)) }),
  },
  opencode: {
    command: (c) => c.agent.opencode.command,
    build: (p) => ({
      args: buildOpencodeArgs(p.config, p.sessionId, foldTask(p.prompt, p.systemPrompt)),
    }),
    provider: "opencode",
  },
  grok: {
    command: (c) => c.agent.grok.command,
    build: (p) => ({
      args: buildGrokArgs(p.config, p.sessionId, foldTask(p.prompt, p.systemPrompt)),
    }),
    provider: "grok",
  },
  codex: {
    command: (c) => c.agent.codex.command,
    build: (p) => ({
      args: buildCodexArgs(p.config, p.sessionId, foldTask(p.prompt, p.systemPrompt)),
    }),
    provider: "codex",
  },
};

function startAgent(spec: AgentSpec, params: RunAgentParams): AgentHandle {
  try {
    if (existsSync(params.resultFile)) rmSync(params.resultFile);
    mkdirSync(dirname(params.resultFile), { recursive: true });
  } catch {
    /* ignore */
  }
  const { args, input } = spec.build(params);
  return spawnAgent(spec.command(params.config), args, {
    cwd: params.cwd,
    input,
    logFile: params.logFile,
    timeoutMs: params.config.agent.timeoutMs,
  });
}

function evaluateResult(
  provider: AgentProvider | undefined,
  resultFile: string,
  exitCode: number | null,
  stdout: string,
): AgentResult {
  let resultFileText: string | null = null;
  try {
    if (existsSync(resultFile)) resultFileText = readFileSync(resultFile, "utf8");
  } catch {
    resultFileText = null;
  }
  return judgeResult({ resultFileText, exitCode, stdout, provider });
}

/**
 * コーディングエージェント CLI（claude/takt/opencode/grok/codex）による CodingAgentPort 実装。
 * provider ごとの差分は SPECS に閉じ、起動・結果判定の骨格は共通。
 */
export function createAgentAdapter(provider: AgentProvider): CodingAgentPort {
  const spec = SPECS[provider];
  return {
    start: (params) => startAgent(spec, params),
    evaluateResult: (resultFile, exitCode, stdout) =>
      evaluateResult(spec.provider, resultFile, exitCode, stdout),
  };
}
