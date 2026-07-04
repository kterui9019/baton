import { expect, test } from "bun:test";
import { decideCleanup, isCleanupCandidate } from "../../src/domain/cleanup-decision.ts";
import type { PageState } from "../../src/domain/state.ts";
import type { KanbanPageSnapshot, Ticket } from "../../src/domain/ticket.ts";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  pageId: "p1",
  url: "https://notion.so/p1",
  title: "task",
  lane: "Merged",
  repo: "repoX",
  condition: null,
  lastEditedTime: "2026-07-01T00:00:00.000Z",
  createdTime: "2026-07-01T00:00:00.000Z",
  ...over,
});

const snap = (over: Partial<KanbanPageSnapshot> = {}): KanbanPageSnapshot => ({
  ticket: ticket(),
  isArchived: false,
  isDeleted: false,
  ...over,
});

const ps = (over: Partial<PageState> = {}): PageState =>
  ({
    status: "done",
    attempt: 1,
    workspace: "/ws/p1",
    repoDir: "/repos/repoX",
    updatedAt: "t",
    ...over,
  }) as PageState;

const repoLookup = (repo: string) =>
  repo === "repoX" ? "/repos/repoX" : undefined;

const terminalLanes = ["Merged", "Archived"];

test("isCleanupCandidate: active な entry は候補外", () => {
  expect(isCleanupCandidate(ps(), true)).toBe(false);
});

test("isCleanupCandidate: running/retry_queued 等は候補外", () => {
  expect(isCleanupCandidate(ps({ status: "running" } as PageState), false)).toBe(false);
});

test("isCleanupCandidate: done/failed/needs_info は候補", () => {
  expect(isCleanupCandidate(ps({ status: "done" } as PageState), false)).toBe(true);
  expect(isCleanupCandidate(ps({ status: "failed" } as PageState), false)).toBe(true);
  expect(
    isCleanupCandidate(
      ps({ status: "needs_info", questionAskedAt: "t", question: "?" } as PageState),
      false,
    ),
  ).toBe(true);
});

test("snapshot が null（fetch 失敗）→ skip", () => {
  expect(
    decideCleanup({ ps: ps(), snapshot: null, terminalLanes, repoLocalDirPath: repoLookup }),
  ).toEqual({ type: "skip" });
});

test("lane が terminal に無い → skip", () => {
  expect(
    decideCleanup({
      ps: ps(),
      snapshot: snap({ ticket: ticket({ lane: "In Progress" }) }),
      terminalLanes,
      repoLocalDirPath: repoLookup,
    }),
  ).toEqual({ type: "skip" });
});

test("lane=null → skip", () => {
  expect(
    decideCleanup({
      ps: ps(),
      snapshot: snap({ ticket: ticket({ lane: null }) }),
      terminalLanes,
      repoLocalDirPath: repoLookup,
    }),
  ).toEqual({ type: "skip" });
});

test("terminal 到達 + workspace なし → state だけ削除", () => {
  expect(
    decideCleanup({
      ps: ps({ workspace: undefined, repoDir: undefined }),
      snapshot: snap(),
      terminalLanes,
      repoLocalDirPath: repoLookup,
    }),
  ).toEqual({ type: "delete_state", lane: "Merged" });
});

test("terminal 到達 + workspace あり + repoDir が state に残っている → worktree 削除も指示", () => {
  expect(
    decideCleanup({
      ps: ps(),
      snapshot: snap(),
      terminalLanes,
      repoLocalDirPath: repoLookup,
    }),
  ).toEqual({
    type: "delete_state",
    lane: "Merged",
    worktree: { repoDir: "/repos/repoX", path: "/ws/p1" },
  });
});

test("state に repoDir がなくても snapshot.ticket.repo から解決", () => {
  expect(
    decideCleanup({
      ps: ps({ repoDir: undefined }),
      snapshot: snap(),
      terminalLanes,
      repoLocalDirPath: repoLookup,
    }),
  ).toEqual({
    type: "delete_state",
    lane: "Merged",
    worktree: { repoDir: "/repos/repoX", path: "/ws/p1" },
  });
});

test("repoDir を解決できない場合は state 削除だけ（worktree は諦める）", () => {
  expect(
    decideCleanup({
      ps: ps({ repoDir: undefined }),
      snapshot: snap({ ticket: ticket({ repo: "unknownRepo" }) }),
      terminalLanes,
      repoLocalDirPath: repoLookup,
    }),
  ).toEqual({ type: "delete_state", lane: "Merged" });
});
