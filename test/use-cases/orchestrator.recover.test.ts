import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestrator } from "../../src/composition.ts";
import { createConfigManager } from "../../src/infrastructure/config.ts";
import type { RunResult } from "../../src/infrastructure/process-runner.ts";
import { createLogger } from "../../src/infrastructure/logger.ts";
import type { PageState } from "../../src/domain/state.ts";
import type { StateFile } from "../../src/domain/state.ts";

interface Call {
  cmd: string;
  args: string[];
}

/**
 * 一時 projectRoot に state.json / result_file を仕込んだ Orchestrator を作る。
 * runner はすべての外部コマンド (ntn/git) をモックして成功を返し、呼び出しを記録する。
 */
function setup(pageId: string, page: PageState, resultJson?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "nsym-orch-"));
  mkdirSync(join(root, "state", "results"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });

  const state: StateFile = { version: 1, pages: { [pageId]: page } };
  writeFileSync(join(root, "state", "state.json"), JSON.stringify(state));
  if (resultJson !== undefined) {
    writeFileSync(join(root, "state", "results", `${pageId}.json`), JSON.stringify(resultJson));
  }

  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({}));

  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push({ cmd, args });
    return { code: 0, signal: null, stdout: "{}", stderr: "", timedOut: false };
  };

  const orch = buildOrchestrator({
    dataHome: root,
    configManager: createConfigManager(configPath),
    log: createLogger(join(root, "logs")),
    runner,
  });
  return { orch, calls };
}

test("recoverOnStartup: 完遂済み(result=success/PR)は done 確定し反映", async () => {
  const pageId = "page-done";
  const prUrl = "https://github.com/o/r/pull/99";
  const { orch, calls } = setup(
    pageId,
    { status: "running", attempt: 1, branch: "feature/x", workspace: "/ws/x", repoDir: "/repo/x", updatedAt: "t" },
    { status: "success", pr_url: prUrl, summary: "実装しました" },
  );

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prUrl).toBe(prUrl);
  const patched = calls.some((c) => c.args.includes("PATCH"));
  expect(patched).toBe(true);
  expect(ps?.status === "retry_queued" ? ps.retryAt : undefined).toBeUndefined();
});

test("recoverOnStartup: 完遂済み(result=success/PR無し)も done 確定する（PR不要タスク）", async () => {
  const pageId = "page-done-nopr";
  const { orch, calls } = setup(
    pageId,
    { status: "running", attempt: 1, branch: "feature/x", workspace: "/ws/x", repoDir: "/repo/x", updatedAt: "t" },
    { status: "success", summary: "調査のみで完了、コード変更なし" },
  );

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prUrl).toBeUndefined();
  const patched = calls.some((c) => c.args.includes("PATCH"));
  expect(patched).toBe(true);
});

test("recoverOnStartup: result 無しの running は retry_queued(retryAt=0) に降格・反映なし", async () => {
  const pageId = "page-orphan";
  const { orch, calls } = setup(pageId, { status: "running", attempt: 2, updatedAt: "t" });

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("retry_queued");
  expect(ps?.status === "retry_queued" && ps.retryAt).toBe(0);
  expect(ps?.attempt).toBe(2);
  expect(calls.length).toBe(0);
});

test("recoverOnStartup: result=needs_info は needs_info 確定・質問コメント投稿", async () => {
  const pageId = "page-needs-info";
  const question = "A案とB案どちらにしますか";
  const { orch, calls } = setup(
    pageId,
    {
      status: "running",
      attempt: 1,
      branch: "feature/x",
      workspace: "/ws/x",
      repoDir: "/repo/x",
      prUrl: "https://github.com/o/r/pull/7",
      updatedAt: "t",
    },
    { status: "needs_info", question },
  );

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("needs_info");
  expect(ps?.status === "needs_info" && ps.question).toBe(question);
  expect(ps?.status === "needs_info" && ps.questionAskedAt).toBeString();
  expect(ps?.branch).toBe("feature/x");
  expect(ps?.prUrl).toBe("https://github.com/o/r/pull/7");
  const commentPost = calls.find((c) => c.args.includes("/v1/comments") && c.args.includes("POST"));
  expect(commentPost).toBeDefined();
  const commentBody = commentPost!.args[commentPost!.args.indexOf("-d") + 1] ?? "";
  expect(commentBody).toContain(question);
  expect(commentBody).toContain("確認が必要です");
});

test("recoverOnStartup: needs_info だが question 欠落は failure 扱いで retry_queued", async () => {
  const pageId = "page-needs-info-noq";
  const { orch } = setup(pageId, { status: "running", attempt: 1, updatedAt: "t" }, { status: "needs_info" });

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("retry_queued");
  expect(ps?.status === "retry_queued" && ps.retryAt).toBe(0);
});

test("recoverOnStartup: result=failure の running は再試行キューへ（done にしない）", async () => {
  const pageId = "page-fail";
  const { orch } = setup(pageId, { status: "running", attempt: 1, updatedAt: "t" }, { status: "failure", summary: "テスト不能" });

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("retry_queued");
  expect(ps?.status === "retry_queued" && ps.retryAt).toBe(0);
});
