import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/infrastructure/config.ts";
import type { Config } from "../../src/infrastructure/config.ts";
import type { RunResult } from "../../src/infrastructure/process-runner.ts";
import { createGitWorktreeAdapter } from "../../src/interface-adapters/git/git-worktree-adapter.ts";
import type { WorkspaceInfo } from "../../src/domain/workspace.ts";

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
}

function makeRunner(opts: { shCode?: number } = {}) {
  const calls: Call[] = [];
  const run = async (
    cmd: string,
    args: string[],
    o?: { cwd?: string; timeoutMs?: number },
  ): Promise<RunResult> => {
    calls.push({ cmd, args, cwd: o?.cwd });
    if (cmd === "sh") {
      const code = opts.shCode ?? 0;
      return { code, signal: null, stdout: "", stderr: code === 0 ? "" : "boom", timedOut: false };
    }
    return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
  };
  return { run, calls };
}

function setupCfg(copy?: string[], commands?: string[]): Config {
  return {
    ...DEFAULT_CONFIG,
    repoConfig: {
      "some-repo": {
        localDirPath: "/tmp/some-repo",
        setup: { copy, commands },
      },
    },
  };
}

function makeWs(srcFiles: Record<string, string>): {
  ws: WorkspaceInfo;
  repoDir: string;
  wtPath: string;
} {
  const base = mkdtempSync(join(tmpdir(), "nsym-ws-"));
  const repoDir = join(base, "repo");
  const wtPath = join(base, "wt");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(wtPath, { recursive: true });
  for (const [rel, content] of Object.entries(srcFiles)) {
    const p = join(repoDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const ws: WorkspaceInfo = { path: wtPath, branch: "feature/x", baseBranch: "main", repoDir, reused: false };
  return { ws, repoDir, wtPath };
}

test("setupWorktree: copy 列挙のファイルを worktree へコピー（ネストパス含む）", async () => {
  const { ws, wtPath } = makeWs({ ".env": "ROOT=1", "apps/backend/.env": "BACKEND=1" });
  const { run } = makeRunner();
  const adapter = createGitWorktreeAdapter(setupCfg([".env", "apps/backend/.env"]), "/proj", run);
  await adapter.setupWorktree(ws, "some-repo");
  expect(readFileSync(join(wtPath, ".env"), "utf8")).toBe("ROOT=1");
  expect(readFileSync(join(wtPath, "apps/backend/.env"), "utf8")).toBe("BACKEND=1");
});

test("setupWorktree: copy でディレクトリを再帰コピー（.claude 等）", async () => {
  const { ws, wtPath } = makeWs({ ".claude/settings.json": "{}", ".claude/agents/x.md": "hi" });
  const { run } = makeRunner();
  const adapter = createGitWorktreeAdapter(setupCfg([".claude"]), "/proj", run);
  await adapter.setupWorktree(ws, "some-repo");
  expect(readFileSync(join(wtPath, ".claude/settings.json"), "utf8")).toBe("{}");
  expect(readFileSync(join(wtPath, ".claude/agents/x.md"), "utf8")).toBe("hi");
});

test("setupWorktree: copy 未指定なら何もコピーしない", async () => {
  const { ws, wtPath } = makeWs({ ".env": "X" });
  const { run, calls } = makeRunner();
  const adapter = createGitWorktreeAdapter(DEFAULT_CONFIG, "/proj", run);
  await adapter.setupWorktree(ws, "some-repo");
  expect(existsSync(join(wtPath, ".env"))).toBe(false);
  expect(calls.length).toBe(0);
});

test("setupWorktree: 存在しない copy パスは throw せず続行", async () => {
  const { ws } = makeWs({});
  const { run } = makeRunner();
  const adapter = createGitWorktreeAdapter(setupCfg([".env", ".claude"]), "/proj", run);
  await expect(adapter.setupWorktree(ws, "some-repo")).resolves.toBeUndefined();
});

test("setupWorktree: commands を worktree を cwd に sh -c 実行", async () => {
  const { ws, wtPath } = makeWs({});
  const { run, calls } = makeRunner({ shCode: 0 });
  const adapter = createGitWorktreeAdapter(setupCfg(undefined, ["bun install"]), "/proj", run);
  await adapter.setupWorktree(ws, "some-repo");
  const sh = calls.find((c) => c.cmd === "sh");
  expect(sh?.args).toEqual(["-c", "bun install"]);
  expect(sh?.cwd).toBe(wtPath);
});

test("setupWorktree: commands 非ゼロ終了は throw", async () => {
  const { ws } = makeWs({});
  const { run } = makeRunner({ shCode: 1 });
  const adapter = createGitWorktreeAdapter(setupCfg(undefined, ["bun install"]), "/proj", run);
  await expect(adapter.setupWorktree(ws, "some-repo")).rejects.toThrow(/セットアップコマンド失敗/);
});

test("setupWorktree: reused worktree では commands をスキップ", async () => {
  const { ws } = makeWs({});
  const reused = { ...ws, reused: true };
  const { run, calls } = makeRunner({ shCode: 0 });
  const adapter = createGitWorktreeAdapter(setupCfg(undefined, ["bun install"]), "/proj", run);
  await adapter.setupWorktree(reused, "some-repo");
  expect(calls.some((c) => c.cmd === "sh")).toBe(false);
});
