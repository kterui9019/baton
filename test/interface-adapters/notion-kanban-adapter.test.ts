import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/infrastructure/config.ts";
import type { CommandRunner, RunResult } from "../../src/infrastructure/process-runner.ts";
import {
  buildCandidateFilter,
  compactProps,
  createNotionKanbanAdapter,
  linkProp,
  parseComments,
  parseTicket,
  plainText,
  richTextProp,
  statusProp,
} from "../../src/interface-adapters/notion/notion-kanban-adapter.ts";
import { KanbanPageNotFoundError } from "../../src/domain/errors.ts";
import type { Config } from "../../src/infrastructure/config.ts";

/** DEFAULT_CONFIG の kanban.notion 部分だけ上書きした Config を組み立てる。 */
function withNotion(overrides: Partial<Config["kanban"]["notion"]>): Config {
  return {
    ...DEFAULT_CONFIG,
    kanban: { ...DEFAULT_CONFIG.kanban, notion: { ...DEFAULT_CONFIG.kanban.notion, ...overrides } },
  };
}

const pageFixture = {
  id: "38b76d6c-08eb-802f-9dda-c7f4ec790b5e",
  url: "https://app.notion.com/p/xxx-38b76d6c08eb802f9ddac7f4ec790b5e",
  created_time: "2026-06-26T14:31:00.000Z",
  last_edited_time: "2026-06-29T02:23:00.000Z",
  is_archived: false,
  in_trash: false,
  properties: {
    Title: {
      type: "title",
      title: [
        { plain_text: "sample-app の " },
        { plain_text: ".github を削除する" },
      ],
    },
    Status: { type: "status", status: { name: "In Progress" } },
    Repo: { type: "select", select: { name: "sample-app" } },
    Condition: { type: "select", select: { name: "Local" } },
  },
};

test("plainText: plain_text を連結", () => {
  expect(plainText([{ plain_text: "a" }, { plain_text: "b" }])).toBe("ab");
  expect(plainText([])).toBe("");
  expect(plainText(null)).toBe("");
});

test("parseTicket: ページ JSON → Ticket", () => {
  const t = parseTicket(pageFixture, DEFAULT_CONFIG);
  expect(t.pageId).toBe("38b76d6c-08eb-802f-9dda-c7f4ec790b5e");
  expect(t.title).toBe("sample-app の .github を削除する");
  expect(t.lane).toBe("In Progress");
  expect(t.repo).toBe("sample-app");
  expect(t.condition).toBe("Local");
  expect(t.lastEditedTime).toBe("2026-06-29T02:23:00.000Z");
  expect(t.createdTime).toBe("2026-06-26T14:31:00.000Z");
  expect(t.url).toContain("38b76d6c");
});

test("parseTicket: 未設定プロパティは null / 空", () => {
  const t = parseTicket({ id: "p1", properties: { Title: { title: [] } } }, DEFAULT_CONFIG);
  expect(t.lane).toBeNull();
  expect(t.repo).toBeNull();
  expect(t.condition).toBeNull();
  expect(t.title).toBe("");
});

test("parseTicket: config 化されたプロパティ名で読み取る", () => {
  const cfg = withNotion({ conditionProperty: "実行条件" });
  const page = {
    ...pageFixture,
    properties: {
      ...pageFixture.properties,
      実行条件: { type: "select", select: { name: "Cloud" } },
    },
  };
  const t = parseTicket(page, cfg);
  expect(t.condition).toBe("Cloud");
});

test("compactProps: 空キーと undefined 値のエントリを除外", () => {
  const props = compactProps([
    ["PR", linkProp("https://u")],
    ["", richTextProp("skip")],
    ["Activity", richTextProp("done")],
    ["Status", undefined],
  ]);
  expect(Object.keys(props)).toEqual(["PR", "Activity"]);
  expect(props["PR"]).toEqual(linkProp("https://u"));
});

test("compactProps: 全部除外されたら空オブジェクト", () => {
  expect(compactProps([["", 1], ["x", undefined]])).toEqual({});
  expect(compactProps([])).toEqual({});
});

test("buildCandidateFilter: and/or 構造", () => {
  const filter = buildCandidateFilter(DEFAULT_CONFIG) as {
    and: [unknown, { or: unknown[] }];
  };
  expect(filter.and).toBeTruthy();
  expect(filter.and[0]).toEqual({ property: "Condition", select: { equals: "Local" } });
  expect(filter.and[1].or).toEqual([{ property: "Status", status: { equals: "In Progress" } }]);
});

test("buildCandidateFilter: 複数 triggerLanes で or 展開", () => {
  const filter = buildCandidateFilter({
    ...DEFAULT_CONFIG,
    kanban: { ...DEFAULT_CONFIG.kanban, triggerLanes: ["In Progress", "TODO"] },
  }) as { and: [unknown, { or: unknown[] }] };
  expect(filter.and[1].or.length).toBe(2);
  expect(filter.and[1].or[1]).toEqual({ property: "Status", status: { equals: "TODO" } });
});

test("プロパティビルダー", () => {
  expect(richTextProp("x")).toEqual({ rich_text: [{ text: { content: "x" } }] });
  expect(linkProp("https://u")).toEqual({
    rich_text: [{ text: { content: "https://u", link: { url: "https://u" } } }],
  });
  expect(statusProp("Human Review")).toEqual({ status: { name: "Human Review" } });
});

test("parseComments: /v1/comments レスポンスを CommentInfo[] へ", () => {
  const json = {
    results: [
      {
        created_time: "2026-07-02T12:34:00.000Z",
        created_by: { object: "user", id: "user-human" },
        rich_text: [{ plain_text: "エラー処理" }, { plain_text: "が抜けている" }],
      },
      {
        created_time: "2026-07-02T11:00:00.000Z",
        created_by: { object: "user", id: "bot-1" },
        rich_text: [{ plain_text: "PR を作成しました。" }],
      },
    ],
    has_more: false,
  };
  expect(parseComments(json)).toEqual([
    { createdTime: "2026-07-02T12:34:00.000Z", authorId: "user-human", text: "エラー処理が抜けている" },
    { createdTime: "2026-07-02T11:00:00.000Z", authorId: "bot-1", text: "PR を作成しました。" },
  ]);
});

test("parseComments: 不正 JSON は空配列", () => {
  expect(parseComments(null)).toEqual([]);
  expect(parseComments({})).toEqual([]);
  expect(parseComments({ results: "x" })).toEqual([]);
});

// ---- createNotionKanbanAdapter（runner モック） ----

const okResult = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const ngResult = (stderr: string): RunResult => ({ code: 1, signal: null, stdout: "", stderr, timedOut: false });

function mockRunner(respond: (args: string[]) => RunResult): {
  run: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = async (_cmd, args) => {
    calls.push(args);
    return respond(args);
  };
  return { run, calls };
}

test("getPage: KanbanPageSnapshot へ正規化（isArchived/isDeleted 含む）", async () => {
  const { run } = mockRunner(() => okResult(JSON.stringify(pageFixture)));
  const adapter = createNotionKanbanAdapter(DEFAULT_CONFIG, run);
  const snapshot = await adapter.getPage(pageFixture.id);
  expect(snapshot.ticket.title).toBe("sample-app の .github を削除する");
  expect(snapshot.isArchived).toBe(false);
  expect(snapshot.isDeleted).toBe(false);
});

test("getPage: not_found エラーは KanbanPageNotFoundError", async () => {
  const { run } = mockRunner(() => ngResult("Notion API error: object_not_found (404)"));
  const adapter = createNotionKanbanAdapter(DEFAULT_CONFIG, run);
  await expect(adapter.getPage("missing")).rejects.toBeInstanceOf(KanbanPageNotFoundError);
});

test("updateTicket: TicketUpdate を単一 PATCH の Notion properties へマッピング", async () => {
  const { run, calls } = mockRunner(() => okResult("{}"));
  const adapter = createNotionKanbanAdapter(DEFAULT_CONFIG, run);
  await adapter.updateTicket("page-1", { prUrl: "https://github.com/o/r/pull/1", activity: "done" });
  const patch = calls.find((c) => c.includes("PATCH"));
  expect(patch).toBeDefined();
  const body = JSON.parse(patch![patch!.indexOf("-d") + 1]!);
  expect(body.properties["PR"]).toEqual(linkProp("https://github.com/o/r/pull/1"));
  expect(body.properties["Activity"]).toEqual(richTextProp("done"));
  expect(body.properties["Status"]).toBeUndefined();
});

test("updateTicket: 未指定フィールドは PATCH に含めない。全未指定なら PATCH 自体を発行しない", async () => {
  const { run, calls } = mockRunner(() => okResult("{}"));
  const adapter = createNotionKanbanAdapter(DEFAULT_CONFIG, run);
  await adapter.updateTicket("page-1", {});
  expect(calls.some((c) => c.includes("PATCH"))).toBe(false);
});
