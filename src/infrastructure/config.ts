import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { expandHome } from "./format.ts";

export interface ClaudeAgentConfig {
  command: string;
  args: string[];
}

export interface TaktAgentConfig {
  command: string;
  args: string[];
}

export interface OpencodeAgentConfig {
  command: string;
  args: string[];
}

export interface GrokAgentConfig {
  command: string;
  args: string[];
}

export interface CodexAgentConfig {
  command: string;
  args: string[];
}

export type AgentProvider = "claude" | "takt" | "opencode" | "grok" | "codex";

export interface AgentConfig {
  provider: AgentProvider;
  timeoutMs: number;
  maxAttempts: number;
  claude: ClaudeAgentConfig;
  takt: TaktAgentConfig;
  opencode: OpencodeAgentConfig;
  grok: GrokAgentConfig;
  codex: CodexAgentConfig;
}

export interface NotionKanbanConfig {
  dataSourceId: string;
  laneProperty: string;
  repoProperty: string;
  titleProperty: string;
  conditionProperty: string;
  conditionValue: string;
  /** PR リンク (rich_text) プロパティ名。"" なら読み書きをスキップ。 */
  prProperty: string;
  /** アクティビティ (rich_text) プロパティ名。"" なら読み書きをスキップ。 */
  activityProperty: string;
  ntnCommand: string;
}

/**
 * GitHub Issues をカンバンとして扱う設定。lane はラベル
 * （`<lanePrefix><lane>` 形式、例: `status:In Progress`）で表現する。
 */
export interface GitHubKanbanConfig {
  /** 対象リポジトリのオーナー（個人 or org）。 */
  owner: string;
  /** 対象リポジトリ名の配列（owner 配下の <name> のみ、`owner/name` ではない）。 */
  repos: string[];
  /** lane ラベルのプレフィックス（デフォルト `status:`）。lane 名は「プレフィックス + triggerLanes/doneLane の値」で組み立てる。 */
  lanePrefix: string;
  /**
   * 追加フィルタ用ラベル（Notion の Condition プロパティ相当）。
   * "" なら無効（trigger lane のみで判定）、指定時はこのラベルが付いた issue のみ対象。
   */
  conditionLabel: string;
}

export type KanbanProvider = "notion" | "github";

export interface KanbanConfig {
  provider: KanbanProvider;
  triggerLanes: string[];
  doneLane: string;
  /** PR マージ検知時に移動するレーン。 */
  mergedLane: string;
  terminalLanes: string[];
  notion: NotionKanbanConfig;
  github: GitHubKanbanConfig;
}

/** リポジトリ別の worktree セットアップ設定。 */
export interface RepoSetupConfig {
  /**
   * clone元 → worktree へコピーするパス（clone元ルート基準の相対パス）。
   * gitignore された `.env` や `.claude` などを持ち込むのに使う。
   * ファイル・ディレクトリの両方に対応（ディレクトリは再帰コピー）。
   */
  copy?: string[];
  /** worktree を cwd に `sh -c` で順次実行するセットアップコマンド。 */
  commands?: string[];
}

/**
 * リポジトリ単位の設定。「どこに置くか」「どうセットアップするか」を
 * 1つのオブジェクトにまとめる（kanban のプロバイダーに依存しない）。
 */
export interface RepoConfigEntry {
  /** ローカルの git リポジトリのディレクトリ（絶対パス、`~` 展開可）。 */
  localDirPath: string;
  /** 作業ブランチ名テンプレート。省略時はトップレベルの branchTemplate にフォールバック。 */
  branchTemplate?: string;
  /** worktree セットアップ（.env コピー・依存インストール等）。 */
  setup?: RepoSetupConfig;
}

export interface Config {
  pollIntervalMs: number;
  maxConcurrent: number;
  /** 作業ブランチ名テンプレートのグローバルデフォルト。repoConfig[repo].branchTemplate で上書き可能。 */
  branchTemplate: string;
  /** worktree セットアップコマンドのタイムアウト (ms)。 */
  setupTimeoutMs: number;
  /** リポジトリ名（カンバン側の表示名）→ リポジトリ単位の設定。 */
  repoConfig: Record<string, RepoConfigEntry>;
  /** gh CLI コマンド名（PR 監視用）。 */
  ghCommand: string;
  /** PR 監視（CI/レビュー/マージ）のポーリング間隔 (ms)。 */
  prPollIntervalMs: number;
  /** CI 失敗起因の自動 rework 回数上限。 */
  autoReworkLimit: number;
  /** プロンプトテンプレートのパス（絶対パス or projectRoot 相対）。 */
  promptTemplate: string;
  /**
   * システムプロンプト追加用テンプレートのパス（絶対パス or projectRoot 相対）。
   * "" なら無効（デフォルト）。指定時は promptTemplate と同じ変数で描画し、
   * `claude --append-system-prompt` として渡す。チケット本文とは独立した
   * 「このツール特有の運用ルール」（例: 呼び出し元の説明、進捗プロパティへの
   * 書き込み指示など）を毎回のエージェント実行に注入する用途に使う。
   */
  systemPromptTemplate: string;
  /** カンバンプロバイダー設定。provider でどの実装を使うかを明示する。 */
  kanban: KanbanConfig;
  /** コーディングエージェント設定。provider でどの実装を使うかを明示する。 */
  agent: AgentConfig;
}

export const DEFAULT_CONFIG: Config = {
  pollIntervalMs: 30_000,
  maxConcurrent: 2,
  branchTemplate: "feature/notion-{id}/{slug}",
  setupTimeoutMs: 600_000,
  repoConfig: {},
  ghCommand: "gh",
  prPollIntervalMs: 60_000,
  autoReworkLimit: 3,
  promptTemplate: "prompts/task.md",
  systemPromptTemplate: "",
  kanban: {
    provider: "notion",
    triggerLanes: ["In Progress"],
    doneLane: "Human Review",
    mergedLane: "In Delivery",
    terminalLanes: ["Released", "Canceled"],
    notion: {
      dataSourceId: "",
      conditionProperty: "Condition",
      conditionValue: "Local",
      laneProperty: "Status",
      repoProperty: "Repo",
      titleProperty: "Title",
      ntnCommand: "ntn",
      prProperty: "PR",
      activityProperty: "Activity",
    },
    github: {
      owner: "",
      repos: [],
      lanePrefix: "status:",
      conditionLabel: "",
    },
  },
  agent: {
    provider: "claude",
    timeoutMs: 3_600_000,
    maxAttempts: 2,
    claude: {
      command: "claude",
      args: ["--permission-mode", "bypassPermissions"],
    },
    takt: {
      command: "takt",
      args: ["--pipeline", "--skip-git", "--quiet"],
    },
    opencode: {
      command: "opencode",
      args: [],
    },
    grok: {
      command: "grok",
      args: [],
    },
    codex: {
      command: "codex",
      args: [],
    },
  },
};

/**
 * config.json の入力形（すべて optional な deep-partial）を検証する zod schema。
 * 外部ファイルという境界のパースにのみ zod を使い、型が合っていれば通す
 * （値の意味的妥当性は validateConfig が別途チェックする）。
 */
const AgentCliConfigInputSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});

const AgentConfigInputSchema = z.object({
  provider: z.enum(["claude", "takt", "opencode", "grok", "codex"]).optional(),
  timeoutMs: z.number().optional(),
  maxAttempts: z.number().optional(),
  claude: AgentCliConfigInputSchema.optional(),
  takt: AgentCliConfigInputSchema.optional(),
  opencode: AgentCliConfigInputSchema.optional(),
  grok: AgentCliConfigInputSchema.optional(),
  codex: AgentCliConfigInputSchema.optional(),
});

const NotionKanbanConfigInputSchema = z.object({
  dataSourceId: z.string().optional(),
  laneProperty: z.string().optional(),
  repoProperty: z.string().optional(),
  titleProperty: z.string().optional(),
  conditionProperty: z.string().optional(),
  conditionValue: z.string().optional(),
  prProperty: z.string().optional(),
  activityProperty: z.string().optional(),
  ntnCommand: z.string().optional(),
});

const GitHubKanbanConfigInputSchema = z.object({
  owner: z.string().optional(),
  repos: z.array(z.string()).optional(),
  lanePrefix: z.string().optional(),
  conditionLabel: z.string().optional(),
});

const KanbanConfigInputSchema = z.object({
  provider: z.enum(["notion", "github"]).optional(),
  triggerLanes: z.array(z.string()).optional(),
  doneLane: z.string().optional(),
  mergedLane: z.string().optional(),
  terminalLanes: z.array(z.string()).optional(),
  notion: NotionKanbanConfigInputSchema.optional(),
  github: GitHubKanbanConfigInputSchema.optional(),
});

const RepoSetupConfigInputSchema = z.object({
  copy: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
});

const RepoConfigEntryInputSchema = z.object({
  localDirPath: z.string().optional(),
  branchTemplate: z.string().optional(),
  setup: RepoSetupConfigInputSchema.optional(),
});

const ConfigInputSchema = z.object({
  pollIntervalMs: z.number().optional(),
  maxConcurrent: z.number().optional(),
  branchTemplate: z.string().optional(),
  setupTimeoutMs: z.number().optional(),
  repoConfig: z.record(z.string(), RepoConfigEntryInputSchema).optional(),
  ghCommand: z.string().optional(),
  prPollIntervalMs: z.number().optional(),
  autoReworkLimit: z.number().optional(),
  promptTemplate: z.string().optional(),
  systemPromptTemplate: z.string().optional(),
  kanban: KanbanConfigInputSchema.optional(),
  agent: AgentConfigInputSchema.optional(),
});

/**
 * 必須設定の検証（純粋関数）。エラーメッセージの配列を返す（空なら valid）。
 * loadConfig からは呼ばない（throw しない）: 起動時は main.ts が全件表示して
 * exit(1) し、ホットリロード時は warn ログのみで継続するため。
 */
export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];
  if (cfg.kanban.provider === "notion") {
    if (cfg.kanban.notion.dataSourceId === "") {
      errors.push(
        "kanban.notion.dataSourceId が未設定です。`ntn datasources resolve <database_id>` で " +
          "data_source_id を取得して config.json に設定してください。",
      );
    }
  } else if (cfg.kanban.provider === "github") {
    if (cfg.kanban.github.owner === "") {
      errors.push(
        "kanban.github.owner が未設定です。対象リポジトリのオーナー（個人 or org 名）を config.json に設定してください。",
      );
    }
    if (cfg.kanban.github.repos.length === 0) {
      errors.push(
        "kanban.github.repos が空です。対象リポジトリ名の配列（owner 配下の name のみ、`owner/name` ではない）を config.json に設定してください。",
      );
    }
  }
  for (const [repo, entry] of Object.entries(cfg.repoConfig)) {
    if ((entry.localDirPath ?? "") === "") {
      errors.push(
        `repoConfig.${repo}.localDirPath が未設定です。事前に clone 済みのローカルディレクトリ（例: ~/repos/${repo}）を設定してください。`,
      );
    }
  }
  return errors;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** base をベースに override を再帰マージ（配列は override で置換）。 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = (base as Record<string, unknown>)[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** パス系フィールドの `~` をホーム展開する。 */
function normalize(config: Config): Config {
  const repoConfig = Object.fromEntries(
    Object.entries(config.repoConfig).map(([repo, entry]) => [
      repo,
      { ...entry, localDirPath: expandHome(entry.localDirPath ?? "") },
    ]),
  );
  return { ...config, repoConfig };
}

/** config.json を読み、zod で検証したうえでデフォルトと deep merge して返す。 */
export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw) as unknown;
  const parsed = ConfigInputSchema.parse(json);
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  return normalize(merged);
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export interface ConfigManager {
  get(): Config;
  /** mtime が変わっていれば再読込。実際にリロードしたら true。 */
  maybeReload(): boolean;
}

/**
 * mtime を監視し、変化していたら再読込する config マネージャを組み立てる。
 * パース失敗時は直前の設定を保持し onError を呼ぶ。可変状態（現在値/mtime）は
 * クロージャで保持し、class は使わない。
 */
export function createConfigManager(
  path: string,
  onError?: (err: unknown) => void,
): ConfigManager {
  let current = loadConfig(path);
  let mtimeMs = safeMtime(path);

  return {
    get: () => current,
    maybeReload: () => {
      let newMtimeMs: number;
      try {
        newMtimeMs = statSync(path).mtimeMs;
      } catch (err) {
        onError?.(err);
        return false;
      }
      if (newMtimeMs === mtimeMs) return false;
      try {
        current = loadConfig(path);
        mtimeMs = newMtimeMs;
        return true;
      } catch (err) {
        // パース失敗: 直前の設定で継続。mtime は更新して同エラーの連発を防ぐ。
        mtimeMs = newMtimeMs;
        onError?.(err);
        return false;
      }
    },
  };
}
