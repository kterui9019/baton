import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { expandHome } from "./format.ts";

/**
 * 設定は zod schema を唯一の情報源（single source of truth）とする。
 * - 各フィールドに `.default(...)` を持たせ、型は `z.infer` で導出する
 *   （出力型は default 適用後なので全フィールド必須になり、Config 本体の型と一致する）。
 * - ネストしたオブジェクトには `.prefault({})` を付け、親フィールドが丸ごと欠損しても
 *   内側の leaf default まで埋まるようにする（部分指定 config.json のマージを zod だけで賄う）。
 */

const agentProviderSchema = z.enum(["claude", "takt", "opencode", "grok", "codex"]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;

const kanbanProviderSchema = z.enum(["notion", "github"]);
export type KanbanProvider = z.infer<typeof kanbanProviderSchema>;

/** CLI コーディングエージェント共通の起動設定（コマンド名 + 追加引数）。 */
const agentCli = (command: string, args: string[] = []) =>
  z.object({
    command: z.string().default(command),
    args: z.array(z.string()).default(args),
  });
export type AgentCliConfig = z.infer<ReturnType<typeof agentCli>>;

const agentSchema = z
  .object({
    /** コーディングエージェント実装の選択。 */
    provider: agentProviderSchema.default("claude"),
    timeoutMs: z.number().default(3_600_000),
    maxAttempts: z.number().default(2),
    claude: agentCli("claude", ["--permission-mode", "bypassPermissions"]).prefault({}),
    takt: agentCli("takt", ["--pipeline", "--skip-git", "--quiet"]).prefault({}),
    opencode: agentCli("opencode").prefault({}),
    grok: agentCli("grok").prefault({}),
    codex: agentCli("codex").prefault({}),
  })
  .prefault({});

const notionKanbanSchema = z
  .object({
    dataSourceId: z.string().default(""),
    laneProperty: z.string().default("Status"),
    repoProperty: z.string().default("Repo"),
    titleProperty: z.string().default("Title"),
    conditionProperty: z.string().default("Condition"),
    conditionValue: z.string().default("Local"),
    /** PR リンク (rich_text) プロパティ名。"" なら読み書きをスキップ。 */
    prProperty: z.string().default("PR"),
    /** アクティビティ (rich_text) プロパティ名。"" なら読み書きをスキップ。 */
    activityProperty: z.string().default("Activity"),
    ntnCommand: z.string().default("ntn"),
  })
  .prefault({});

/**
 * GitHub Issues をカンバンとして扱う設定。lane はラベル
 * （`<lanePrefix><lane>` 形式、例: `status:In Progress`）で表現する。
 */
const githubKanbanSchema = z
  .object({
    /** 対象リポジトリのオーナー（個人 or org）。 */
    owner: z.string().default(""),
    /** 対象リポジトリ名の配列（owner 配下の <name> のみ、`owner/name` ではない）。 */
    repos: z.array(z.string()).default([]),
    /** lane ラベルのプレフィックス。lane 名は「プレフィックス + triggerLanes/doneLane の値」で組み立てる。 */
    lanePrefix: z.string().default("status:"),
    /**
     * 追加フィルタ用ラベル（Notion の Condition プロパティ相当）。
     * "" なら無効（trigger lane のみで判定）、指定時はこのラベルが付いた issue のみ対象。
     */
    conditionLabel: z.string().default(""),
  })
  .prefault({});

const kanbanSchema = z
  .object({
    /** カンバンプロバイダー実装の選択。 */
    provider: kanbanProviderSchema.default("notion"),
    triggerLanes: z.array(z.string()).default(["In Progress"]),
    doneLane: z.string().default("Human Review"),
    terminalLanes: z.array(z.string()).default(["Released", "Canceled"]),
    notion: notionKanbanSchema,
    github: githubKanbanSchema,
  })
  .prefault({});

/** リポジトリ別の worktree セットアップ設定。 */
const repoSetupSchema = z.object({
  /**
   * clone元 → worktree へコピーするパス（clone元ルート基準の相対パス）。
   * gitignore された `.env` や `.claude` などを持ち込むのに使う。
   * ファイル・ディレクトリの両方に対応（ディレクトリは再帰コピー）。
   */
  copy: z.array(z.string()).optional(),
  /** worktree を cwd に `sh -c` で順次実行するセットアップコマンド。 */
  commands: z.array(z.string()).optional(),
});

/**
 * リポジトリ単位の設定。「どこに置くか」「どうセットアップするか」を
 * 1つのオブジェクトにまとめる（kanban のプロバイダーに依存しない）。
 */
const repoConfigEntrySchema = z.object({
  /** ローカルの git リポジトリのディレクトリ（絶対パス、`~` 展開可）。 */
  localDirPath: z.string().default(""),
  /** 作業ブランチ名テンプレート。省略時はトップレベルの branchTemplate にフォールバック。 */
  branchTemplate: z.string().optional(),
  /** worktree セットアップ（.env コピー・依存インストール等）。 */
  setup: repoSetupSchema.optional(),
});
export type RepoConfigEntry = z.infer<typeof repoConfigEntrySchema>;

const configSchema = z.object({
  pollIntervalMs: z.number().default(30_000),
  maxConcurrent: z.number().default(2),
  /**
   * true（デフォルト）のとき、カンバン上の自分が作成したチケットにだけ反応する。
   * false にすると他人が作成したチケットも dispatch 対象になる。
   */
  onlyOwnTickets: z.boolean().default(true),
  /** 作業ブランチ名テンプレートのグローバルデフォルト。repoConfig[repo].branchTemplate で上書き可能。 */
  branchTemplate: z.string().default("feature/notion-{id}/{slug}"),
  /** worktree セットアップコマンドのタイムアウト (ms)。 */
  setupTimeoutMs: z.number().default(600_000),
  /** リポジトリ名（カンバン側の表示名）→ リポジトリ単位の設定。 */
  repoConfig: z.record(z.string(), repoConfigEntrySchema).default({}),
  /** gh CLI コマンド名（PR 監視用）。 */
  ghCommand: z.string().default("gh"),
  /** PR 監視（CI/マージ）のポーリング間隔 (ms)。 */
  prPollIntervalMs: z.number().default(60_000),
  /** CI 失敗起因の自動 rework 回数上限。 */
  autoReworkLimit: z.number().default(3),
  /** プロンプトテンプレートのパス（絶対パス or projectRoot 相対）。 */
  promptTemplate: z.string().default("prompts/task.md"),
  /**
   * システムプロンプト追加用テンプレートのパス（絶対パス or projectRoot 相対）。
   * "" なら無効（デフォルト）。指定時は promptTemplate と同じ変数で描画し、
   * `claude --append-system-prompt` として渡す。チケット本文とは独立した
   * 「このツール特有の運用ルール」（例: 呼び出し元の説明、進捗プロパティへの
   * 書き込み指示など）を毎回のエージェント実行に注入する用途に使う。
   */
  systemPromptTemplate: z.string().default(""),
  /**
   * ネイティブセッション resume（ci_failure/needs_info_answer で
   * 前回 session_id が記録済みの場合）に使う軽量プロンプトテンプレートのパス
   * （絶対パス or projectRoot 相対）。promptTemplate と同じ変数を使えるが、
   * セッションが前回文脈を保持している前提でチケット本文（title/body）は
   * 含めない想定。
   */
  resumePromptTemplate: z.string().default("prompts/resume.md"),
  /** カンバンプロバイダー設定。provider でどの実装を使うかを明示する。 */
  kanban: kanbanSchema,
  /** コーディングエージェント設定。provider でどの実装を使うかを明示する。 */
  agent: agentSchema,
});

export type Config = z.infer<typeof configSchema>;

/** schema から導出したデフォルト設定（空入力を parse して全 default を確定させる）。 */
export const DEFAULT_CONFIG: Config = configSchema.parse({});

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

/** パス系フィールドの `~` をホーム展開する。 */
function normalize(config: Config): Config {
  const repoConfig = Object.fromEntries(
    Object.entries(config.repoConfig).map(([repo, entry]) => [
      repo,
      { ...entry, localDirPath: expandHome(entry.localDirPath) },
    ]),
  );
  return { ...config, repoConfig };
}

/**
 * config.json を読み、zod schema で検証しつつ欠損フィールドを default 補完して返す。
 * 部分指定でも `.default()`/`.prefault()` が全階層の欠損を埋める。
 */
export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw) as unknown;
  return normalize(configSchema.parse(json));
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
