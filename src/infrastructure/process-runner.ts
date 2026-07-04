import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** タイムアウト (ms)。0 / 未指定なら無制限。 */
  timeoutMs?: number;
  /** stdin に流し込む文字列。 */
  input?: string;
  /** SIGTERM 後 SIGKILL までの猶予 (ms)。デフォルト 5000。 */
  killGraceMs?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * プロセス実行の注入ポイント。各 interface-adapters（notion/gh/git）が
 * 共通で使うシグネチャで、以前は notion.ts / gh.ts に重複定義されていたものを
 * ここへ一本化した。
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** cmd/args の配列渡し（shell 非経由）で共通の spawn 表現を作る。 */
function spawnChild(
  cmd: string,
  args: string[],
  opts: RunOptions,
): ChildProcess {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
}

/** SIGTERM → 猶予後 SIGKILL の段階的停止。 */
function escalateKill(child: ChildProcess, graceMs: number): () => void {
  let killed = false;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    if (!killed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, graceMs);
  timer.unref?.();
  return () => {
    killed = true;
    clearTimeout(timer);
  };
}

/**
 * コマンドを実行し stdout/stderr を全キャプチャして返す短命実行版。
 * shell を経由しない。timeout・stdin 注入対応。非ゼロ終了でも reject せず結果を返す。
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnChild(cmd, args, opts);
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let cancelKill: (() => void) | undefined;

    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        cancelKill = escalateKill(child, opts.killGraceMs ?? 5000);
      }, opts.timeoutMs);
      timer.unref?.();
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cancelKill?.();
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cancelKill?.();
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    });

    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {
        /* EPIPE 等は無視 */
      });
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export interface SpawnAgentOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** stdin に流し込むプロンプト等。 */
  input?: string;
  /** stdout/stderr を追記ストリームするログファイルパス。 */
  logFile: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface AgentHandle {
  pid: number | undefined;
  /** プロセス終了時に解決。非ゼロ終了でも reject しない。 */
  done: Promise<RunResult>;
  /** 外部からの停止（reconcile/shutdown 用）。SIGTERM → 猶予後 SIGKILL。 */
  terminate(graceMs?: number): void;
}

/**
 * 長時間実行エージェント (claude 等) 用。stdout/stderr をログファイルへ
 * ストリーム追記しつつ stdout を判定用にキャプチャする。
 */
export function spawnAgent(
  cmd: string,
  args: string[],
  opts: SpawnAgentOptions,
): AgentHandle {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const logStream = createWriteStream(opts.logFile, { flags: "a" });

  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let timedOut = false;
  let cancelKill: (() => void) | undefined;

  child.stdout?.on("data", (d: Buffer) => {
    const s = d.toString("utf8");
    stdoutChunks.push(s);
    logStream.write(s);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString("utf8");
    stderrChunks.push(s);
    logStream.write(s);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      cancelKill = escalateKill(child, opts.killGraceMs ?? 5000);
    }, opts.timeoutMs);
    timer.unref?.();
  }

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      cancelKill?.();
      logStream.end();
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      cancelKill?.();
      logStream.end();
      resolve({
        code,
        signal,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        timedOut,
      });
    });
  });

  if (opts.input !== undefined) {
    child.stdin?.on("error", () => {
      /* EPIPE 等は無視 */
    });
    child.stdin?.end(opts.input);
  } else {
    child.stdin?.end();
  }

  return {
    pid: child.pid,
    done,
    terminate(graceMs = 5000) {
      if (child.exitCode === null && child.signalCode === null) {
        cancelKill = escalateKill(child, graceMs);
      }
    },
  };
}
