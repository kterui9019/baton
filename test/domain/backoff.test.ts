import { test, expect } from "bun:test";
import { computeBackoff } from "../../src/domain/backoff.ts";

test("computeBackoff: 指数バックオフ + 上限クランプ", () => {
  expect(computeBackoff(1)).toBe(10_000);
  expect(computeBackoff(2)).toBe(20_000);
  expect(computeBackoff(3)).toBe(40_000);
  expect(computeBackoff(10)).toBe(300_000);
});
