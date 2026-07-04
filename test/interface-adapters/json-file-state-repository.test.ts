import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState } from "../../src/domain/state.ts";
import type { StateFile } from "../../src/domain/state.ts";
import { createJsonFileStateRepository } from "../../src/interface-adapters/persistence/json-file-state-repository.ts";

test("load: 未存在なら空 state", () => {
  const p = join(mkdtempSync(join(tmpdir(), "nsym-")), "state.json");
  expect(createJsonFileStateRepository(p).load()).toEqual(emptyState());
});

test("save → load ラウンドトリップ (atomic)", () => {
  const p = join(mkdtempSync(join(tmpdir(), "nsym-")), "state.json");
  const repo = createJsonFileStateRepository(p);
  const s: StateFile = {
    version: 1,
    pages: {
      p1: { status: "done", attempt: 1, prUrl: "u", updatedAt: "t" },
    },
  };
  repo.save(s);
  const loaded = repo.load();
  expect(loaded.pages.p1?.status).toBe("done");
  expect(loaded.pages.p1?.prUrl).toBe("u");
});

test("save → load: needs_info 状態のラウンドトリップ", () => {
  const p = join(mkdtempSync(join(tmpdir(), "nsym-")), "state.json");
  const repo = createJsonFileStateRepository(p);
  const s: StateFile = {
    version: 1,
    pages: {
      p1: {
        status: "needs_info",
        attempt: 1,
        branch: "feature/x",
        workspace: "/ws/x",
        prUrl: "https://github.com/o/r/pull/3",
        questionAskedAt: "2026-07-02T10:30:00.000Z",
        question: "A案とB案どちらにしますか",
        updatedAt: "t",
      },
    },
  };
  repo.save(s);
  const loaded = repo.load();
  expect(loaded.pages.p1?.status).toBe("needs_info");
  expect(loaded.pages.p1?.status === "needs_info" && loaded.pages.p1.questionAskedAt).toBe(
    "2026-07-02T10:30:00.000Z",
  );
  expect(loaded.pages.p1?.status === "needs_info" && loaded.pages.p1.question).toBe(
    "A案とB案どちらにしますか",
  );
  expect(loaded.pages.p1?.prUrl).toBe("https://github.com/o/r/pull/3");
});
