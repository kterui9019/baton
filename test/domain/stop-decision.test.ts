import { expect, test } from "bun:test";
import { classifyRunningEntry } from "../../src/domain/stop-decision.ts";
import type { RunningEntrySnapshot } from "../../src/domain/stop-decision.ts";
import type { KanbanPageSnapshot, Ticket } from "../../src/domain/ticket.ts";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  pageId: "p1",
  url: "https://notion.so/p1",
  title: "task",
  lane: "In Progress",
  repo: "repoX",
  condition: null,
  lastEditedTime: "2026-07-01T00:00:00.000Z",
  createdTime: "2026-07-01T00:00:00.000Z",
  ...over,
});

const snap = (over: Partial<KanbanPageSnapshot> = {}): RunningEntrySnapshot => ({
  type: "snapshot",
  value: { ticket: ticket(), isArchived: false, isDeleted: false, ...over },
});

const triggerLanes = ["In Progress"];

test("not_found → kill_gone(not_found)", () => {
  const r = classifyRunningEntry({
    snapshot: { type: "not_found" },
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "kill_gone", reason: "not_found" });
});

test("fetch_error → そのまま fetch_error を伝搬", () => {
  const r = classifyRunningEntry({
    snapshot: { type: "fetch_error", message: "ETIMEDOUT" },
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "fetch_error", message: "ETIMEDOUT" });
});

test("archived → kill_gone(archived_or_deleted)", () => {
  const r = classifyRunningEntry({
    snapshot: snap({ isArchived: true }),
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "kill_gone", reason: "archived_or_deleted" });
});

test("deleted → kill_gone(archived_or_deleted)", () => {
  const r = classifyRunningEntry({
    snapshot: snap({ isDeleted: true }),
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "kill_gone", reason: "archived_or_deleted" });
});

test("レーンが trigger 外に動いた + dispatchedByUs=false → kill_moved", () => {
  const r = classifyRunningEntry({
    snapshot: snap({ ticket: ticket({ lane: "Done" }) }),
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "kill_moved", lane: "Done" });
});

test("レーンが trigger 外に動いた + dispatchedByUs=true → keep（自分で動かしたので race を無視）", () => {
  const r = classifyRunningEntry({
    snapshot: snap({ ticket: ticket({ lane: "Done" }) }),
    triggerLanes,
    dispatchedByUs: true,
  });
  expect(r).toEqual({ type: "keep" });
});

test("レーンが null（不明）+ dispatchedByUs=false → kill_moved(lane=null)", () => {
  const r = classifyRunningEntry({
    snapshot: snap({ ticket: ticket({ lane: null }) }),
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "kill_moved", lane: null });
});

test("trigger レーン内なら keep", () => {
  const r = classifyRunningEntry({
    snapshot: snap(),
    triggerLanes,
    dispatchedByUs: false,
  });
  expect(r).toEqual({ type: "keep" });
});
