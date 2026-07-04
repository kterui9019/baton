import { test, expect } from "bun:test";
import {
  createGitHubCodeHostAdapter,
  extractRunId,
  parsePrSnapshot,
  parseReviews,
  repoSlugFromPrUrl,
  truncateLog,
} from "../../src/interface-adapters/github/github-code-host-adapter.ts";
import type { PrCheck } from "../../src/domain/review.ts";
import type { CommandRunner, RunResult } from "../../src/infrastructure/process-runner.ts";

test("repoSlugFromPrUrl: 正常な PR URL をパース", () => {
  expect(
    repoSlugFromPrUrl("https://github.com/kterui9019/sample-app/pull/123"),
  ).toEqual({ owner: "kterui9019", repo: "sample-app", number: 123 });
  expect(
    repoSlugFromPrUrl("https://github.com/o/r/pull/7/files?diff=split"),
  ).toEqual({ owner: "o", repo: "r", number: 7 });
});

test("repoSlugFromPrUrl: 不正 URL は null", () => {
  expect(repoSlugFromPrUrl("https://github.com/o/r/issues/123")).toBeNull();
  expect(repoSlugFromPrUrl("http://github.com/o/r/pull/123")).toBeNull();
  expect(repoSlugFromPrUrl("https://github.com/o/r")).toBeNull();
  expect(repoSlugFromPrUrl("https://github.com/o/r/pull/abc")).toBeNull();
  expect(repoSlugFromPrUrl("")).toBeNull();
});

const snapshotFixture = {
  state: "OPEN",
  mergedAt: null,
  reviewDecision: "REVIEW_REQUIRED",
  headRefOid: "abc123def456",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/111/job/1",
    },
    {
      __typename: "CheckRun",
      name: "test",
      status: "IN_PROGRESS",
      conclusion: "",
      detailsUrl: "https://github.com/o/r/actions/runs/222/job/2",
    },
    {
      __typename: "StatusContext",
      context: "ci/circleci: lint",
      state: "FAILURE",
      targetUrl: "https://circleci.com/gh/o/r/333",
    },
  ],
};

test("parsePrSnapshot: CheckRun / StatusContext 混在を正規化", () => {
  const snap = parsePrSnapshot(snapshotFixture);
  expect(snap).not.toBeNull();
  expect(snap!.state).toBe("OPEN");
  expect(snap!.headSha).toBe("abc123def456");
  expect(snap!.reviewDecision).toBe("REVIEW_REQUIRED");
  expect(snap!.checks).toEqual([
    { name: "build", status: "success", detailsUrl: "https://github.com/o/r/actions/runs/111/job/1" },
    { name: "test", status: "pending", detailsUrl: "https://github.com/o/r/actions/runs/222/job/2" },
    { name: "ci/circleci: lint", status: "failure", detailsUrl: "https://circleci.com/gh/o/r/333" },
  ]);
});

test("parsePrSnapshot: CheckRun conclusion 全パターンの正規化", () => {
  const mk = (conclusion: string) => ({
    __typename: "CheckRun",
    name: conclusion,
    status: "COMPLETED",
    conclusion,
  });
  const snap = parsePrSnapshot({
    state: "OPEN",
    mergedAt: null,
    headRefOid: "sha",
    statusCheckRollup: [
      mk("SUCCESS"),
      mk("NEUTRAL"),
      mk("SKIPPED"),
      mk("FAILURE"),
      mk("CANCELLED"),
      mk("TIMED_OUT"),
      mk("ACTION_REQUIRED"),
      mk("STALE"),
      { __typename: "CheckRun", name: "queued", status: "QUEUED", conclusion: "" },
    ],
  });
  expect(snap!.checks.map((c) => c.status)).toEqual([
    "success", "success", "success", "failure", "failure", "failure", "failure", "pending", "pending",
  ]);
});

test("parsePrSnapshot: StatusContext state 全パターンの正規化", () => {
  const mk = (state: string) => ({ __typename: "StatusContext", context: state, state });
  const snap = parsePrSnapshot({
    state: "OPEN",
    mergedAt: null,
    headRefOid: "sha",
    statusCheckRollup: [mk("SUCCESS"), mk("FAILURE"), mk("ERROR"), mk("PENDING"), mk("EXPECTED")],
  });
  expect(snap!.checks.map((c) => c.status)).toEqual(["success", "failure", "failure", "pending", "pending"]);
});

test("parsePrSnapshot: mergedAt 非 null なら state を MERGED に上書き（防御）", () => {
  const snap = parsePrSnapshot({
    state: "OPEN",
    mergedAt: "2026-07-01T00:00:00Z",
    headRefOid: "sha",
    statusCheckRollup: null,
  });
  expect(snap!.state).toBe("MERGED");
});

test("parsePrSnapshot: statusCheckRollup null / 欠落は checks 空（CI 未設定）", () => {
  const base = { state: "OPEN", mergedAt: null, headRefOid: "sha" };
  expect(parsePrSnapshot({ ...base, statusCheckRollup: null })!.checks).toEqual([]);
  expect(parsePrSnapshot(base)!.checks).toEqual([]);
  expect(parsePrSnapshot({ ...base, statusCheckRollup: [] })!.checks).toEqual([]);
});

test("parsePrSnapshot: 不正入力は null", () => {
  expect(parsePrSnapshot(null)).toBeNull();
  expect(parsePrSnapshot("x")).toBeNull();
  expect(parsePrSnapshot({})).toBeNull();
  expect(parsePrSnapshot({ state: "UNKNOWN" })).toBeNull();
});

test("parseReviews: reviews 配列を ReviewInfo[] へ", () => {
  const json = {
    reviews: [
      { author: { login: "alice" }, state: "CHANGES_REQUESTED", body: "テストを追加してください", submittedAt: "2026-07-01T10:00:00Z" },
      { author: { login: "bob" }, state: "APPROVED", body: "", submittedAt: "2026-07-01T11:00:00Z" },
    ],
  };
  expect(parseReviews(json)).toEqual([
    { author: "alice", state: "CHANGES_REQUESTED", body: "テストを追加してください", submittedAt: "2026-07-01T10:00:00Z" },
    { author: "bob", state: "APPROVED", body: "", submittedAt: "2026-07-01T11:00:00Z" },
  ]);
});

test("parseReviews: 不正 JSON は空配列", () => {
  expect(parseReviews(null)).toEqual([]);
  expect(parseReviews({})).toEqual([]);
  expect(parseReviews({ reviews: "x" })).toEqual([]);
});

test("extractRunId: Actions URL から run ID を抽出", () => {
  expect(extractRunId("https://github.com/o/r/actions/runs/123456/job/789")).toBe("123456");
  expect(extractRunId("https://github.com/o/r/actions/runs/42")).toBe("42");
});

test("extractRunId: Actions 以外の URL / undefined は null", () => {
  expect(extractRunId("https://circleci.com/gh/o/r/333")).toBeNull();
  expect(extractRunId("https://github.com/o/r/pull/1")).toBeNull();
  expect(extractRunId(undefined)).toBeNull();
  expect(extractRunId("")).toBeNull();
});

test("truncateLog: maxChars 以下はそのまま", () => {
  expect(truncateLog("short", 100)).toBe("short");
  expect(truncateLog("", 10)).toBe("");
});

test("truncateLog: 超過時は末尾優先 + 先頭に省略マーカー", () => {
  const text = "A".repeat(50) + "TAIL";
  const out = truncateLog(text, 20);
  expect(out.length).toBeLessThanOrEqual(20);
  expect(out.startsWith("…(先頭省略)…\n")).toBe(true);
  expect(out.endsWith("TAIL")).toBe(true);
});

// ---- createGitHubCodeHostAdapter（runner モック） ----

const okResult = (stdout: string): RunResult => ({
  code: 0, signal: null, stdout, stderr: "", timedOut: false,
});
const ngResult = (stderr = "boom"): RunResult => ({
  code: 1, signal: null, stdout: "", stderr, timedOut: false,
});

function mockRunner(respond: (cmd: string, args: string[]) => RunResult): {
  run: CommandRunner;
  calls: { cmd: string; args: string[]; opts: unknown }[];
} {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return respond(cmd, args);
  };
  return { run, calls };
}

const PR_URL = "https://github.com/o/r/pull/12";
const ngCheck: PrCheck = {
  name: "test",
  status: "failure",
  detailsUrl: "https://github.com/o/r/actions/runs/123/job/9",
};

test("fetchPrSnapshot: gh pr view の引数と正常パース", async () => {
  const { run, calls } = mockRunner(() => okResult(JSON.stringify(snapshotFixture)));
  const gh = createGitHubCodeHostAdapter({ ghCommand: "gh" }, run);
  const snap = await gh.fetchPrSnapshot(PR_URL);
  expect(calls.length).toBe(1);
  expect(calls[0]!.cmd).toBe("gh");
  expect(calls[0]!.args).toEqual([
    "pr", "view", PR_URL, "--json", "state,mergedAt,reviewDecision,statusCheckRollup,headRefOid",
  ]);
  expect((calls[0]!.opts as { timeoutMs?: number }).timeoutMs).toBe(30_000);
  expect(snap!.headSha).toBe("abc123def456");
  expect(snap!.checks.length).toBe(3);
});

test("fetchPrSnapshot: 非ゼロ終了 / 不正 JSON は null（throw しない）", async () => {
  const fail = createGitHubCodeHostAdapter({ ghCommand: "gh" }, mockRunner(() => ngResult()).run);
  expect(await fail.fetchPrSnapshot(PR_URL)).toBeNull();

  const broken = createGitHubCodeHostAdapter(
    { ghCommand: "gh" },
    mockRunner(() => okResult("not json")).run,
  );
  expect(await broken.fetchPrSnapshot(PR_URL)).toBeNull();
});

test("fetchReviews: gh pr view --json reviews を呼びパース", async () => {
  const { run, calls } = mockRunner(() =>
    okResult(JSON.stringify({
      reviews: [{ author: { login: "alice" }, state: "CHANGES_REQUESTED", body: "直してください", submittedAt: "2026-07-01T10:00:00Z" }],
    })),
  );
  const gh = createGitHubCodeHostAdapter({ ghCommand: "gh" }, run);
  const reviews = await gh.fetchReviews(PR_URL);
  expect(calls[0]!.args).toEqual(["pr", "view", PR_URL, "--json", "reviews"]);
  expect(reviews.length).toBe(1);
  expect(reviews[0]!.author).toBe("alice");
});

test("fetchInlineComments: gh api を呼び ReviewInfo へ、失敗時は []", async () => {
  const { run, calls } = mockRunner(() =>
    okResult(JSON.stringify([{ user: { login: "carol" }, body: "ここ typo", created_at: "2026-07-02T01:00:00Z" }])),
  );
  const gh = createGitHubCodeHostAdapter({ ghCommand: "gh" }, run);
  const comments = await gh.fetchInlineComments(PR_URL);
  expect(calls[0]!.args).toEqual(["api", "repos/o/r/pulls/12/comments"]);
  expect(comments).toEqual([{ author: "carol", state: "INLINE", body: "ここ typo", submittedAt: "2026-07-02T01:00:00Z" }]);

  const fail = createGitHubCodeHostAdapter({ ghCommand: "gh" }, mockRunner(() => ngResult()).run);
  expect(await fail.fetchInlineComments(PR_URL)).toEqual([]);

  const noop = mockRunner(() => okResult("[]"));
  const gh2 = createGitHubCodeHostAdapter({ ghCommand: "gh" }, noop.run);
  expect(await gh2.fetchInlineComments("https://example.com/x")).toEqual([]);
  expect(noop.calls.length).toBe(0);
});

test("fetchFailedCheckLogs: run ID あり + gh 成功 → ログセクション", async () => {
  const { run, calls } = mockRunner((_cmd, args) =>
    args[0] === "run" ? okResult("FAIL: expected 1 got 2") : ngResult(),
  );
  const gh = createGitHubCodeHostAdapter({ ghCommand: "gh" }, run);
  const log = await gh.fetchFailedCheckLogs(PR_URL, [ngCheck]);
  expect(calls[0]!.args).toEqual(["run", "view", "123", "--log-failed", "-R", "o/r"]);
  expect(log).toContain("### test");
  expect(log).toContain("FAIL: expected 1 got 2");
});

test("fetchFailedCheckLogs: run ID なし（外部 CI）→ gh を呼ばず URL 行", async () => {
  const { run, calls } = mockRunner(() => okResult(""));
  const gh = createGitHubCodeHostAdapter({ ghCommand: "gh" }, run);
  const external: PrCheck = {
    name: "ci/circleci: lint",
    status: "failure",
    detailsUrl: "https://circleci.com/gh/o/r/333",
  };
  const log = await gh.fetchFailedCheckLogs(PR_URL, [external]);
  expect(calls.length).toBe(0);
  expect(log).toBe("ci/circleci: lint: https://circleci.com/gh/o/r/333");
});

test("fetchFailedCheckLogs: gh 非ゼロ → フォールバック行に劣化（throw しない）", async () => {
  const { run } = mockRunner(() => ngResult("gh error"));
  const gh = createGitHubCodeHostAdapter({ ghCommand: "gh" }, run);
  const log = await gh.fetchFailedCheckLogs(PR_URL, [ngCheck]);
  expect(log).toBe(`test: ${ngCheck.detailsUrl}`);
});
