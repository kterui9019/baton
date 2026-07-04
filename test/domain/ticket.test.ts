import { test, expect } from "bun:test";
import { sortTickets } from "../../src/domain/ticket.ts";
import type { Ticket } from "../../src/domain/ticket.ts";

test("sortTickets: created_time 昇順 → page_id 辞書順", () => {
  const mk = (id: string, ct: string): Ticket => ({
    pageId: id,
    url: "",
    title: "",
    lane: null,
    repo: null,
    condition: null,
    lastEditedTime: "",
    createdTime: ct,
    authorId: "",
  });
  const sorted = sortTickets([
    mk("b", "2026-01-02"),
    mk("a", "2026-01-01"),
    mk("c", "2026-01-01"),
  ]);
  expect(sorted.map((t) => t.pageId)).toEqual(["a", "c", "b"]);
});
