# baton

[![CI](https://github.com/kterui9019/baton/actions/workflows/ci.yml/badge.svg)](https://github.com/kterui9019/baton/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40kterui9019%2Fbaton)](https://www.npmjs.com/package/@kterui9019/baton)

https://github.com/user-attachments/assets/19ba0ad2-a62a-42f5-8c60-c7a03e2b462b

カンバン（Notion / GitHub Issues に対応）をエージェントオーケストレーターとして使い、チケットを **In Progress** レーンに動かすとローカルでコーディングエージェント（Claude Code / takt / opencode / grok / codex）が走って実装 → PR 作成 → CI 監視 → レビュー対応 → カンバン更新まで自動化する常駐デーモンです。[openai/symphony](https://github.com/openai/symphony/blob/main/SPEC.md) にインスパイアされています。

```mermaid
flowchart LR
    Kanban["Kanban<br/>(Notion or GitHub Issues, レーン=In Progress)"]
    Orchestrator["Orchestrator<br/>(Bun/TypeScript)"]
    GitHub["GitHub (gh CLI)<br/>CI/レビュー/マージ監視"]
    Workspace["Workspace (git worktree)<br/>claude / takt / opencode / grok / codex"]
    PR["PR 作成 (gh)"]

    Kanban <-- "poll (ntn CLI or gh CLI)" --> Orchestrator
    Orchestrator <--> GitHub
    Orchestrator -- dispatch --> Workspace
    Workspace --> PR
```

## 必要なもの

- **macOS**（常駐化が launchd 前提のため。`baton --once` 等の手動実行なら他 OS でも動作します）
- **Bun** >= 1.3（`baton` コマンド自体が `#!/usr/bin/env bun` で実行されるため必須。[bun.sh](https://bun.sh) からインストール）
- **カンバンプロバイダー**（`kanban.provider` で選択。いずれか一方でよい）
  - `notion`: **ntn CLI**（[Notion CLI](https://developers.notion.com)。`ntn login` 済みで、対象 DB にアクセスできること）
  - `github`: 追加ツール不要（下記 gh CLI のみでよい）。対象リポジトリの Issues を使う
- **gh CLI**（PR 作成・CI/レビュー監視用、および `kanban.provider: "github"` 時のカンバン操作用。`gh auth login` 済みであること）
- **コーディングエージェント CLI**（`agent.provider` で選択。使うものだけ入っていればよい）
  - `claude`: **claude CLI**（Claude Code）
  - `takt`: [takt](https://github.com/nrslib/takt)
  - `opencode`: [opencode CLI](https://opencode.ai)
  - `grok`: [Grok CLI](https://x.ai/cli)（xAI）
  - `codex`: [Codex CLI](https://developers.openai.com/codex/cli)（OpenAI）

## カンバンの準備

### Notion（`kanban.provider: "notion"`）

以下のプロパティを持つデータベースを用意します。**プロパティ名はすべて config で変更可能**です（下表の「config キー」列）。既定値と同じ名前でプロパティを作れば config の変更は不要です。

| プロパティ（既定名） | 型 | config キー | 用途 |
|---|---|---|---|
| Title | title | `titleProperty` | チケットのタイトル |
| Status | status | `laneProperty` | 状態管理。例: TODO / In Progress / Human Review / Released / Canceled |
| Repo | select | `repoProperty` | 対象リポジトリ名（選択肢としてリポジトリ名を登録） |
| Condition | select | `conditionProperty` | 実行条件。`Local` 等。この値が `conditionValue` と一致するチケットのみ実行 |
| PR | rich_text | `prProperty` | 作成した PR のリンク（自動書き込み） |

- 実行状況（開始・成功・失敗・リトライ等）はプロパティではなく**ページコメント**として都度投稿されます。
- Status（status）の選択肢は最低限、`kanban.triggerLanes`（実行トリガー）、`kanban.doneLane`（レビュー待ち）、`kanban.terminalLanes`（終了）に対応するものが必要です。
- **DB に無いプロパティは config で空文字 `""` を設定すればスキップされます**（例: `"kanban": { "notion": { "prProperty": "" } }` にすると PR リンクの読み書きを一切しない）。必須なのは Title / Status / Repo / Condition の 4 つです。

#### dataSourceId の取得

config に設定する `kanban.notion.dataSourceId` は database_id とは別物です。ntn CLI で database_id（DB ページの URL に含まれる 32 桁の ID）から解決できます:

```sh
ntn datasources resolve <database_id>
```

ntn を使わない場合は、Notion API の `GET /v1/databases/{database_id}` のレスポンスに含まれる `data_sources` 配列の `id` を参照してください。

### GitHub Issues（`kanban.provider: "github"`）

Notion の代わりに GitHub Issues をカンバンとして使えます。追加のツールは不要で、既存の `gh` CLI（`gh auth login` 済み）のみで動作します。レーン（状態）は **ラベル**で表現します。

```json
"kanban": {
  "provider": "github",
  "triggerLanes": ["In Progress"],
  "doneLane": "Human Review",
  "terminalLanes": ["Released", "Canceled"],
  "github": {
    "owner": "your-org",
    "repos": ["your-repo"],
    "lanePrefix": "status:",
    "conditionLabel": ""
  }
}
```

- **ラベルの用意**: `kanban.github.repos` の各リポジトリに、`lanePrefix` + レーン名（`kanban.triggerLanes` / `doneLane` / `terminalLanes` の各値）のラベルを事前に作成してください。既定なら `status:In Progress`、`status:Human Review`、`status:Released`、`status:Canceled` の 4 つ。
- **owner / repos**: `owner` はユーザー名または Organization 名。`repos` は `owner` 配下のリポジトリ名のみ（`owner/repo` ではなく `repo` 部分だけ）を配列で指定します。複数リポジトリを跨いだ監視が可能です。
- **conditionLabel**（任意）: Notion の `Condition` プロパティに相当する追加フィルタ用ラベル。`""`（既定）なら無効で、`triggerLanes` に対応するラベルさえ付いていれば対象になります。誤発火を防ぎたい場合は例えば `"baton"` のような専用ラベルを作って設定してください（そのラベルが付いた issue のみ対象になります）。
- **pageId 形式**: 内部的に `owner/repo#issue番号`（例: `acme/baton#42`）を使います。`baton status` 等で表示される ID もこの形式です。
- **書き込み内容**: レーン移動は「既存の `status:*` ラベルを外して新しいレーンのラベルを付ける」形で行われます。PR リンクと実行状況は issue への**コメント追記**として記録されます（Notion の `prProperty` に相当する専用フィールドはありません）。
- **チケット本文**: issue の本文（body）がそのままプロンプトに使われます。Notion の `Repo` プロパティに相当するものはなく、`repos` に含まれるリポジトリ名がそのまま対象リポジトリ名になります（`repoConfig` のキーと一致させてください）。

## セットアップ

```sh
# 0. インストール
npm i -g @kterui9019/baton

# 1. 設定ファイル一式を ~/.config/baton に作成
baton init

# 2. ~/.config/baton/config.json の必須項目を編集
#    - kanban.provider: "notion"（既定）または "github"
#      - notion: kanban.notion.dataSourceId に上記で取得した ID を設定
#        （プロパティ名を既定と変えている場合は kanban.notion.*Property 系も合わせる）
#      - github: kanban.github.owner / repos を設定
#    - agent.provider: "claude"（既定）/ "takt" / "opencode" / "grok" / "codex"
#      （使うエージェント CLI がインストール・認証済みであること）
#    - repoConfig: 対象リポジトリごとに localDirPath（事前に git clone 済みのローカルパス）を設定

# 3. dry-run で候補検出と設定を確認（書き込み・エージェント起動なし）
baton --once --dry-run

# 4. 問題なければ常駐化（launchd）
baton launchd install
```

`config.json` は `~/.config/baton/config.json`（`$XDG_CONFIG_HOME` があればそちら配下）に置かれ、npm パッケージ自体（コード）とは独立しています。state / logs / workspaces（git worktree の実体）もすべて同じディレクトリ配下に作られます。設定はデーモン再起動なしで反映されます（tick ごとに mtime を見て再読込）。

リポジトリを直接開発する場合は `git clone` → `bun install` の上で `bun run start` 等（後述）を使ってください。

### 起動コマンド

```sh
baton               # フォアグラウンドで常駐
baton --once        # 1 tick だけ実行
baton --once --dry-run  # 1 tick を dry-run（書き込みなし）
baton status        # 稼働状況の確認
baton --config <path>   # config.json の場所を明示的に指定
```

リポジトリを clone して開発する場合は `bun run start` / `bun run once` / `bun run dry-run` / `bun run status` が同等（内部で `bun src/main.ts ...` を実行、`--config` を渡さない限りやはり `~/.config/baton/config.json` を見る）。

### 常駐化（launchd, macOS）

```sh
baton launchd install    # 登録して起動（ログイン時自動起動・異常終了時再起動）
baton launchd uninstall  # 解除
tail -f ~/.config/baton/logs/launchd.out.log    # ログ
```

launchd のラベルは既定で `com.<ユーザー名>.baton`。変えたい場合は環境変数 `BATON_LABEL` を設定して install/uninstall を実行してください。

## 動作フロー

以下は Notion 前提の表現ですが、`kanban.provider: "github"` でも同じ流れです（「レーン」= ラベル、「ページコメント」= issue コメント、「Condition」= `conditionLabel` と読み替え）。

1. カンバンをポーリング（既定 30 秒間隔）し、`Status ∈ triggerLanes`（GitHub なら該当ラベル）かつ `Condition = Local`（GitHub なら `conditionLabel` 設定時のみ）かつ `Repo` 設定済みのチケットを検出
2. 対象リポジトリ（`repoConfig[repo].localDirPath`。事前に `git clone` 済みであること）から `workspaces/` に git worktree を作成し、専用ブランチをチェックアウト。`repoConfig[repo].setup` の設定に従い `.env` 等のコピーとセットアップコマンドを実行
3. チケット本文を含むプロンプトで設定したエージェント CLI（`claude -p` / `takt --pipeline` / `opencode run` / `grok -p` / `codex exec` のいずれか）をヘッドレス起動（同時実行は既定 2 件まで）
4. エージェントが実装・テスト・push・`gh pr create` まで実施し、結果 JSON を報告
5. **PR 作成後はレーンを動かさず In Progress のまま CI を監視**（`PR` リンク書き込み）
6. **CI が全部グリーンになったら** レーンを **Human Review** へ移動
7. **コメントでフィードバックを書いてレーンを In Progress に戻す**（Notion ならページコメント、GitHub なら issue コメント）→ コメントを取り込んでやり直し（rework）。同じブランチ・同じ PR が更新される
8. CI が失敗した場合も失敗ログを取り込んで自動修正（同一コミットへの再発火はせず、上限は既定 3 回。超えたら 🆘 を通知して人間待ち）
9. PR のマージ/クローズはツールが検知しない。監視終了は「レーンが Released / Canceled になったら worktree ごと自動掃除」の1本のみ（マージ後の運用はチーム側に委ねる）

失敗時はバックオフ付きリトライ（既定 2 回まで）。それでもダメならページコメント（GitHub なら issue コメント）に ❌ とエラー詳細を残し、カードを人間が編集/移動するまで再実行しません。実行中にカードを In Progress から人間が動かすと、そのエージェントは中断（kill）されます。

opencode / grok / codex は、前回実行の session_id が確認できれば各 CLI のネイティブ resume 機能（`opencode run --session` / `grok --session-id` / `codex exec resume`）でセッションを引き継いで rework します（session_id が拾えない場合は通常起動にフォールバックします）。

### 質問エスカレーション（needs_info）

要件が曖昧・判断が必要など「人間の回答があれば続行できる」場合、エージェントは失敗ではなく**質問**を報告します:

1. レーンは動かさず、ページコメント（GitHub なら issue コメント）に **❓ 要回答**、質問をコメントとして投稿
2. 人間がそのコメントに返信（またはページ/issue にコメント追加、またはページ本文/issue 本文を編集）
3. 次のポーリングで回答を検知し、質問と回答をプロンプトに含めて**自動で再開**

## チケットの書き方

- **Title** と本文に実装内容を書く。本文はそのままプロンプトに入ります
- **Notion**: **Repo** と **Condition = Local** を設定し、**In Progress** に動かす
- **GitHub Issues**: 対象リポジトリの issue に `status:In Progress` ラベル（`conditionLabel` 設定時はそちらも）を付ける
- 動かすと数十秒以内に着手されます
- 失敗後にやり直したいときは、カードを一度別レーンに出して戻す（またはカードを編集する）と再実行されます

## 設定リファレンス（config.json）

すべてのキーはデフォルト値を持ち、部分指定で構いません（deep merge）。`~` はホームに展開されます。

設定は `kanban`（カンバンプロバイダー）・`agent`（コーディングエージェント）・それ以外（プロバイダー非依存の共通設定）の3つに分かれています。各 namespace 内の `provider` が現在有効な実装を示し、それぞれのプロバイダー固有設定は同名のキー（`kanban.notion` / `agent.claude`）にネストします。将来カンバンやエージェントを複数対応する際、破壊的変更の影響は該当 namespace 内に閉じます。

### 共通設定（トップレベル）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `pollIntervalMs` | number | `30000` | カンバンのポーリング間隔 (ms) |
| `maxConcurrent` | number | `2` | 同時実行エージェント数 |
| `branchTemplate` | string | `"feature/notion-{id}/{slug}"` | 作業ブランチ名のグローバルデフォルト。`{id}` = page_id 先頭 8 文字、`{slug}` = タイトルの slug。`repoConfig[repo].branchTemplate` で repo 単位に上書き可能 |
| `setupTimeoutMs` | number | `600000` | セットアップコマンド 1 本あたりの最大実行時間（10 分） |
| `repoConfig` | object | `{}` | リポジトリ単位の設定（clone 元・ローカルパス・worktree セットアップ。下記） |
| `ghCommand` | string | `"gh"` | gh CLI のコマンド名（PR 監視用） |
| `prPollIntervalMs` | number | `60000` | PR 監視（CI/レビュー/マージ）のポーリング間隔 (ms) |
| `autoReworkLimit` | number | `3` | CI 失敗起因の自動修正回数の上限 |
| `promptTemplate` | string | `"prompts/task.md"` | プロンプトテンプレートのパス（絶対パス or `~/.config/baton` 相対。`baton init` で `~/.config/baton/prompts/task.md` にひな形がコピーされる） |
| `systemPromptTemplate` | string | `""` | システムプロンプト追加用テンプレートのパス。`""` で無効。指定時は `promptTemplate` と同じ変数で描画し `claude --append-system-prompt` として渡す（下記） |
| `resumePromptTemplate` | string | `"prompts/resume.md"` | ネイティブセッション resume 時（CI失敗/レビュー対応/needs_info回答で前回 session_id が記録済みの場合）に使う軽量プロンプトのパス。`promptTemplate` と同じ変数を使えるが、セッションが前回文脈を保持している前提でチケット全文（`{{title}}`/`{{body}}`）は再送しない想定（下記） |

### kanban（カンバンプロバイダー）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `kanban.provider` | `"notion" \| "github"` | `"notion"` | 現在有効なカンバン実装 |
| `kanban.triggerLanes` | string[] | `["In Progress"]` | このレーンのチケットを実行対象にする |
| `kanban.doneLane` | string | `"Human Review"` | CI グリーン後の移動先レーン |
| `kanban.terminalLanes` | string[] | `["Released", "Canceled"]` | このレーンに入ったら worktree と state を掃除 |

#### kanban.notion（Notion 固有、`provider: "notion"` 時のみ使用）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `kanban.notion.dataSourceId` | string | `""` | **必須**。対象データソース ID（取得方法は上記） |
| `kanban.notion.conditionProperty` | string | `"Condition"` | 実行条件プロパティ名 (select) |
| `kanban.notion.conditionValue` | string | `"Local"` | この値のチケットのみ実行 |
| `kanban.notion.laneProperty` | string | `"Status"` | レーンプロパティ名 (status) |
| `kanban.notion.repoProperty` | string | `"Repo"` | リポジトリプロパティ名 (select) |
| `kanban.notion.titleProperty` | string | `"Title"` | タイトルプロパティ名 (title) |
| `kanban.notion.prProperty` | string | `"PR"` | PR リンクプロパティ名 (rich_text)。`""` でスキップ |
| `kanban.notion.ntnCommand` | string | `"ntn"` | ntn CLI のコマンド名 |

#### kanban.github（GitHub Issues 固有、`provider: "github"` 時のみ使用）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `kanban.github.owner` | string | `""` | **必須**。対象リポジトリのオーナー（ユーザー名 or Organization 名） |
| `kanban.github.repos` | string[] | `[]` | **必須**。対象リポジトリ名の配列（`owner` 配下の名前のみ、`owner/repo` ではない） |
| `kanban.github.lanePrefix` | string | `"status:"` | レーンを表すラベルのプレフィックス。lane 名は `<lanePrefix><レーン名>` の形のラベルで表現する |
| `kanban.github.conditionLabel` | string | `""` | 追加フィルタ用ラベル（Notion の `conditionProperty`/`conditionValue` 相当）。`""` なら無効（`triggerLanes` のラベルのみで判定） |

### agent（コーディングエージェント）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agent.provider` | `"claude" \| "takt" \| "opencode" \| "grok" \| "codex"` | `"claude"` | 現在有効なエージェント実装 |
| `agent.timeoutMs` | number | `3600000` | 1 試行の最大実行時間（60 分） |
| `agent.maxAttempts` | number | `2` | 最大試行回数（バックオフ付きリトライ） |

#### agent.claude（Claude Code 固有）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agent.claude.command` | string | `"claude"` | claude CLI のコマンド名 |
| `agent.claude.args` | string[] | `["--permission-mode", "bypassPermissions"]` | claude CLI への追加引数 |

#### agent.takt（[takt](https://github.com/nrslib/takt) 固有）

`provider: "takt"` のとき、プロンプトを `--task` 引数として渡した `takt --pipeline ...` をヘッドレス起動します。takt はさらに内部で claude/codex/opencode 等のプロバイダーへ処理を委譲するオーケストレーションCLIです。worktree・branch・commit・push・PR 作成は baton 側と `prompts/task.md` の指示で完結させるため、既定では `--skip-git` を付与して takt 自身のブランチ管理と二重にならないようにしています。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agent.takt.command` | string | `"takt"` | takt CLI のコマンド名 |
| `agent.takt.args` | string[] | `["--pipeline", "--skip-git", "--quiet"]` | takt CLI への追加引数（`--task <prompt>` は自動付与） |

#### agent.opencode（[opencode](https://opencode.ai) 固有）

`provider: "opencode"` のとき、`opencode run [--session <id>] <args> <prompt>` をヘッドレス起動します。プロンプトは引数の末尾に渡されます（stdin ではない）。前回実行の session_id が拾えていれば `--session` で resume します。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agent.opencode.command` | string | `"opencode"` | opencode CLI のコマンド名 |
| `agent.opencode.args` | string[] | `[]` | opencode CLI への追加引数（`run` と `--session`/prompt は自動付与） |

#### agent.grok（[Grok CLI](https://x.ai/cli) 固有）

`provider: "grok"` のとき、`grok [--session-id <id>] <args> -p <prompt>` をヘッドレス起動します。前回実行の session_id が拾えていれば `--session-id` で resume します。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agent.grok.command` | string | `"grok"` | grok CLI のコマンド名 |
| `agent.grok.args` | string[] | `[]` | grok CLI への追加引数（`--session-id`/`-p <prompt>` は自動付与） |

#### agent.codex（[Codex CLI](https://developers.openai.com/codex/cli) 固有）

`provider: "codex"` のとき、`codex exec <args> <prompt>` をヘッドレス起動します。前回実行の session_id が拾えていれば `codex exec resume <id> <args> <prompt>` の形で resume します。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agent.codex.command` | string | `"codex"` | codex CLI のコマンド名 |
| `agent.codex.args` | string[] | `[]` | codex CLI への追加引数（`exec`/`resume <id>`/prompt は自動付与） |

opencode / grok / codex の session_id 抽出は best-effort です（stdout から `session_id` フィールドや `session: <id>` 形式を正規表現で探索）。拾えなくても失敗にはならず、単に resume 引数なしの通常起動になります。

`repoConfig` の例（gitignore された `.env` を持ち込み、依存をインストール）:

```json
"repoConfig": {
  "your-repo": {
    "localDirPath": "~/repos/your-repo",
    "setup": {
      "copy": [".env", "packages/api/.env"],
      "commands": ["bun install"]
    }
  }
}
```

- キーは Notion の **Repo** プロパティに設定した名前（GitHub provider なら `kanban.github.repos` の要素）。
- `localDirPath` は必須。**事前に `git clone` 済みであること**。無ければエラーで停止する。
- `branchTemplate`（省略可）でトップレベルの `branchTemplate` を repo 単位に上書きできる。
- `setup.copy` は clone 元（`localDirPath` の実リポジトリ）基準の相対パスの列挙。ファイル・ディレクトリ両対応（ディレクトリは再帰コピー）。worktree の外へは書き込めない。存在しないパスは警告を出してスキップ。
- `setup.commands` は worktree をカレントに `sh -c` で順次実行。**非ゼロ終了はセットアップ失敗**としてリトライ対象になる。既存 worktree の再利用時はスキップされる。

### システムプロンプトの追加（systemPromptTemplate）

`promptTemplate`（`prompts/task.md`）はチケットごとの作業内容を記述するプロンプトですが、「このツール（baton）を通して呼び出されたエージェントである」という運用ルール自体は毎回共通です。`systemPromptTemplate` にテンプレートファイルを設定すると、`promptTemplate` と同じ変数（`{{title}}`, `{{page_id}}`, `{{page_url}}` など）で描画したうえで `claude --append-system-prompt` として毎回のエージェント起動に注入されます。

例えば `prompts/system.md` を用意し config で `"systemPromptTemplate": "prompts/system.md"` と設定すると:

```md
あなたの呼び出し元は Notion を監視してエージェントに作業を渡すツール（baton）です。
このタスクは Notion ページ {{page_id}}（{{page_url}}）に対応しています。

- 最終的な完了報告は本タスクのプロンプトで指示された result_file への JSON 書き込みで行ってください。
```

- チケット本文（`promptTemplate` の `{{body}}`）とは独立しているため、チケットごとに書き分ける必要はありません。ツール固有の運用ルール・利用可能な補助コマンド・命名規則などをここに集約できます。
- `""`（既定）のときは `--append-system-prompt` を付与せず、`claude` の既定システムプロンプトのみで動作します。

> ⚠️ 既定の `bypassPermissions` はエージェントが確認なしで任意のコマンドを実行できるモードです。挙動を絞りたい場合は `agent.claude.args` を変更してください。

### rework/resume 時のセッション継続方針

やり直し・再開の種別（`ResumeContext.kind`）によって、セッションを新規で始めるかネイティブ resume（`claude --resume` / `codex exec resume` / `--session-id` 等）で前回のセッションを引き継ぐかを分けている:

- **human_rework**（人間がチケット本文を編集して差し戻した）: 常に新規セッション。方向性が変わりうる差し戻しのため、前回セッションの前提を引きずらないようにしている。プロンプトは `promptTemplate`（チケット全文入り）を使う。
- **ci_failure / review_changes / needs_info_answer**: 前回実行の `session_id` が記録されていればネイティブ resume する。この場合プロンプトは `resumePromptTemplate`（`{{rework}}` の差分情報のみ、チケット全文は含まない軽量版）を使う。`session_id` が未記録（抽出できなかった・エージェントが対応していない等）の場合は従来通り `promptTemplate` にフォールバックする。

## 運用

- **稼働状況**: `baton status` — state 上の各ページの状態（running / retry / done / failed / needs_info / PR 監視状況）を表示
- **dry-run**: `baton --once --dry-run` — 候補と dispatch 判定・除外理由を表示（書き込みなし）
- **ログ**（すべて `~/.config/baton` 配下）:
  - `logs/orchestrator.log` — オーケストレーターの JSONL ログ
  - `logs/runs/<page_id>-attempt<N>.log` — エージェントの生ログ（stream-json）
  - `logs/launchd.out.log` / `logs/launchd.err.log` — launchd 経由の標準出力/エラー
- **実行状態**: `~/.config/baton/state/state.json`（自動管理）

### トラブルシューティング

- **起動時に設定エラーで終了する**: `kanban.notion.dataSourceId` / `repoConfig.<repo>.localDirPath` の必須チェックです。表示されたメッセージに従って config.json を修正してください
- **チケットが拾われない**: `baton --once --dry-run` で候補と除外理由を確認。`Condition` が空になっていないか、レーン名・プロパティ名が config と一致しているか
- **一度失敗したチケットが再実行されない**: 仕様です。カードを編集するか動かし直してください（`~/.config/baton/state/state.json` の該当エントリを消しても可）
- **❓ 要回答 のまま進まない**: 質問コメントに**返信**するかページに新規コメント/本文編集をしてください。bot 自身のコメントは回答と見なされません
- **🆘 CI 自動修正が上限に到達**: 人間が PR を直接修正するか、カードを編集して In Progress に戻すと再開できます

## ディレクトリ構成

クリーンアーキテクチャ（Domain / Use Cases / Interface Adapters / Infrastructure の4層、依存は常に内向き）で構成しており、Notion・Claude Code・GitHub・git worktree はすべて Interface Adapters 層の実装として差し替え可能になっています。

```
src/
  domain/               ビジネスルール。外部依存ゼロ、class を使わず型（判別Union）と純粋関数のみ
  use-cases/
    ports/              KanbanPort / CodingAgentPort / CodeHostPort / WorkspacePort / StateRepositoryPort
    orchestrator.ts      中核ユースケース（tick/dispatch/PR監視）。Port経由でのみ外部とやり取りする
    prompt-builder.ts    エージェントへのプロンプト組み立て
  interface-adapters/
    notion/              KanbanPort の Notion 実装（ntn CLI）
    github/               KanbanPort の GitHub Issues 実装 / CodeHostPort の GitHub 実装（gh CLI）
    claude/              CodingAgentPort の Claude Code 実装
    takt/                 CodingAgentPort の takt 実装
    opencode/             CodingAgentPort の opencode 実装
    grok/                 CodingAgentPort の grok 実装
    codex/                CodingAgentPort の codex 実装
    git/                  WorkspacePort の git worktree 実装
    persistence/          StateRepositoryPort の JSON ファイル実装
  infrastructure/        config・logger・プロセス実行・launchd など横断的関心事
  composition.ts          各 Port アダプタを組み立てて Orchestrator を構築する配線
  main.ts                 CLI エントリ
bin/baton.js  npm パッケージの実行エントリ（`#!/usr/bin/env bun`）
prompts/      エージェントに渡すプロンプトテンプレートのひな形（`baton init` で ~/.config/baton にコピー）
config.example.json  設定のサンプル（`baton init` で ~/.config/baton/config.json にコピー）
SPEC.md       詳細仕様
```

パッケージ本体（コード）とは別に、実行時のユーザーデータは `~/.config/baton`（`$XDG_CONFIG_HOME` があればそちら配下）にまとまっています:

```
~/.config/baton/
  config.json   設定（baton init で作成、gitignore 相当で個人管理）
  prompts/      プロンプトテンプレートの実体（編集可）
  workspaces/   チケットごとの git worktree（自動管理）
  state/        実行状態（state.json、結果ファイル）
  logs/         オーケストレーターログ + エージェントごとの生ログ (logs/runs/)、launchd ログ
```

Notion 以外のカンバンや Claude Code 以外のコーディングエージェントに対応する場合は、`interface-adapters/` に新しい実装（例: `interface-adapters/jira/jira-kanban-adapter.ts`）を追加し、`composition.ts` の配線を差し替えるだけで済みます。`use-cases/orchestrator.ts` の変更は不要です。

## 制限事項

- **GitHub 前提**: PR 作成・CI/レビュー/マージの監視は gh CLI（GitHub）に依存します。GitLab 等には対応していません
- **launchd は macOS のみ**: 他 OS では `baton` をフォアグラウンドで手動起動するか、任意のプロセスマネージャで常駐させてください
- **CI 監視は GitHub Actions のログ取得に最適化**: 外部 CI（CircleCI 等）は check 名と URL のみプロンプトに渡されます
- Notion へのアクセスは ntn CLI、認証は ntn の keychain 管理に依存します
