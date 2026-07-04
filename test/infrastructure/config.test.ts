import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  deepMerge,
  loadConfig,
  validateConfig,
} from "../../src/infrastructure/config.ts";

test("deepMerge: ネストを再帰マージ、配列は置換", () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    maxConcurrent: 5,
    agent: { timeoutMs: 1000 },
    kanban: { triggerLanes: ["TODO"] },
  });
  expect(merged.maxConcurrent).toBe(5);
  expect(merged.agent.timeoutMs).toBe(1000);
  expect(merged.agent.claude.command).toBe("claude");
  expect(merged.agent.maxAttempts).toBe(2);
  expect(merged.kanban.triggerLanes).toEqual(["TODO"]);
  expect(merged.kanban.doneLane).toBe("Human Review");
});

test("deepMerge: 深いネスト（kanban.notion）だけ書き換えても他は残る", () => {
  const merged = deepMerge(DEFAULT_CONFIG, {
    kanban: { notion: { dataSourceId: "abc" } },
  });
  expect(merged.kanban.notion.dataSourceId).toBe("abc");
  expect(merged.kanban.notion.laneProperty).toBe("Status");
  expect(merged.kanban.provider).toBe("notion");
  expect(merged.kanban.triggerLanes).toEqual(["In Progress"]);
});

test("deepMerge: 非オブジェクト override はそのまま", () => {
  expect(deepMerge({ a: 1 }, null)).toEqual({ a: 1 });
});

test("loadConfig: 部分指定 + ~ 展開", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsym-"));
  const p = join(dir, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      maxConcurrent: 3,
      repoRoot: "~/repos",
      agent: { maxAttempts: 4 },
    }),
  );
  const cfg = loadConfig(p);
  expect(cfg.maxConcurrent).toBe(3);
  expect(cfg.repoRoot).toBe(join(homedir(), "repos"));
  expect(cfg.agent.maxAttempts).toBe(4);
  expect(cfg.agent.claude.command).toBe("claude");
  expect(cfg.kanban.notion.dataSourceId).toBe(DEFAULT_CONFIG.kanban.notion.dataSourceId);
});

test("loadConfig: 型の合わない値は zod 検証で throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsym-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ maxConcurrent: "five" }));
  expect(() => loadConfig(p)).toThrow();
});

test("DEFAULT_CONFIG: 新規フィールドのデフォルト値", () => {
  expect(DEFAULT_CONFIG.kanban.notion.conditionProperty).toBe("Condition");
  expect(DEFAULT_CONFIG.kanban.notion.conditionValue).toBe("Local");
  expect(DEFAULT_CONFIG.kanban.notion.prProperty).toBe("PR");
  expect(DEFAULT_CONFIG.kanban.notion.activityProperty).toBe("Activity");
  expect(DEFAULT_CONFIG.ghCommand).toBe("gh");
  expect(DEFAULT_CONFIG.prPollIntervalMs).toBe(60_000);
  expect(DEFAULT_CONFIG.kanban.mergedLane).toBe("In Delivery");
  expect(DEFAULT_CONFIG.autoReworkLimit).toBe(3);
  expect(DEFAULT_CONFIG.promptTemplate).toBe("prompts/task.md");
  expect(DEFAULT_CONFIG.systemPromptTemplate).toBe("");
});

test("DEFAULT_CONFIG: provider のデフォルトと組織固有デフォルトが除去されている", () => {
  expect(DEFAULT_CONFIG.kanban.provider).toBe("notion");
  expect(DEFAULT_CONFIG.agent.provider).toBe("claude");
  expect(DEFAULT_CONFIG.kanban.notion.dataSourceId).toBe("");
  expect(DEFAULT_CONFIG.repoRoot).toBe("~/repos");
  expect(DEFAULT_CONFIG.gitRemotePrefix).toBe("");
});

const validConfig = {
  ...DEFAULT_CONFIG,
  kanban: {
    ...DEFAULT_CONFIG.kanban,
    notion: {
      ...DEFAULT_CONFIG.kanban.notion,
      dataSourceId: "7c71f420-0760-46b8-b9f5-d033c6b7c358",
    },
  },
  gitRemotePrefix: "git@github.com:your-org/",
};

test("validateConfig: 必須設定が揃っていれば空配列", () => {
  expect(validateConfig(validConfig)).toEqual([]);
});

test("validateConfig: dataSourceId 空はエラー（取得方法のヒント付き）", () => {
  const errors = validateConfig({
    ...validConfig,
    kanban: { ...validConfig.kanban, notion: { ...validConfig.kanban.notion, dataSourceId: "" } },
  });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("dataSourceId");
});

test("validateConfig: repoRoot 空はエラー", () => {
  const errors = validateConfig({ ...validConfig, repoRoot: "" });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("repoRoot");
});

test("validateConfig: gitRemotePrefix 空 + autoClone: true はエラー", () => {
  const errors = validateConfig({ ...validConfig, gitRemotePrefix: "" });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("gitRemotePrefix");
  expect(errors[0]).toContain("autoClone");
});

test("validateConfig: gitRemotePrefix 空でも autoClone: false なら OK", () => {
  expect(
    validateConfig({ ...validConfig, gitRemotePrefix: "", autoClone: false }),
  ).toEqual([]);
});

test("validateConfig: 複数エラーは全件返す", () => {
  const errors = validateConfig({
    ...validConfig,
    kanban: { ...validConfig.kanban, notion: { ...validConfig.kanban.notion, dataSourceId: "" } },
    repoRoot: "",
    gitRemotePrefix: "",
  });
  expect(errors.length).toBe(3);
});
