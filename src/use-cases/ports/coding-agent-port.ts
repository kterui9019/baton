import type { AgentResult } from "../../domain/agent-result.ts";
import type { Config } from "../../infrastructure/config.ts";
import type { AgentHandle } from "../../infrastructure/process-runner.ts";

export interface RunAgentParams {
  config: Config;
  prompt: string;
  /** `claude --append-system-prompt` として渡す追加システムプロンプト。未指定/空なら付与しない。 */
  systemPrompt?: string;
  cwd: string;
  logFile: string;
  resultFile: string;
}

/**
 * コーディングエージェント（Claude Code 等）の起動・結果判定を表す関数の集合。
 * evaluateResult は result_file の読み込みという I/O を伴うため domain には
 * 置かず、ここに Port として持つ（judgeResult という純粋関数への委譲のみ行う）。
 * 別のコーディングエージェントが異なる結果ファイル規約を持つ場合、
 * ここだけを差し替えれば良い。
 */
export type CodingAgentPort = {
  start: (params: RunAgentParams) => AgentHandle;
  evaluateResult: (
    resultFile: string,
    exitCode: number | null,
    stdout: string,
  ) => AgentResult;
};
