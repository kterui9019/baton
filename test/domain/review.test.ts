import { test, expect } from "bun:test";
import { decidePrWatchAction, summarizeChecks } from "../../src/domain/review.ts";
import type { PrCheck, PrSnapshot, PrWatchInput } from "../../src/domain/review.ts";

const okCheck: PrCheck = { name: "build", status: "success" };
const ngCheck: PrCheck = {
  name: "test",
  status: "failure",
  detailsUrl: "https://github.com/o/r/actions/runs/123/job/9",
};
const wipCheck: PrCheck = { name: "lint", status: "pending" };

test("summarizeChecks: 件数と failed 抽出", () => {
  const s = summarizeChecks([okCheck, ngCheck, wipCheck, ngCheck]);
  expect(s.pending).toBe(1);
  expect(s.success).toBe(1);
  expect(s.failure).toBe(2);
  expect(s.failed).toEqual([ngCheck, ngCheck]);
  expect(summarizeChecks([])).toEqual({
    pending: 0,
    success: 0,
    failure: 0,
    failed: [],
  });
});

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  headSha: "sha-1",
  checks: [],
  ...over,
});
const watch = (over: Partial<PrWatchInput> = {}): PrWatchInput => ({
  phase: "ci",
  autoReworkCount: 0,
  ...over,
});
const decide = (s: PrSnapshot, w: PrWatchInput, autoReworkLimit = 3) =>
  decidePrWatchAction({ snapshot: s, watch: w, autoReworkLimit });

test("decide: awaitingHuman → none（failure があっても防御）", () => {
  const a = decide(
    snap({ checks: [ngCheck] }),
    watch({ awaitingHuman: true, autoReworkCount: 3 }),
  );
  expect(a.type).toBe("none");
});

test("decide: CI failure → ci_rework（headSha / failedChecks 付き）", () => {
  const a = decide(
    snap({ headSha: "sha-x", checks: [okCheck, ngCheck, wipCheck] }),
    watch(),
  );
  expect(a).toEqual({ type: "ci_rework", headSha: "sha-x", failedChecks: [ngCheck] });
});

test("decide: 同一 reworkedSha の CI failure は none（対応済み）", () => {
  const a = decide(
    snap({ headSha: "sha-x", checks: [ngCheck] }),
    watch({ reworkedSha: "sha-x", autoReworkCount: 1 }),
  );
  expect(a.type).toBe("none");
});

test("decide: autoReworkCount が上限到達 → ci_limit", () => {
  const a = decide(
    snap({ checks: [ngCheck] }),
    watch({ autoReworkCount: 3, reworkedSha: "sha-old" }),
    3,
  );
  expect(a).toEqual({ type: "ci_limit", failedChecks: [ngCheck] });
});

test("decide: pending あり（failure なし）→ none（CI 実行中）", () => {
  const a = decide(snap({ checks: [okCheck, wipCheck] }), watch());
  expect(a.type).toBe("none");
});

test("decide: 全 green + phase ci → ci_green", () => {
  expect(decide(snap({ checks: [okCheck] }), watch({ phase: "ci" }))).toEqual({
    type: "ci_green",
  });
});

test("decide: 全 green + phase review → none", () => {
  const a = decide(snap({ checks: [okCheck] }), watch({ phase: "review" }));
  expect(a.type).toBe("none");
});

test("decide: checks 空（CI 未設定）+ phase ci → ci_green", () => {
  expect(decide(snap({ checks: [] }), watch({ phase: "ci" }))).toEqual({
    type: "ci_green",
  });
});
