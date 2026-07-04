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

export interface AgentConfig {
  provider: "claude" | "takt";
  timeoutMs: number;
  maxAttempts: number;
  claude: ClaudeAgentConfig;
  takt: TaktAgentConfig;
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

export interface KanbanConfig {
  provider: "notion";
  triggerLanes: string[];
  doneLane: string;
  /** PR マージ検知時に移動するレーン。 */
  mergedLane: string;
  terminalLanes: string[];
  notion: NotionKanbanConfig;
}

/** リポジトリ別の worktree セットアップ設定。 */
export interface RepoSetup {
  /**
   * clone元 → worktree へコピーするパス（clone元ルート基準の相対パス）。
   * gitignore された `.env` や `.claude` などを持ち込むのに使う。
   * ファイル・ディレクトリの両方に対応（ディレクトリは再帰コピー）。
   */
  copy?: string[];
  /** worktree を cwd に `sh -c` で順次実行するセットアップコマンド。 */
  commands?: string[];
}

export interface Config {
  pollIntervalMs: number;
  maxConcurrent: number;
  repoRoot: string;
  repoMapping: Record<string, string>;
  gitRemotePrefix: string;
  autoClone: boolean;
  branchTemplate: string;
  /** worktree セットアップコマンドのタイムアウト (ms)。 */
  setupTimeoutMs: number;
  /** リポジトリ名（カンバン側の表示名）→ セットアップ設定。 */
  repoSetup: Record<string, RepoSetup>;
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
  repoRoot: "~/repos",
  repoMapping: {},
  gitRemotePrefix: "",
  autoClone: true,
  branchTemplate: "feature/notion-{id}/{slug}",
  setupTimeoutMs: 600_000,
  repoSetup: {},
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
  },
};

/**
 * config.json の入力形（すべて optional な deep-partial）を検証する zod schema。
 * 外部ファイルという境界のパースにのみ zod を使い、型が合っていれば通す
 * （値の意味的妥当性は validateConfig が別途チェックする）。
 */
const ClaudeAgentConfigInputSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});

const TaktAgentConfigInputSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});

const AgentConfigInputSchema = z.object({
  provider: z.enum(["claude", "takt"]).optional(),
  timeoutMs: z.number().optional(),
  maxAttempts: z.number().optional(),
  claude: ClaudeAgentConfigInputSchema.optional(),
  takt: TaktAgentConfigInputSchema.optional(),
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

const KanbanConfigInputSchema = z.object({
  provider: z.literal("notion").optional(),
  triggerLanes: z.array(z.string()).optional(),
  doneLane: z.string().optional(),
  mergedLane: z.string().optional(),
  terminalLanes: z.array(z.string()).optional(),
  notion: NotionKanbanConfigInputSchema.optional(),
});

const RepoSetupInputSchema = z.object({
  copy: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
});

const ConfigInputSchema = z.object({
  pollIntervalMs: z.number().optional(),
  maxConcurrent: z.number().optional(),
  repoRoot: z.string().optional(),
  repoMapping: z.record(z.string(), z.string()).optional(),
  gitRemotePrefix: z.string().optional(),
  autoClone: z.boolean().optional(),
  branchTemplate: z.string().optional(),
  setupTimeoutMs: z.number().optional(),
  repoSetup: z.record(z.string(), RepoSetupInputSchema).optional(),
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
  if (cfg.kanban.notion.dataSourceId === "") {
    errors.push(
      "kanban.notion.dataSourceId が未設定です。`ntn datasources resolve <database_id>` で " +
        "data_source_id を取得して config.json に設定してください。",
    );
  }
  if (cfg.repoRoot === "") {
    errors.push(
      "repoRoot が未設定です。リポジトリを配置するルートディレクトリ（例: ~/repos）を config.json に設定してください。",
    );
  }
  if (cfg.gitRemotePrefix === "" && cfg.autoClone) {
    errors.push(
      "autoClone: true ですが gitRemotePrefix が未設定です。clone 元の URL プレフィックス" +
        "（例: git@github.com:your-org/）を設定するか、autoClone を false にしてください。",
    );
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
  return { ...config, repoRoot: expandHome(config.repoRoot) };
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
