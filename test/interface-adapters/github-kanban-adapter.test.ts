import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/infrastructure/config.ts";
import type { Config } from "../../src/infrastructure/config.ts";
import type { CommandRunner, RunResult } from "../../src/infrastructure/process-runner.ts";
import {
  collectManagedLabels,
  createGitHubKanbanAdapter,
  extractLaneFromLabels,
  formatPageId,
  parseIssueComments,
  parseIssueListItem,
  parsePageId,
} from "../../src/interface-adapters/github/github-kanban-adapter.ts";

const okResult = (stdout: string): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
});

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

/** DEFAULT_CONFIG の kanban 部分を GitHub プロバイダに切り替える。 */
function withGithub(overrides: Partial<Config["kanban"]["github"]> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    kanban: {
      ...DEFAULT_CONFIG.kanban,
      provider: "github",
      github: {
        ...DEFAULT_CONFIG.kanban.github,
        owner: "acme",
        repos: ["baton"],
        ...overrides,
      },
    },
  };
}

const defaultManaged = collectManagedLabels(DEFAULT_CONFIG.kanban.github);

test("formatPageId / parsePageId は往復可能", () => {
  const id = formatPageId("acme", "baton", 42);
  expect(id).toBe("acme/baton#42");
  expect(parsePageId(id)).toEqual({ owner: "acme", repo: "baton", number: 42 });
});

test("parsePageId: 不正フォーマットは null", () => {
  expect(parsePageId("acme/baton")).toBeNull();
  expect(parsePageId("acme/baton#")).toBeNull();
  expect(parsePageId("acme#baton#42")).toBeNull();
});

test("extractLaneFromLabels: 管理対象ラベルの最初の一致を返す", () => {
  const managed = new Set(["In Progress", "Human Review", "Released", "Canceled"]);
  expect(
    extractLaneFromLabels(
      [{ name: "bug" }, { name: "In Progress" }, { name: "Human Review" }],
      managed,
    ),
  ).toBe("In Progress");
  expect(extractLaneFromLabels([{ name: "bug" }], managed)).toBeNull();
  expect(extractLaneFromLabels(undefined, managed)).toBeNull();
});

test("parseIssueListItem: 内部 Ticket へ変換", () => {
  const t = parseIssueListItem(
    "acme",
    "baton",
    {
      number: 7,
      title: "fix login flow",
      url: "https://github.com/acme/baton/issues/7",
      labels: [{ name: "In Progress" }, { name: "baton" }],
      updatedAt: "2026-07-04T00:00:00Z",
      createdAt: "2026-07-01T00:00:00Z",
      author: { login: "dev1" },
      state: "open",
    },
    defaultManaged,
  );
  expect(t).not.toBeNull();
  expect(t!.pageId).toBe("acme/baton#7");
  expect(t!.title).toBe("fix login flow");
  expect(t!.lane).toBe("In Progress");
  expect(t!.repo).toBe("baton");
  expect(t!.condition).toBeNull();
  expect(t!.url).toBe("https://github.com/acme/baton/issues/7");
  expect(t!.authorId).toBe("dev1");
});

test("parseIssueComments: gh api 出力配列を CommentInfo[] に変換", () => {
  const raw = [
    {
      user: { login: "alice" },
      body: "please rebase",
      created_at: "2026-07-04T01:00:00Z",
    },
    { user: { login: "bot" }, body: "🤖 auto-comment", created_at: "2026-07-04T02:00:00Z" },
  ];
  const parsed = parseIssueComments(raw);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toEqual({
    createdTime: "2026-07-04T01:00:00Z",
    authorId: "alice",
    text: "please rebase",
  });
});

test("queryCandidates: repos × triggerLabels の直積で gh issue list を呼ぶ", async () => {
  const cfg: Config = {
    ...withGithub({ conditionLabel: "baton", triggerLabels: ["In Progress", "Ready"] }),
  };
  // 各呼び出しごとに空配列を返す。
  const { run, calls } = mockRunner(() => okResult("[]"));
  const adapter = createGitHubKanbanAdapter(cfg, run);
  const tickets = await adapter.queryCandidates();
  expect(tickets).toEqual([]);
  // 1 repo × 2 label = 2 呼び出し
  expect(calls).toHaveLength(2);
  const firstCall = calls[0]!;
  expect(firstCall.slice(0, 4)).toEqual(["issue", "list", "--repo", "acme/baton"]);
  // --label が 2 個（trigger label + conditionLabel）
  const labelArgs = firstCall
    .map((a, i) => (a === "--label" ? firstCall[i + 1] : null))
    .filter((x): x is string => x !== null);
  expect(labelArgs).toContain("In Progress");
  expect(labelArgs).toContain("baton");
});

test("updateTicket({lane}): 既存の管理対象ラベルを外して新規追加する", async () => {
  const cfg = withGithub();
  const responses: RunResult[] = [
    // 1 回目: gh issue view --json labels
    okResult(JSON.stringify({ labels: [{ name: "In Progress" }, { name: "bug" }] })),
    // 2 回目: gh issue edit --remove-label ... --add-label ...
    okResult(""),
  ];
  let i = 0;
  const { run, calls } = mockRunner(() => responses[i++]!);
  const adapter = createGitHubKanbanAdapter(cfg, run);
  await adapter.updateTicket("acme/baton#7", { lane: "Human Review" });
  expect(calls).toHaveLength(2);
  const editCall = calls[1]!;
  expect(editCall.slice(0, 5)).toEqual([
    "issue",
    "edit",
    "7",
    "--repo",
    "acme/baton",
  ]);
  // 既存 In Progress を除去して Human Review を追加
  expect(editCall).toContain("--remove-label");
  expect(editCall).toContain("In Progress");
  expect(editCall).toContain("--add-label");
  expect(editCall).toContain("Human Review");
  // 非管理ラベル (bug) は触らない
  expect(editCall).not.toContain("bug");
});

test("updateTicket({prUrl}): PR リンクをコメントとして追記", async () => {
  const cfg = withGithub();
  const { run, calls } = mockRunner(() => okResult(""));
  const adapter = createGitHubKanbanAdapter(cfg, run);
  await adapter.updateTicket("acme/baton#7", {
    prUrl: "https://github.com/acme/baton/pull/42",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 5)).toEqual(["issue", "comment", "7", "--repo", "acme/baton"]);
  const body = calls[0]![calls[0]!.indexOf("--body") + 1];
  expect(body).toBe("🔗 PR: https://github.com/acme/baton/pull/42");
});

test("updateTicket({lane}): 目的のラベルがすでに付いていて他の管理ラベルがない場合は no-op", async () => {
  const cfg = withGithub();
  const responses: RunResult[] = [
    okResult(JSON.stringify({ labels: [{ name: "In Progress" }] })),
  ];
  let i = 0;
  const { run, calls } = mockRunner(() => responses[i++]!);
  const adapter = createGitHubKanbanAdapter(cfg, run);
  await adapter.updateTicket("acme/baton#7", { lane: "In Progress" });
  // view のみで edit は呼ばれない
  expect(calls).toHaveLength(1);
});

test("カスタムラベル名: triggerLabels/doneLabel をそのまま gh に渡す", async () => {
  const cfg = withGithub({
    triggerLabels: ["baton:wip"],
    doneLabel: "baton:review",
    terminalLabels: ["baton:done"],
  });
  const responses: RunResult[] = [
    okResult(JSON.stringify({ labels: [{ name: "baton:wip" }] })),
    okResult(""),
  ];
  let i = 0;
  const { run, calls } = mockRunner(() => responses[i++]!);
  const adapter = createGitHubKanbanAdapter(cfg, run);
  await adapter.updateTicket("acme/baton#7", { lane: "baton:review" });
  const editCall = calls[1]!;
  expect(editCall).toContain("baton:wip");
  expect(editCall).toContain("baton:review");
});