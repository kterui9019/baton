import { cpSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  isWithinRoot,
  mapRepoName,
  renderBranch,
  repoDirFor,
  worktreePathFor,
} from "../../domain/workspace.ts";
import type { WorkspaceInfo } from "../../domain/workspace.ts";
import { shortId, slugify } from "../../domain/workspace.ts";
import type { Config } from "../../infrastructure/config.ts";
import { runCommand } from "../../infrastructure/process-runner.ts";
import type { CommandRunner } from "../../infrastructure/process-runner.ts";
import type { Logger } from "../../infrastructure/logger.ts";
import type { WorkspacePort } from "../../use-cases/ports/workspace-port.ts";

/** git worktree による WorkspacePort 実装を組み立てる。 */
export function createGitWorktreeAdapter(
  config: Config,
  dataHome: string,
  run: CommandRunner = runCommand,
  log?: Logger,
): WorkspacePort {
  async function git(
    repoDir: string,
    args: string[],
    timeoutMs = 120_000,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const res = await run("git", ["-C", repoDir, ...args], { timeoutMs });
    return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
  }

  /** リポジトリディレクトリを解決し、無ければ autoClone。失敗で throw。 */
  async function ensureRepo(repo: string): Promise<string> {
    const dir = repoDirFor(config.repoRoot, config.repoMapping, repo);
    if (existsSync(join(dir, ".git")) || existsSync(dir)) {
      return dir;
    }
    if (!config.autoClone) {
      throw new Error(`リポジトリが存在せず autoClone 無効: ${dir}`);
    }
    const remote = `${config.gitRemotePrefix}${mapRepoName(
      config.repoMapping,
      repo,
    )}.git`;
    const res = await run("git", ["clone", remote, dir], {
      timeoutMs: 600_000,
    });
    if (res.code !== 0) {
      throw new Error(`git clone 失敗 (${remote}): ${res.stderr.trim()}`);
    }
    return dir;
  }

  /** デフォルトブランチ検出。symbolic-ref → remote show → main の順。 */
  async function detectDefaultBranch(repoDir: string): Promise<string> {
    const sym = await git(repoDir, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "--short",
    ]);
    if (sym.ok) {
      const name = sym.stdout.trim().replace(/^origin\//, "");
      if (name) return name;
    }
    const show = await git(repoDir, ["remote", "show", "origin"]);
    if (show.ok) {
      const m = show.stdout.match(/HEAD branch:\s*(\S+)/);
      if (m && m[1]) return m[1];
    }
    return "main";
  }

  /** ブランチ (ローカル or リモート) の存在確認。 */
  async function branchExists(repoDir: string, branch: string): Promise<boolean> {
    const local = await git(repoDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (local.ok) return true;
    const remote = await git(repoDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    return remote.ok;
  }

  /**
   * git worktree を作成（既存なら再利用）。ブランチ/パス規則と
   * 安全不変量（workspaces ルート配下）を強制する。
   */
  async function createWorktree(
    pageId: string,
    title: string,
    repo: string,
  ): Promise<WorkspaceInfo> {
    const repoDir = await ensureRepo(repo);
    const id = shortId(pageId);
    const slug = slugify(title);
    const branch = renderBranch(config.branchTemplate, id, slug);
    const path = worktreePathFor(dataHome, repo, id, slug);

    // 安全不変量: worktree パスは必ず workspaces ルート配下。
    const workspacesRoot = join(dataHome, "workspaces");
    if (!isWithinRoot(workspacesRoot, path)) {
      throw new Error(`worktree パスが workspaces 配下でない: ${path}`);
    }
    if (!isAbsolute(path)) {
      throw new Error(`worktree パスが絶対パスでない: ${path}`);
    }

    // 既存 worktree は再利用（清掃しない）。
    if (existsSync(path)) {
      const base = await detectDefaultBranch(repoDir);
      return { path, branch, baseBranch: base, repoDir, reused: true };
    }

    const fetch = await git(repoDir, ["fetch", "origin", "--prune"]);
    if (!fetch.ok) {
      throw new Error(`git fetch 失敗: ${fetch.stderr.trim()}`);
    }
    const base = await detectDefaultBranch(repoDir);

    const exists = await branchExists(repoDir, branch);
    const addArgs = exists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", path, "-b", branch, `origin/${base}`];
    const add = await git(repoDir, addArgs);
    if (!add.ok) {
      throw new Error(`git worktree add 失敗: ${add.stderr.trim()}`);
    }
    log?.info("workspace_ready", { page_id: pageId, msg: `${branch} @ ${path}` });
    return { path, branch, baseBranch: base, repoDir, reused: false };
  }

  /**
   * worktree 作成後の環境セットアップを行う。
   *   1. config.repoSetup[repo].copy に列挙されたパスを clone元 → worktree へコピー。
   *      ファイル・ディレクトリ両対応。コピー元が無い / IO 失敗は warn して続行。
   *   2. config.repoSetup[repo].commands を worktree を cwd に `sh -c` で順次実行。
   *      非ゼロ終了は throw。既存 worktree の再利用時 (ws.reused) は commands をスキップ。
   */
  async function setupWorktree(ws: WorkspaceInfo, repo: string): Promise<void> {
    const setup = config.repoSetup[repo] ?? {};

    for (const rel of setup.copy ?? []) {
      const src = join(ws.repoDir, rel);
      const dst = join(ws.path, rel);
      if (!isWithinRoot(ws.path, dst)) {
        log?.warn("setup_copy", { msg: `worktree 外へのコピーを拒否: ${rel}` });
        continue;
      }
      try {
        if (!existsSync(src)) {
          log?.warn("setup_copy", { msg: `コピー元が無い（スキップ）: ${rel}` });
          continue;
        }
        mkdirSync(join(dst, ".."), { recursive: true });
        cpSync(src, dst, { recursive: true });
        log?.info("setup_copy", { msg: `コピー: ${rel}` });
      } catch (err) {
        log?.warn("setup_copy", {
          msg: `コピー失敗（続行）: ${rel}: ${String(err)}`,
        });
      }
    }

    const commands = setup.commands ?? [];
    if (commands.length === 0) return;
    if (ws.reused) {
      log?.info("setup_cmd", {
        msg: `reused worktree のため commands をスキップ (${commands.length} 件)`,
      });
      return;
    }
    for (const cmd of commands) {
      log?.info("setup_cmd", { msg: `実行: ${cmd}` });
      const res = await run("sh", ["-c", cmd], {
        cwd: ws.path,
        timeoutMs: config.setupTimeoutMs,
      });
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout).trim().slice(0, 300);
        throw new Error(
          `セットアップコマンド失敗 (exit=${res.code}): ${cmd}: ${detail}`,
        );
      }
    }
  }

  /** worktree を削除（terminal cleanup 用）。安全確認付き。 */
  async function removeWorktree(repoDir: string, path: string): Promise<void> {
    const workspacesRoot = join(dataHome, "workspaces");
    if (!isWithinRoot(workspacesRoot, path)) {
      throw new Error(`削除拒否: workspaces 配下でないパス: ${path}`);
    }
    await git(repoDir, ["worktree", "remove", "--force", path]);
  }

  return { createWorktree, setupWorktree, removeWorktree };
}
