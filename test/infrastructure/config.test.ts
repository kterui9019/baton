import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  validateConfig,
} from "../../src/infrastructure/config.ts";

/** 部分指定 JSON を書いて loadConfig した結果を返すヘルパ。 */
function loadPartial(partial: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "nsym-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(partial));
  return loadConfig(p);
}

test("loadConfig: ネストを補完マージ、配列は置換", () => {
  const merged = loadPartial({
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

test("loadConfig: 深いネスト（kanban.notion）だけ書き換えても他は残る", () => {
  const merged = loadPartial({
    kanban: { notion: { dataSourceId: "abc" } },
  });
  expect(merged.kanban.notion.dataSourceId).toBe("abc");
  expect(merged.kanban.notion.laneProperty).toBe("Status");
  expect(merged.kanban.provider).toBe("notion");
  expect(merged.kanban.triggerLanes).toEqual(["In Progress"]);
});

test("loadConfig: 部分指定 + ~ 展開", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsym-"));
  const p = join(dir, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      maxConcurrent: 3,
      repoConfig: {
        "some-repo": { localDirPath: "~/repos/some-repo" },
      },
      agent: { maxAttempts: 4 },
    }),
  );
  const cfg = loadConfig(p);
  expect(cfg.maxConcurrent).toBe(3);
  expect(cfg.repoConfig["some-repo"]?.localDirPath).toBe(join(homedir(), "repos", "some-repo"));
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
  expect(DEFAULT_CONFIG.ghCommand).toBe("gh");
  expect(DEFAULT_CONFIG.prPollIntervalMs).toBe(60_000);
  expect(DEFAULT_CONFIG.autoReworkLimit).toBe(3);
  expect(DEFAULT_CONFIG.promptTemplate).toBe("prompts/task.md");
  expect(DEFAULT_CONFIG.systemPromptTemplate).toBe("");
});

test("DEFAULT_CONFIG: provider のデフォルトと組織固有デフォルトが除去されている", () => {
  expect(DEFAULT_CONFIG.kanban.provider).toBe("notion");
  expect(DEFAULT_CONFIG.agent.provider).toBe("claude");
  expect(DEFAULT_CONFIG.kanban.notion.dataSourceId).toBe("");
  expect(DEFAULT_CONFIG.repoConfig).toEqual({});
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
  repoConfig: {
    "your-repo": {
      localDirPath: "~/repos/your-repo",
    },
  },
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

test("validateConfig: repoConfig.<repo>.localDirPath 空はエラー", () => {
  const errors = validateConfig({
    ...validConfig,
    repoConfig: { "your-repo": { ...validConfig.repoConfig["your-repo"]!, localDirPath: "" } },
  });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("repoConfig.your-repo.localDirPath");
});

test("validateConfig: repoConfig が空でもエラーにならない", () => {
  expect(validateConfig({ ...validConfig, repoConfig: {} })).toEqual([]);
});

test("validateConfig: 複数エラーは全件返す", () => {
  const errors = validateConfig({
    ...validConfig,
    kanban: { ...validConfig.kanban, notion: { ...validConfig.kanban.notion, dataSourceId: "" } },
    repoConfig: { "your-repo": { localDirPath: "" } },
  });
  expect(errors.length).toBe(2);
});

test("DEFAULT_CONFIG: onlyOwnTickets は true", () => {
  expect(DEFAULT_CONFIG.onlyOwnTickets).toBe(true);
});

test("loadConfig: onlyOwnTickets を false に上書きできる", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsym-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ onlyOwnTickets: false }));
  expect(loadConfig(p).onlyOwnTickets).toBe(false);
});

test("DEFAULT_CONFIG: GitHub kanban / 新 agent プロバイダのデフォルト値", () => {
  expect(DEFAULT_CONFIG.kanban.github.conditionLabel).toBe("");
  expect(DEFAULT_CONFIG.kanban.github.owner).toBe("");
  expect(DEFAULT_CONFIG.kanban.github.repos).toEqual([]);
  expect(DEFAULT_CONFIG.agent.opencode.command).toBe("opencode");
  expect(DEFAULT_CONFIG.agent.grok.command).toBe("grok");
  expect(DEFAULT_CONFIG.agent.codex.command).toBe("codex");
});

const validGithubConfig = {
  ...DEFAULT_CONFIG,
  kanban: {
    ...DEFAULT_CONFIG.kanban,
    provider: "github" as const,
    github: {
      ...DEFAULT_CONFIG.kanban.github,
      owner: "acme",
      repos: ["baton"],
    },
  },
  repoConfig: {
    baton: {
      localDirPath: "~/repos/baton",
    },
  },
};

test("validateConfig(github): owner/repos 揃えば空", () => {
  expect(validateConfig(validGithubConfig)).toEqual([]);
});

test("validateConfig(github): owner 空はエラー", () => {
  const errors = validateConfig({
    ...validGithubConfig,
    kanban: {
      ...validGithubConfig.kanban,
      github: { ...validGithubConfig.kanban.github, owner: "" },
    },
  });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("kanban.github.owner");
});

test("validateConfig(github): repos 空はエラー", () => {
  const errors = validateConfig({
    ...validGithubConfig,
    kanban: {
      ...validGithubConfig.kanban,
      github: { ...validGithubConfig.kanban.github, repos: [] },
    },
  });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("kanban.github.repos");
});

test("validateConfig(github): notion 側の dataSourceId 未設定は影響しない", () => {
  // provider が github のとき notion.dataSourceId 空でもエラーにならない
  expect(
    validateConfig({
      ...validGithubConfig,
      kanban: {
        ...validGithubConfig.kanban,
        notion: { ...validGithubConfig.kanban.notion, dataSourceId: "" },
      },
    }),
  ).toEqual([]);
});
