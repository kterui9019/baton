import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/infrastructure/config.ts";
import type { Config } from "../../src/infrastructure/config.ts";
import type { CommandRunner, RunResult } from "../../src/infrastructure/process-runner.ts";
import {
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

test("extractLaneFromLabels: プレフィックス一致の最初の lane を返す", () => {
  expect(
    extractLaneFromLabels(
      [{ name: "bug" }, { name: "status:In Progress" }, { name: "status:Done" }],
      "status:",
    ),
  ).toBe("In Progress");
  expect(extractLaneFromLabels([{ name: "bug" }], "status:")).toBeNull();
  expect(extractLaneFromLabels(undefined, "status:")).toBeNull();
});

test("parseIssueListItem: 内部 Ticket へ変換", () => {
  const t = parseIssueListItem(
    "acme",
    "baton",
    {
      number: 7,
      title: "fix login flow",
      url: "https://github.com/acme/baton/issues/7",
      labels: [{ name: "status:In Progress" }, { name: "baton" }],
      updatedAt: "2026-07-04T00:00:00Z",
      createdAt: "2026-07-01T00:00:00Z",
      author: { login: "dev1" },
      state: "open",
    },
    "status:",
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

test("queryCandidates: repos × triggerLanes の直積で gh issue list を呼ぶ", async () => {
  const cfg: Config = {
    ...withGithub({ conditionLabel: "baton" }),
    kanban: {
      ...withGithub().kanban,
      triggerLanes: ["In Progress", "Ready"],
      github: {
        ...withGithub().kanban.github,
        conditionLabel: "baton",
      },
    },
  };
  // 各呼び出しごとに空配列を返す。
  const { run, calls } = mockRunner(() => okResult("[]"));
  const adapter = createGitHubKanbanAdapter(cfg, run);
  const tickets = await adapter.queryCandidates();
  expect(tickets).toEqual([]);
  // 1 repo × 2 lane = 2 呼び出し
  expect(calls).toHaveLength(2);
  const firstCall = calls[0]!;
  expect(firstCall.slice(0, 4)).toEqual(["issue", "list", "--repo", "acme/baton"]);
  // --label が 2 個（trigger lane + conditionLabel）
  const labelArgs = firstCall
    .map((a, i) => (a === "--label" ? firstCall[i + 1] : null))
    .filter((x): x is string => x !== null);
  expect(labelArgs).toContain("status:In Progress");
  expect(labelArgs).toContain("baton");
});

test("updateTicket({lane}): 既存 status:* ラベルを外して新規追加する", async () => {
  const cfg = withGithub();
  const responses: RunResult[] = [
    // 1 回目: gh issue view --json labels
    okResult(JSON.stringify({ labels: [{ name: "status:In Progress" }, { name: "bug" }] })),
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
  // 既存 status:In Progress を除去して status:Human Review を追加
  expect(editCall).toContain("--remove-label");
  expect(editCall).toContain("status:In Progress");
  expect(editCall).toContain("--add-label");
  expect(editCall).toContain("status:Human Review");
  // 非 status ラベル (bug) は触らない
  expect(editCall).not.toContain("bug");
});

test("updateTicket({prUrl, activity}): 2 件のコメントとして追記", async () => {
  const cfg = withGithub();
  const { run, calls } = mockRunner(() => okResult(""));
  const adapter = createGitHubKanbanAdapter(cfg, run);
  await adapter.updateTicket("acme/baton#7", {
    prUrl: "https://github.com/acme/baton/pull/42",
    activity: "✅ 完了",
  });
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.slice(0, 5)).toEqual(["issue", "comment", "7", "--repo", "acme/baton"]);
  }
  const bodies = calls.map((c) => c[c.indexOf("--body") + 1]);
  expect(bodies).toContain("🔗 PR: https://github.com/acme/baton/pull/42");
  expect(bodies).toContain("✅ 完了");
});

test("updateTicket({lane}): 目的の lane がすでに付いていて他の status ラベルがない場合は no-op", async () => {
  const cfg = withGithub();
  const responses: RunResult[] = [
    okResult(JSON.stringify({ labels: [{ name: "status:In Progress" }] })),
  ];
  let i = 0;
  const { run, calls } = mockRunner(() => responses[i++]!);
  const adapter = createGitHubKanbanAdapter(cfg, run);
  await adapter.updateTicket("acme/baton#7", { lane: "In Progress" });
  // view のみで edit は呼ばれない
  expect(calls).toHaveLength(1);
});
