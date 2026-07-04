import { test, expect } from "bun:test";
import { emptyState, rearmPrWatch } from "../../src/domain/state.ts";
import type { StateFile } from "../../src/domain/state.ts";

test("emptyState: version 1 と空 pages", () => {
  expect(emptyState()).toEqual({ version: 1, pages: {} });
});

test("rearmPrWatch: ci_failure rework (keepCount) は autoReworkCount を維持しマーカーを引き継ぐ", () => {
  const prev = {
    prUrl: "https://github.com/o/r/pull/1",
    phase: "review" as const,
    autoReworkCount: 2,
    reworkedSha: "sha-old",
    handledReviewAt: "2026-01-01T00:00:00Z",
    awaitingHuman: true,
  };
  const next = rearmPrWatch(prev, "https://github.com/o/r/pull/1", true);
  expect(next.phase).toBe("ci");
  expect(next.autoReworkCount).toBe(2);
  expect(next.reworkedSha).toBe("sha-old");
  expect(next.handledReviewAt).toBe("2026-01-01T00:00:00Z");
  expect(next.awaitingHuman).toBeUndefined();
});

test("rearmPrWatch: human/review rework は autoReworkCount を 0 リセット", () => {
  const prev = {
    prUrl: "u",
    phase: "ci" as const,
    autoReworkCount: 2,
    reworkedSha: "sha-old",
    handledReviewAt: "2026-01-01T00:00:00Z",
  };
  const next = rearmPrWatch(prev, "u", false);
  expect(next.autoReworkCount).toBe(0);
  expect(next.reworkedSha).toBe("sha-old");
  expect(next.handledReviewAt).toBe("2026-01-01T00:00:00Z");
});

test("rearmPrWatch: 前回状態なしは新規アーム", () => {
  const next = rearmPrWatch(undefined, "u", true);
  expect(next).toEqual({
    prUrl: "u",
    phase: "ci",
    autoReworkCount: 0,
    reworkedSha: undefined,
    handledReviewAt: undefined,
  });
});
