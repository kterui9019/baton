import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestrator } from "../../src/composition.ts";
import { createConfigManager } from "../../src/infrastructure/config.ts";
import type { RunResult } from "../../src/infrastructure/process-runner.ts";
import { createLogger } from "../../src/infrastructure/logger.ts";
import type { OrchestratorHandle } from "../../src/use-cases/orchestrator.ts";
import type { PageState, StateFile } from "../../src/domain/state.ts";

interface Call {
  cmd: string;
  args: string[];
}

const ok = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const ng = (stderr = "mock fail"): RunResult => ({ code: 1, signal: null, stdout: "", stderr, timedOut: false });

type Responder = (args: string[]) => RunResult | undefined;

/**
 * runner を cmd/args で分岐させ、ntn / gh / git を出し分けるモック付き Orchestrator を作る。
 */
function setup(opts: {
  pages: Record<string, PageState>;
  gh?: Responder;
  ntn?: Responder;
  git?: Responder;
  config?: Record<string, unknown>;
  results?: Record<string, unknown>;
}) {
  const root = mkdtempSync(join(tmpdir(), "nsym-prwatch-"));
  mkdirSync(join(root, "state", "results"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });

  const state: StateFile = { version: 1, pages: opts.pages };
  writeFileSync(join(root, "state", "state.json"), JSON.stringify(state));
  for (const [pageId, json] of Object.entries(opts.results ?? {})) {
    writeFileSync(join(root, "state", "results", `${pageId}.json`), JSON.stringify(json));
  }

  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      prPollIntervalMs: 0,
      repoConfig: {
        repoX: {
          localDirPath: join(root, "repos", "repoX"),
        },
      },
      ...(opts.config ?? {}),
    }),
  );

  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push({ cmd, args });
    if (cmd === "gh") return opts.gh?.(args) ?? ok("{}");
    if (cmd === "git") return opts.git?.(args) ?? ng("git mock");
    if (cmd === "sh") return ok("");
    const r = opts.ntn?.(args);
    if (r) return r;
    if (args[0] === "datasources") return ok(JSON.stringify({ results: [] }));
    return ok("{}");
  };

  const orch = buildOrchestrator({
    dataHome: root,
    configManager: createConfigManager(configPath),
    log: createLogger(join(root, "logs")),
    runner,
  });
  return { orch, calls };
}

function patchBodies(calls: Call[]): string[] {
  return calls
    .filter((c) => c.cmd !== "gh" && c.args.includes("PATCH"))
    .map((c) => c.args[c.args.indexOf("-d") + 1] ?? "");
}

function commentBodies(calls: Call[]): string[] {
  return calls
    .filter((c) => c.cmd !== "gh" && c.args.includes("/v1/comments") && c.args.includes("POST"))
    .map((c) => c.args[c.args.indexOf("-d") + 1] ?? "");
}

function pageJson(pageId: string, lane: string, repo = "repoX") {
  return {
    id: pageId,
    url: `https://notion.so/${pageId}`,
    last_edited_time: "2026-07-02T00:00:00.000Z",
    created_time: "2026-07-01T00:00:00.000Z",
    properties: {
      Title: { title: [{ plain_text: "テストタスク" }] },
      Status: { status: { name: lane } },
      Repo: { select: { name: repo } },
      Condition: { select: { name: "Local" } },
    },
  };
}

function ghSnapshot(o: {
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
  checks?: unknown[];
  mergedAt?: string;
}): string {
  return JSON.stringify({
    state: o.state,
    mergedAt: o.mergedAt ?? null,
    statusCheckRollup: o.checks ?? [],
    headRefOid: o.headSha,
  });
}

const passCheck = (name: string) => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  detailsUrl: "https://github.com/o/r/actions/runs/1/job/1",
});
const failCheck = (name: string, runId = "123") => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion: "FAILURE",
  detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/9`,
});

const SNAPSHOT_FIELDS = "state,mergedAt,statusCheckRollup,headRefOid";

function ghResponder(o: { snapshot: string; runLog?: string }): Responder {
  return (args) => {
    if (args[0] === "pr" && args[1] === "view" && args[4] === SNAPSHOT_FIELDS) return ok(o.snapshot);
    if (args[0] === "run" && args[1] === "view") return ok(o.runLog ?? "FAIL: mock log");
    return undefined;
  };
}

const PR_URL = "https://github.com/o/r/pull/10";

/** dispatch (void async) が終わるまで status を待つ。 */
async function waitForStatus(orch: OrchestratorHandle, pageId: string, status: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (orch.getState().pages[pageId]?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- 1. PR あり success → prWatch アーム・レーン維持 ----

test("PRあり success: prWatch アーム（phase ci, count 0）・レーン PATCH なし", async () => {
  const pageId = "page-pr-success";
  const { orch, calls } = setup({
    pages: {
      [pageId]: { status: "running", attempt: 1, branch: "feature/x", workspace: "/ws/x", repoDir: "/repo/x", updatedAt: "t" },
    },
    results: { [pageId]: { status: "success", pr_url: PR_URL, summary: "実装しました" } },
  });

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prUrl).toBe(PR_URL);
  expect(ps?.prWatch?.prUrl).toBe(PR_URL);
  expect(ps?.prWatch?.phase).toBe("ci");
  expect(ps?.prWatch?.autoReworkCount).toBe(0);
  expect(ps?.prWatch?.awaitingHuman).toBeUndefined();

  const patches = patchBodies(calls);
  expect(patches.length).toBeGreaterThan(0);
  for (const body of patches) {
    expect(body).not.toContain('"Status"');
    expect(body).not.toContain("Human Review");
  }
  expect(patches.some((b) => b.includes("CI 待ち"))).toBe(true);
});

test("PRなし success: 従来どおり doneLane 移動（prWatch なし）", async () => {
  const pageId = "page-nopr-success";
  const { orch, calls } = setup({
    pages: { [pageId]: { status: "running", attempt: 1, updatedAt: "t" } },
    results: { [pageId]: { status: "success", summary: "調査のみ" } },
  });

  await orch.recoverOnStartup();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prWatch).toBeUndefined();
  const patches = patchBodies(calls);
  expect(patches.some((b) => b.includes("Human Review"))).toBe(true);
});

// ---- 2. advancePrWatch: CI 全 green ----
// advancePrWatch は use-cases/orchestrator.ts の内部関数のため、公開 API の tick() 経由で検証する
// （tick は stopMovedOrDeletedRuns → terminalCleanup → advancePrWatch → queryCandidates → dispatchLoop の順に走るが、
//  候補は常に空を返すモックなので advancePrWatch 以降の副作用は生じない）。

test("advancePrWatch: CI 全 green → doneLane PATCH + phase=review", async () => {
  const pageId = "page-ci-green";
  const { orch, calls } = setup({
    pages: {
      [pageId]: {
        status: "done",
        attempt: 1,
        prUrl: PR_URL,
        prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 0 },
        lastEditedTime: "2026-07-01T00:00:00.000Z",
        updatedAt: "t",
      },
    },
    gh: ghResponder({ snapshot: ghSnapshot({ state: "OPEN", headSha: "sha-green", checks: [passCheck("test"), passCheck("lint")] }) }),
    ntn: (args) => {
      if (args[0] === "api" && args[1]?.startsWith("/v1/pages/") && !args.includes("PATCH")) {
        return ok(JSON.stringify(pageJson(pageId, "In Progress")));
      }
      return undefined;
    },
  });

  await orch.tick();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prWatch?.phase).toBe("review");
  expect(ps?.prWatch?.headSha).toBe("sha-green");

  const patches = patchBodies(calls);
  expect(patches.some((b) => b.includes("Human Review"))).toBe(true);
  expect(patches.some((b) => b.includes("CI グリーン"))).toBe(true);
});

test("advancePrWatch: CI green だが人間がレーンを動かしていたらレーンは上書きしない（phase は遷移）", async () => {
  const pageId = "page-ci-green-moved";
  const { orch, calls } = setup({
    pages: {
      [pageId]: { status: "done", attempt: 1, prUrl: PR_URL, prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 0 }, updatedAt: "t" },
    },
    gh: ghResponder({ snapshot: ghSnapshot({ state: "OPEN", headSha: "sha-green", checks: [passCheck("test")] }) }),
    ntn: (args) => {
      if (args[0] === "api" && args[1]?.startsWith("/v1/pages/") && !args.includes("PATCH")) {
        return ok(JSON.stringify(pageJson(pageId, "Blocked")));
      }
      return undefined;
    },
  });

  await orch.tick();

  expect(orch.getState().pages[pageId]?.prWatch?.phase).toBe("review");
  const patches = patchBodies(calls);
  for (const body of patches) {
    expect(body).not.toContain("Human Review");
  }
});

// ---- 3. advancePrWatch: merged ----

test("advancePrWatch: merged → mergedLane PATCH + prWatch 削除 + コメント", async () => {
  const pageId = "page-merged";
  const { orch, calls } = setup({
    pages: {
      [pageId]: { status: "done", attempt: 1, prUrl: PR_URL, prWatch: { prUrl: PR_URL, phase: "review", autoReworkCount: 1 }, updatedAt: "t" },
    },
    gh: ghResponder({
      snapshot: ghSnapshot({ state: "MERGED", mergedAt: "2026-07-02T01:00:00Z", headSha: "sha-m" }),
    }),
  });

  await orch.tick();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prWatch).toBeUndefined();
  const patches = patchBodies(calls);
  expect(patches.some((b) => b.includes("In Delivery"))).toBe(true);
  expect(patches.some((b) => b.includes("マージ検知"))).toBe(true);
  const comments = commentBodies(calls);
  expect(comments.some((b) => b.includes("マージ") && b.includes(PR_URL))).toBe(true);
});

test("advancePrWatch: closed(unmerged) → 通知のみ・レーン維持・prWatch 削除", async () => {
  const pageId = "page-closed";
  const { orch, calls } = setup({
    pages: {
      [pageId]: { status: "done", attempt: 1, prUrl: PR_URL, prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 0 }, updatedAt: "t" },
    },
    gh: ghResponder({ snapshot: ghSnapshot({ state: "CLOSED", headSha: "sha-c" }) }),
  });

  await orch.tick();

  expect(orch.getState().pages[pageId]?.prWatch).toBeUndefined();
  const patches = patchBodies(calls);
  expect(patches.some((b) => b.includes("クローズ"))).toBe(true);
  for (const body of patches) {
    expect(body).not.toContain('"Status"');
  }
  expect(commentBodies(calls).some((b) => b.includes("クローズ"))).toBe(true);
});

// ---- 4. advancePrWatch: CI failed → マーカー persist + dispatchAutoRework ----

test("advancePrWatch: CI failed → reworkedSha/count を先に persist し dispatchAutoRework が claim まで到達", async () => {
  const pageId = "page-ci-fail";
  const { orch, calls } = setup({
    pages: {
      [pageId]: {
        status: "done",
        attempt: 1,
        prUrl: PR_URL,
        prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 0 },
        lastEditedTime: "2026-07-01T00:00:00.000Z",
        updatedAt: "t",
      },
    },
    gh: ghResponder({
      snapshot: ghSnapshot({ state: "OPEN", headSha: "sha-fail", checks: [failCheck("test", "123"), passCheck("lint")] }),
      runLog: "FAIL src/foo.test.ts",
    }),
    ntn: (args) => {
      if (args[0] === "api" && args[1]?.startsWith("/v1/pages/") && !args.includes("PATCH")) {
        return ok(JSON.stringify(pageJson(pageId, "In Progress")));
      }
      return undefined;
    },
    // git はデフォルトで失敗 → dispatch は worktree 作成で失敗し agent は起動しない
  });

  await orch.tick();

  const ps = orch.getState().pages[pageId];
  expect(ps?.prWatch?.reworkedSha).toBe("sha-fail");
  expect(ps?.prWatch?.autoReworkCount).toBe(1);
  expect(["running", "retry_queued"]).toContain(ps?.status ?? "");

  expect(calls.some((c) => c.cmd === "gh" && c.args[0] === "run" && c.args[1] === "view")).toBe(true);

  await waitForStatus(orch, pageId, "retry_queued");
  const after = orch.getState().pages[pageId];
  expect(after?.status).toBe("retry_queued");
  expect(after?.prWatch?.reworkedSha).toBe("sha-fail");
  expect(after?.prWatch?.autoReworkCount).toBe(1);
  expect(patchBodies(calls).some((b) => b.includes("やり直し開始"))).toBe(true);
});

test("advancePrWatch: 同一 SHA の CI 失敗（reworkedSha 一致）は再発火しない", async () => {
  const pageId = "page-same-sha";
  const { orch, calls } = setup({
    pages: {
      [pageId]: {
        status: "done",
        attempt: 1,
        prUrl: PR_URL,
        prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 1, reworkedSha: "sha-fail" },
        updatedAt: "t",
      },
    },
    gh: ghResponder({ snapshot: ghSnapshot({ state: "OPEN", headSha: "sha-fail", checks: [failCheck("test")] }) }),
  });

  await orch.tick();

  const ps = orch.getState().pages[pageId];
  expect(ps?.status).toBe("done");
  expect(ps?.prWatch?.autoReworkCount).toBe(1);
  expect(patchBodies(calls).length).toBe(0);
});

// ---- 5. ci_limit ----

test("advancePrWatch: count >= limit で awaitingHuman=true + 🆘 通知、2 周目は再通知しない", async () => {
  const pageId = "page-ci-limit";
  const { orch, calls } = setup({
    pages: {
      [pageId]: { status: "done", attempt: 1, prUrl: PR_URL, prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 3 }, updatedAt: "t" },
    },
    gh: ghResponder({ snapshot: ghSnapshot({ state: "OPEN", headSha: "sha-limit", checks: [failCheck("e2e")] }) }),
  });

  await orch.tick();

  const ps = orch.getState().pages[pageId];
  expect(ps?.prWatch?.awaitingHuman).toBe(true);
  expect(ps?.status).toBe("done");
  const sos = () => patchBodies(calls).filter((b) => b.includes("🆘"));
  expect(sos().length).toBe(1);
  expect(sos()[0]).toContain("上限 (3回)");
  const comments = commentBodies(calls);
  expect(comments.some((b) => b.includes("e2e"))).toBe(true);

  const ghCallsBefore = calls.filter((c) => c.cmd === "gh").length;
  await orch.tick();
  expect(calls.filter((c) => c.cmd === "gh").length).toBe(ghCallsBefore);
  expect(sos().length).toBe(1);
  expect(commentBodies(calls).length).toBe(comments.length);
});

// ---- スロット満杯時の持ち越し ----

test("advancePrWatch: maxConcurrent 満杯なら マーカーを進めず持ち越す", async () => {
  const pageId = "page-full";
  const { orch, calls } = setup({
    pages: {
      [pageId]: { status: "done", attempt: 1, prUrl: PR_URL, prWatch: { prUrl: PR_URL, phase: "ci", autoReworkCount: 0 }, updatedAt: "t" },
    },
    config: { maxConcurrent: 0 },
    gh: ghResponder({ snapshot: ghSnapshot({ state: "OPEN", headSha: "sha-busy", checks: [failCheck("test")] }) }),
  });

  await orch.tick();

  const ps = orch.getState().pages[pageId];
  expect(ps?.prWatch?.reworkedSha).toBeUndefined();
  expect(ps?.prWatch?.autoReworkCount).toBe(0);
  expect(ps?.status).toBe("done");
  expect(calls.some((c) => c.cmd === "gh" && c.args[0] === "run")).toBe(false);
  expect(patchBodies(calls).length).toBe(0);
});
