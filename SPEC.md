# baton 仕様書

Notion Kanban をイシュートラッカーとして使い、チケットが特定レーンに移動したら
ローカルで Claude Code を起動して実装 → PR 作成 → Notion 更新まで自動化する常駐デーモン。
[openai/symphony SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) のアーキテクチャを参考にする。

## 全体像

```
┌─────────────┐  poll (ntn CLI)   ┌──────────────────┐
│ Notion Kanban│ ◄───────────────► │  Orchestrator     │
│ (レーン=In    │                   │  (Bun/TypeScript) │
│  Progress)   │                   └────────┬─────────┘
└─────────────┘                            │ dispatch
                                           ▼
                              ┌────────────────────────┐
                              │ Workspace (git worktree)│
                              │  └─ claude -p <prompt>  │──► PR 作成 (gh)
                              └────────────────────────┘
```

## 技術スタック

- **ランタイム**: Bun (>=1.3) + TypeScript。実行時依存は `zod`（外部境界のパース）と `ts-pattern`（判別Unionの網羅マッチ）のみ最小限で採用。devDependencies は typescript のみ。
- **Notion アクセス**: `ntn` CLI をサブプロセスとして呼ぶ（認証は ntn が keychain で管理済み）。
- **エージェント**: `claude` CLI をヘッドレスモード (`-p`) で起動。
- **プロセス管理**: `node:child_process` の `spawn`（Bun 互換）。Bun 固有 API は使わない（`Bun.file` 等禁止）。ただし entry の実行は `bun src/main.ts`。

## 対象 Notion データベース

- database_id: `<YOUR_DATABASE_ID>`（DB ページの URL に含まれる ID）
- data_source_id: `<YOUR_DATA_SOURCE_ID>`（`ntn datasources resolve <database_id>` で解決。config の `kanban.notion.dataSourceId` に設定する）
- プロパティ（名前はすべて config で変更可能。`""` を設定すると読み書きをスキップ）:
  - `Title` (title)
  - `Status` (status): 例 TODO / In Progress / Human Review / In Delivery / Released / Canceled
  - `Repo` (select): 対象リポジトリ名
  - `Condition` (select): 実行条件。例 Local / Cloud
  - `PR` (rich_text), `Activity` (rich_text)

## ディスパッチ条件（candidate）

以下をすべて満たすページが実行候補:

1. `Status` が `config.kanban.triggerLanes` のいずれか（デフォルト `["In Progress"]`）
2. `Condition` が `config.kanban.notion.conditionValue`（デフォルト `"Local"`）と一致
3. `Repo` が設定されている
4. ローカル state 上で running でない
5. state 上 done / failed の場合、ページの `last_edited_time` が記録時より新しければ**再ディスパッチ可（rework）**。人間がカードを編集またはレーンを差し戻したら再実行（下記「差し戻し再実行 (rework)」参照）
6. state 上 needs_info の場合、質問時刻より新しい非 bot コメント（回答）またはページ本文編集があれば**再ディスパッチ可（再開）**（下記「質問エスカレーション (needs_info)」参照）
7. グローバル同時実行スロット (`config.maxConcurrent`, デフォルト 2) に空きがある（トップレベル、プロバイダー非依存）

ソート順: `created_time` 昇順 → page_id 辞書順。

クエリは ntn のサーバーサイドフィルタを使う:

```sh
ntn datasources query <DATA_SOURCE_ID> --json --limit 100 --filter '{
  "and": [
    {"property": "Condition", "select": {"equals": "Local"}},
    {"or": [{"property": "Status", "status": {"equals": "In Progress"}}]}
  ]
}'
```

（triggerLanes が複数なら or を組み立てる。ページネーション: `has_more` が true なら `--start-cursor` で追いかける。）

## 状態機械（ページ単位）

symphony と同様にオーケストレーター内部状態を持つ:

- **Unclaimed**: 候補。スロットが空けば dispatch。
- **Running**: claude プロセス実行中。
- **RetryQueued**: 失敗後、バックオフタイマー待ち。`delay = min(10000 * 2^(attempt-1), 300000)` ms。
- **Done**: 成功終了。
  - PR なし成功: lane を doneLane に移動済み。
  - PR あり成功: lane は動かさず `prWatch` サブオブジェクトを付けて PR 監視中（下記「PR フィードバックループ」）。CI 全グリーンで doneLane へ移動し `prWatch.phase` を `"review"` に進める。
  - いずれも、記録した last_edited_time より新しい編集（差し戻し）があれば human rework として再ディスパッチ。
- **Failed**: `agent.maxAttempts`（デフォルト 2）失敗。ページの last_edited_time が変わるまで再実行しない。変わったら rework として再ディスパッチ。
- **NeedsInfo**: エージェントが `needs_info` を報告して人間の回答待ち。lane は動かさない。質問時刻（questionAskedAt）より新しい非 bot コメント、またはページ本文編集で自動再開（下記「質問エスカレーション」）。

```
running ─┬ failure(<max) → retry_queued ─timer→ running
         ├ failure(>=max) → failed ──人間編集──→ rework(attempt=1)
         ├ success(PRなし) → done [レーン→doneLane]
         ├ success(PRあり) → done + prWatch(phase:"ci") [レーン維持]
         └ needs_info → needs_info [レーン維持, ❓ + 質問コメント]

needs_info: 非botコメント(> questionAskedAt) or ページ本文編集 → 再dispatch(attempt=1, 回答注入)
prWatch(ci):     CI全green → phase:"review" [レーン→doneLane]
                 CI failed & SHA未対応 & count<limit → 自動rework(ci_failure, count+1)
                 CI failed & 同一SHA対応済み → 何もしない / count>=limit → awaitingHuman=true, 🆘通知1回
prWatch(review): CHANGES_REQUESTED(submittedAt > handledReviewAt) → 自動rework(review_changes)
prWatch(*):      MERGED → prWatch削除 [レーン→mergedLane, 🚀] / CLOSED(unmerged) → prWatch削除 [通知のみ]
done/failed/needs_info & レーン∈terminalLanes → terminalCleanup で state削除+worktree掃除
```

state は `state/state.json` に永続化（毎変更時に atomic write: tmp に書いて rename）。スキーマ:

```jsonc
{
  "version": 1,
  "pages": {
    "<page_id>": {
      "status": "running" | "retry_queued" | "done" | "failed" | "needs_info",
      "attempt": 1,
      "lastEditedTime": "...",     // done/failed/needs_info 記録時のページ last_edited_time
      "branch": "feature/notion-xxxx/slug",
      "workspace": "/abs/path",
      "repoDir": "/abs/path",      // worktree 削除に使うメインリポジトリのパス
      "prUrl": "https://github.com/...",
      "retryAt": 0,                 // retry_queued: バックオフ満了時刻 (epoch ms)
      "questionAskedAt": "ISO8601", // needs_info: 質問投稿時刻（回答判定の基準）
      "question": "...",            // needs_info: エージェントの質問（再開時に再掲）
      "prWatch": {                  // done + PR あり: PR 監視状態
        "prUrl": "https://github.com/...",
        "phase": "ci" | "review",
        "headSha": "...",           // ci_green 時点の head SHA
        "reworkedSha": "...",       // この SHA の CI 失敗は対応済み（再発火防止）
        "autoReworkCount": 0,       // CI 起因 rework 累計。human/review rework で 0 リセット
        "handledReviewAt": "...",   // 処理済み CHANGES_REQUESTED の最新 submittedAt
        "awaitingHuman": false      // CI rework 上限到達。人間編集でのみ解除
      },
      "updatedAt": "ISO8601"
    }
  }
}
```

再起動リカバリ: 永続 DB なし。起動時に state.json を読み、`running` だったページ（孤児）を result_file の有無で振り分ける:

- result_file が `success` → 完遂済みとみなし done に確定し、Notion 反映（PR あり: PR リンク書き込み/CI 待ち、PR なし: doneLane 移動）をベストエフォートで実行（二重実行防止）。
- result_file が `needs_info`（question あり）→ needs_info に確定し、質問コメント投稿までベストエフォートで実行。
- それ以外（result_file なし / failure）→ 本当に中断された扱いで `retry_queued`（attempt 据え置き、即時再試行可）に落とす。

ワークスペースは再利用する。

## Tick シーケンス（pollIntervalMs ごと、デフォルト 30000ms）

1. **Reconcile**: running 中ページを個別に `GET /v1/pages/{id}` で再取得。
   - レーンが triggerLanes 外に人間が動かした → claude プロセスに SIGTERM（5秒後 SIGKILL）→ state から claim 解放（statusは記録しない=Unclaimed相当に戻すが、doneLaneに自分で動かした直後のrace を避けるため、オーケストレーター自身が動かしたページは対象外）。
   - アーカイブ/削除済み → 同様に kill & 解放。
2. **Terminal cleanup**: state 上 done/failed/needs_info のページでレーンが terminalLanes (Released/Canceled) に入ったものは、worktree を `git worktree remove --force` で削除し state からエントリ削除。
3. **prReconcile（PR 監視）**: `status==="done" && prWatch あり && !awaitingHuman && 非 active` のページを gh CLI でポーリングし、CI/レビュー/マージの状態変化を処理する（下記「PR フィードバックループ」）。tick ごとに呼ばれるが実際のポーリングは `prPollIntervalMs`（デフォルト 60000ms）間隔でゲート。
4. **候補取得**: 上記フィルタクエリ。
5. **checkNeedsInfoAnswers**: 候補のうち state 上 needs_info のページについて、questionAskedAt より新しい非 bot コメント（= 人間の回答）の有無を確認する（下記「質問エスカレーション」）。needs_info ページが候補に存在する tick でのみコメント取得が飛ぶ。
6. **Dispatch**: ソート順にスロットが埋まるまで起動（retry_queued はタイマー満了で eligible になる）。

tick 中の tracker エラー（ntn 非ゼロ終了）は tick をスキップしてログに残し、次の tick で再試行。クラッシュしない。

## Dispatch フロー（1ページ）

1. **Claim**: state に running 記録。Notion 更新:
   - `Activity` = `🤖 Claude Code 実行開始 (attempt N) — HH:MM`
2. **リポジトリ解決**:
   - リポジトリ名 → `config.repoConfig[名前]` を引く（無ければエラー）。ローカルディレクトリは `entry.localDirPath`。
   - ディレクトリが存在しない → エラーとして扱う（`entry.localDirPath` に事前に `git clone` しておく前提）。
3. **Workspace 作成** (git worktree):
   - `git -C <repo> fetch origin --prune`
   - デフォルトブランチ検出: `git -C <repo> symbolic-ref refs/remotes/origin/HEAD --short`（失敗時は `git remote show origin` fallback、それも失敗なら `main`）
   - ブランチ名: `entry.branchTemplate ?? config.branchTemplate`（デフォルト `feature/notion-{id}/{slug}`）。`{id}` = page_id 先頭8文字（ハイフン除去後）、`{slug}` = タスクタイトルの sanitize（`[A-Za-z0-9._-]` 以外を `-` に、連続 `-` 圧縮、先頭末尾 trim、小文字化、最大40文字。空になったら `task`）。
   - worktree パス: `<projectRoot>/workspaces/<repo名>/<{id}-{slug}>`
   - 既存 worktree があれば再利用（symphony 同様、清掃しない）。branch が既存なら `git worktree add <path> <branch>`、なければ `git worktree add <path> -b <branch> origin/<default>`。
   - **安全不変量**: worktree パスは必ず workspaces ルート配下であることを resolve して検証。
4. **プロンプト構築**:
   - ページ本文: `ntn pages get <page_id>` で Markdown 取得（失敗しても本文なしで続行）。
   - `config.promptTemplate`（デフォルト `prompts/task.md`。絶対パス or projectRoot 相対）テンプレートの `{{title}}`, `{{body}}`, `{{repo}}`, `{{branch}}`, `{{base_branch}}`, `{{page_url}}`, `{{page_id}}`, `{{result_file}}`, `{{attempt}}`, `{{rework}}` を置換（`{{rework}}` は resume 時のみ非空）。
   - `config.systemPromptTemplate`（デフォルト `""` = 無効）が設定されていれば、同じ変数セットで同様に描画し、追加のシステムプロンプトとして用意する（`{{body}}` や `{{rework}}` を含む同じ変数を使えるが、通常はチケット非依存の運用ルール — 呼び出し元の説明・利用可能な補助コマンド等 — を書く用途を想定）。
   - `result_file` = `<projectRoot>/state/results/<page_id>.json`（ディスパッチ前に前回分を削除）。
5. **claude 起動**:
   - cwd = worktree パス
   - `claude -p <prompt> --output-format json` + （`config.systemPromptTemplate` 設定時は `--append-system-prompt <描画結果>`） + `config.agent.claude.args`（デフォルト `["--permission-mode", "bypassPermissions"]`）
   - プロンプトは argv ではなく stdin で渡す（長文対策）: `claude -p --output-format json ... < promptfile` 相当。spawn の stdin に書き込む。
   - stdout/stderr は `logs/runs/<page_id>-attempt<N>.log` にストリーム追記。
   - タイムアウト: `config.agent.timeoutMs`（デフォルト 3,600,000 = 60分）。超過で SIGTERM→SIGKILL、試行失敗。
6. **結果判定**（優先順）:
   1. result_file が存在し JSON として読めたらそれを採用:
      `{"status": "success"|"failure"|"needs_info", "pr_url": "...", "summary": "...", "question": "..."}`。
      - `status: "success"` は `pr_url` を省略できる（調査・分析のみでコード変更が
        不要なタスクなど、PR を作らずに正当に完了するケース）。この場合も失敗
        扱い・リトライにはしない。
      - `status: "needs_info"` は `question` 必須。question が空の needs_info は
        不正として failure に落とす（人間が何に答えればいいか分からないため）。
   2. result_file が無ければ exit code 0 かつ claude の JSON 出力 (`is_error: false`)
      → stdout から `https://github.com/<org>/<repo>/pull/<num>` を正規表現抽出。
      見つかれば success、見つからなければ failure（"PR URL が確認できない"）。
      このフォールバック経路は明示的な意思表示（result_file）が無いため、
      PR URL 不在は常に failure とする。
   3. それ以外 → failure。
7. **成功時の Notion 更新**:
   - **`pr_url` がある場合**（CI 待ちへ。レーンは動かさない）:
     - `PR` = pr_url（rich_text, link付き）
     - `Activity` = `✅ PR 作成完了 — CI 待ち (HH:MM)`
     - state を done + `prWatch(phase:"ci")` に。doneLane への移動は CI 全グリーンを
       prReconcile が検知したとき（「PR フィードバックループ」参照）。
   - **`pr_url` が無い場合**（従来どおり即完了）:
     - `Status` = `config.kanban.doneLane`（デフォルト `"Human Review"`）
     - `Activity` = `✅ 完了（PRなし） — HH:MM`
   - いずれもページコメント追加 (`POST /v1/comments`): summary + PR URL（あれば） + 実行時間。
   - 最後にページを再取得して `last_edited_time` を記録（自分の更新分を取り込む。
     rework 判定の基準時刻）。
8. **失敗時**:
   - attempt < maxAttempts → retry_queued（バックオフ）。`Activity` = `⚠️ 失敗 (attempt N/M)、リトライ待ち: <短いエラー>`
   - attempt >= maxAttempts → failed。`Activity` = `❌ 失敗 (attempt N/M): <短いエラー>`、レーンは動かさない。ページコメントにエラー詳細（ログ末尾 ~1000字）を投稿。state に failed + そのページの last_edited_time を記録。
   - Notion 更新自体の失敗はログして続行（オーケストレーションを止めない）。

## 差し戻し再実行 (rework)

人間が Human Review のカードをレビューし、フィードバックを書いて In Progress に戻すとやり直しさせられる。

- **検出**: state 上 done / failed のページが候補クエリ（レーン = triggerLanes）に現れ、かつページの
  `last_edited_time` が done/failed 記録時（自分の更新反映後に再取得した値）より新しい場合。
  レーン移動自体が `last_edited_time` を進めるので、レーンを戻すだけでも発火する。
  逆に成功直後に結果整合性で古い lane が返ってきても、記録値以下なので二重実行しない。
- **attempt リセット**: rework は新しいラウンドとして attempt = 1 から開始（リトライ上限に達した failed でもやり直せる）。
- **フィードバック取り込み**: 差し戻し以降（記録時刻より後）に書かれたページコメントを
  `GET /v1/comments?block_id={page_id}` で取得し、プロンプト先頭の rework セクションに列挙する。
  bot 自身のコメントは `GET /v1/users/me` の ID で除外（コメントは page の last_edited_time を進めないため、
  時刻だけでは自分の完了コメントを除外しきれない）。コメント取得失敗は空扱いで続行（ベストエフォート）。
- **プロンプト**: `prompts/task.md` の `{{rework}}` に、前回 PR の URL・フィードバックコメント・
  「既存ブランチに追加コミットして同じ PR を更新せよ（閉じられている場合のみ新規 PR）」という指示を差し込む。
  通常実行では空文字。
- **workspace**: 既存 worktree / ブランチを再利用するため、追加コミットは同じ PR に反映される。
- **旧 state の救済**: done なのに `lastEditedTime` 未記録のページ（旧バージョン/記録前クラッシュ）は、
  候補に現れた時点で現在値をバックフィルして今回はスキップ（安全側）。次の人間の編集から rework 可能。

## PR フィードバックループ

PR あり成功後、`state=done` + `prWatch` サブオブジェクトで PR を監視し、CI 失敗・レビュー指摘への
自動対応とマージ検知を行う。実装: `src/use-cases/orchestrator.ts` の `prReconcile` /
`handlePrWatchAction` / `dispatchAutoRework`、判定の中核は `src/domain/review.ts` の
純粋関数 `decidePrWatchAction`。

### 監視（prReconcile）

- 対象: `status==="done" && prWatch あり && !prWatch.awaitingHuman && 非 active` のページ。
- tick ごとに呼ばれるが、実際のポーリングは `config.prPollIntervalMs`（デフォルト 60000ms）で
  ゲート（インメモリ時刻。tick より粗い間隔）。
- 1 ページにつき `gh pr view <url> --json state,mergedAt,reviewDecision,statusCheckRollup,headRefOid`
  を 1 コール。`phase:"review"` のときのみ `--json reviews` を追加取得。
- gh / ntn の失敗はページ単位で warn して continue（次回ポーリングで再試行）。

### 判定（decidePrWatchAction, 優先順）

1. **merged**: `state===MERGED`（または `mergedAt` あり）→ prWatch 削除、レーン = `config.kanban.mergedLane`
   （デフォルト `"In Delivery"`）、`Activity` = 🚀、コメント通知。
2. **closed**: `state===CLOSED`（unmerged）→ prWatch 削除。レーンは動かさず ⏹ 通知のみで監視終了。
3. **awaitingHuman**: 何もしない（防御。呼び出し側でも除外済み）。
4. **review_rework**（`phase:"review"` のみ）: `reviewDecision===CHANGES_REQUESTED` かつ
   `submittedAt > handledReviewAt` の CHANGES_REQUESTED レビューがある →
   レビュー本文（+ ベストエフォートでインラインコメント `gh api .../pulls/{n}/comments`）を
   プロンプトに注入して自動 rework。レーンを `triggerLanes[0]` に戻す。
   `handledReviewAt` を最新 submittedAt に更新（再発火防止）し、`autoReworkCount` を 0 リセット
   （レビュー対応で CI rework 予算を回復）。
5. **CI 失敗**（phase 不問）: 失敗 check があり、
   - `headSha === reworkedSha`（この SHA は対応済み）→ 何もしない（再発火防止）。
   - `autoReworkCount >= config.autoReworkLimit`（デフォルト 3、トップレベル）→ **ci_limit**:
     `awaitingHuman=true` にして以後ポーリング対象外。🆘 Activity + 失敗 check 一覧の
     コメントを **1 回だけ** 通知。人間の編集（human rework）でのみ解除される。
   - それ以外 → **ci_rework**: 失敗 check のログ（GitHub Actions は
     `gh run view <id> --log-failed`、check あたり 3000 字・合計 8000 字で切り詰め。外部 CI は
     check 名 + URL のみ）をプロンプトに注入して自動 rework。`reworkedSha = headSha`、
     `autoReworkCount += 1`。
6. **CI 実行中**（pending あり）: 何もしない。
7. **全グリーン**: `phase:"ci"` なら **ci_green** → `phase:"review"` へ遷移、
   レーン = `config.kanban.doneLane`（現レーンが triggerLanes 内のときのみ移動。人間が動かした
   レーンは上書きしない）。`phase:"review"` なら何もしない（レビュー待ち）。

チェック正規化: `statusCheckRollup` の CheckRun 形（status/conclusion）と StatusContext 形
（state）の混在を pending/success/failure に正規化。不明値は pending（不用意な自動 rework を
避ける保守的選択）。rollup が null/欠落（CI 未設定リポジトリ）は checks 空 = グリーン扱い。

### 自動 rework（dispatchAutoRework）

- 候補クエリ非経由: `getPage` + `parseTicket` して直接 dispatch（attempt=1）。
- 順序は「スロット確認 → 再発火防止マーカー（reworkedSha / handledReviewAt）persist →
  dispatch」。スロット満杯/シャットダウン中ならマーカーを進めず次回へ持ち越し。
  マーカーを dispatch 起動前に persist するのは、クラッシュ時に「rework されない」側へ
  倒すため（二重 rework 防止を優先）。
- review_rework で自分がレーンを動かした直後に結果整合性で古いレーンが返っても reconcile に
  殺されないよう、active entry は `dispatchedByUs=true` で登録。
- rework 成功時（onSuccess）に prWatch を再アーム: `phase:"ci"` に戻し、`autoReworkCount` は
  ci_failure 起因の rework のときのみ維持（他は 0 リセット）。reworkedSha / handledReviewAt は
  常に引き継ぐ（push なし success の同一 SHA 再発火・処理済みレビューの無限 rework を防ぐ）。
  awaitingHuman は引き継がない（rework 成功 = 人間介入の結果として自然解除）。
- 監視中に人間がカードを編集すると既存の last_edited_time 比較で human rework が発火する
  （人間介入優先）。

## 質問エスカレーション (needs_info)

要件不明・判断が必要など「人間の回答があれば続行できる」場合、エージェントは failure ではなく
result_file に `{"status": "needs_info", "question": "..."}` を書いて質問する。

- **受理**: question 必須（空なら failure に落とす）。state を `needs_info` にし、branch /
  workspace / prUrl / prWatch は保持（回答後に同じ worktree で再開し、PR 監視状態も失わない。
  `status !== "done"` の間は prReconcile 対象外）。
- **Notion 反映**: レーンは動かさない。`questionAskedAt = now` を**コメント投稿前に確定** →
  `Activity` = `❓ 要回答 — 質問をコメントに投稿 — HH:MM` → 質問をページコメントに投稿
  （「返信すると自動で再開します」の案内付き）→ ページ再取得で `lastEditedTime` を記録
  （自分のプロパティ更新を「人間の本文編集」と誤検知しないため）。
- **再開検知**（tick の checkNeedsInfoAnswers + decideEligibility）:
  - `questionAskedAt` より新しい**非 bot** コメントが 1 件以上（bot 自身の質問コメントは
    `GET /v1/users/me` の ID で除外）→ 回答ありとして再ディスパッチ。
  - またはページ本文の編集（`last_edited_time > lastEditedTime`）でも再開（回答を本文に
    書いたケース。回答コメントがあれば一緒に取り込む）。
  - コメント確認は needs_info ページが候補に存在する tick でのみ実行（無駄なポーリング防止）。
    取得失敗は「回答なし」扱いで warn 続行。
- **再開**: attempt=1 の resume（`kind:"needs_info_answer"`）として dispatch。プロンプト先頭に
  「あなたの質問」+「人間の回答（questionAskedAt 以降の非 bot コメント）」+ 再開時の作業条件を
  注入する。回答を読んでもなお続行できない場合のみ再度 needs_info を報告させる。
- **failure との使い分け**（prompts/task.md に明記）: 人間の回答があっても続行できない技術的
  問題は failure、人間の判断・情報で解決するもの（仕様の選択・要件確認・権限付与依頼等）は
  needs_info。

## Notion 書き込み API（ntn 経由）

- プロパティ更新: `ntn api /v1/pages/{page_id} -X PATCH -d '<json>'`
  - rich_text: `{"Activity": {"rich_text": [{"text": {"content": "..."}}]}}`
  - PR リンク: `{"PR": {"rich_text": [{"text": {"content": url, "link": {"url": url}}}]}}`
  - status: `{"Status": {"status": {"name": "Human Review"}}}`
- コメント: `ntn api /v1/comments -X POST -d '{"parent": {"page_id": "..."}, "rich_text": [{"text": {"content": "..."}}]}'`
- ntn 呼び出しは共通ラッパー関数経由（timeout 30s、非ゼロ終了は stderr 含む Error を投げる）。

## dry-run モード

`--dry-run`: Notion への書き込み・claude 起動・git 操作を一切せず、「何をするか」をログに出すだけ。候補一覧と dispatch 判定を表示。読み取り（query, page get）は行う。

`--once`: 1 tick だけ実行して終了（dry-run と組み合わせ可）。

## CLI

```
bun src/main.ts [--once] [--dry-run] [--config <path>]
bun src/main.ts status    # state.json とrunning プロセスの概況を表示して終了
```

## 設定 (config.json)

プロジェクトルートの `config.json`。起動時に読み込み。**tick ごとに mtime を確認し、変わっていたら再読込**（symphony の動的リロード相当。パース失敗時は直前の設定で継続しエラーログ）。

設定は `kanban`（カンバンプロバイダー）・`agent`（コーディングエージェント）・トップレベル（プロバイダー非依存の共通設定）に分かれる。各 namespace の `provider` が現在有効な実装を示し、プロバイダー固有設定は同名キー（`kanban.notion` / `agent.claude`）にネストする。将来複数プロバイダーに対応する際、破壊的変更の影響は該当 namespace 内に閉じる。

```jsonc
{
  // ポーリング・並列度
  "pollIntervalMs": 30000,
  "maxConcurrent": 2,

  // リポジトリ・ワークスペース（キーごとに localDirPath が必須、事前に git clone 済みであること。
  // validateConfig が起動時に検証。不足していれば全件表示して exit(1)）
  "repoConfig": {
    "notion-repo-name": {
      "localDirPath": "~/repos/local-dir-name",
      "branchTemplate": "feature/notion-{id}/{slug}",  // 省略時はトップレベル branchTemplate にフォールバック
      "setup": { "copy": [".env"], "commands": ["bun install"] }
    }
  },
  "branchTemplate": "feature/notion-{id}/{slug}",
  "setupTimeoutMs": 600000,
  "promptTemplate": "prompts/task.md",
  "systemPromptTemplate": "",  // "" = 無効。設定すると promptTemplate と同じ変数で描画し claude --append-system-prompt として付与

  // 外部 CLI
  "ghCommand": "gh",

  // PR フィードバックループ
  "prPollIntervalMs": 60000,
  "autoReworkLimit": 3,

  // カンバン
  "kanban": {
    "provider": "notion",

    // レーン（プロバイダー非依存の概念）
    "triggerLanes": ["In Progress"],
    "doneLane": "Human Review",
    "mergedLane": "In Delivery",
    "terminalLanes": ["Released", "Canceled"],

    // Notion 固有（プロパティ名・データソース・CLI）
    "notion": {
      "dataSourceId": "<YOUR_DATA_SOURCE_ID>",  // 必須
      "laneProperty": "Status",
      "titleProperty": "Title",
      "repoProperty": "Repo",
      "conditionProperty": "Condition",
      "conditionValue": "Local",
      "prProperty": "PR",
      "activityProperty": "Activity",
      "ntnCommand": "ntn"
    }
  },

  // エージェント
  "agent": {
    "provider": "claude",
    "timeoutMs": 3600000,
    "maxAttempts": 2,
    "claude": {
      "command": "claude",
      "args": ["--permission-mode", "bypassPermissions"]
    }
  }
}
```

`~` はホームに展開する。config はすべてデフォルト値を持ち、部分指定でよい（deep merge）。
必須項目の検証は純粋関数 `validateConfig` が行い、起動時（run / dry-run）は不足を全件表示して
exit(1)、ホットリロード時は warn のみで継続する（`loadConfig` 自体は throw しない）。
配布用サンプルは `config.example.json`（`cp config.example.json config.json` から編集する）。

## ロギング

- `logs/orchestrator.log` に JSONL 追記: `{ts, level, event, page_id?, msg, ...}`
- 同内容を人間可読形式で stdout にも出す（`HH:MM:SS INFO event msg`）。
- 主要 event: `tick`, `candidates`, `claim`, `workspace_ready`, `agent_start`, `agent_exit`, `success`, `retry`, `failed`, `needs_info`, `resume`, `pr_watch`, `auto_rework`, `reconcile_kill`, `cleanup`, `config_reload`, `tracker_error`
- claude の生出力は `logs/runs/<page_id>-attempt<N>.log`。

## シグナル処理

SIGINT/SIGTERM 受信時: 新規 dispatch 停止 → running の claude 全員に SIGTERM → 最大10秒待って SIGKILL → state を書いて exit。running だったページは state 上 running のまま残り、次回起動時に retry_queued へ。

## ファイル構成

クリーンアーキテクチャ（Domain / Use Cases / Interface Adapters / Infrastructure の4層、
依存は常に内向き）。Notion・Claude Code・GitHub・git worktree・JSON永続化はすべて
Interface Adapters 層の実装であり、対応する Port（`use-cases/ports/`）経由でのみ
`use-cases/orchestrator.ts` から呼ばれる。class は使わず、関数ファクトリ + クロージャで
アダプタを構成し、状態は判別Unionで表現する。外部境界の値は zod でパースし、
判別Unionの網羅マッチには ts-pattern を使う。

```
baton/
  SPEC.md
  README.md
  config.example.json   # 配布用サンプル（cp して config.json に）
  config.json           # (gitignore) 実際の設定
  package.json          # {"scripts": {"start": "bun src/main.ts", "once": "bun src/main.ts --once", "dry-run": "bun src/main.ts --once --dry-run", "status": "bun src/main.ts status", "test": "bun test test/", "typecheck": "bun x tsc --noEmit"}}
  tsconfig.json         # strict: true
  prompts/task.md
  src/
    main.ts                 # entry: CLI parse, validateConfig, poll loop, signal handling
    composition.ts          # 各 Port アダプタを組み立てて Orchestrator を構築する配線（DI root）
    domain/                 # ビジネスルール。外部依存ゼロ、class を使わず型（判別Union）と純粋関数のみ
      ticket.ts             # Ticket 型（カンバンプラットフォーム非依存のチケット表現）
      state.ts              # PageStatus / PageState 型（状態機械の型定義）
      eligibility.ts        # decideEligibility（dispatch 可否判定の純粋関数）
      review.ts             # PrCheck 正規化, decidePrWatchAction（PR 監視判定の純粋関数）
      workspace.ts          # slugify, ブランチ名/worktree パス生成（安全不変量の検証含む）
      agent-result.ts       # AgentResult 型・zod スキーマ（result_file のパース）
      backoff.ts            # computeBackoff（リトライバックオフ計算）
      errors.ts             # 例外クラス（instanceof ナローイングのため唯一 class を使う箇所）
    use-cases/
      ports/                 # KanbanPort / CodingAgentPort / CodeHostPort / WorkspacePort / StateRepositoryPort
      orchestrator.ts         # 中核ユースケース。tick, 状態機械, dispatch/retry/reconcile/cleanup,
                               # prReconcile/handlePrWatchAction/dispatchAutoRework, needs_info。
                               # Port 経由でのみ外部とやり取りする
      prompt-builder.ts       # プロンプトレンダリング（resume セクション含む）
    interface-adapters/
      notion/notion-kanban-adapter.ts        # KanbanPort の実装（ntn ラッパー: queryCandidates,
                                              # getPage, getPageMarkdown, updateProperties,
                                              # addComment, listComments, ページJSON→Ticket パース）
      claude/claude-code-agent-adapter.ts    # CodingAgentPort の実装（claude spawn, 結果判定）
      github/github-code-host-adapter.ts     # CodeHostPort の実装（gh ラッパー: PR スナップショット/
                                              # レビュー/失敗ログ取得）
      git/git-worktree-adapter.ts            # WorkspacePort の実装（repoConfig 解決,
                                              # worktree 作成/削除, repoConfig[repo].setup）
      persistence/json-file-state-repository.ts  # StateRepositoryPort の実装（state.json load/save, atomic）
    infrastructure/          # 横断的関心事
      config.ts              # 型定義 + load/merge/reload + validateConfig
      process-runner.ts      # 汎用 spawn ヘルパー (timeout, capture)。shell を経由しない
      logger.ts              # ロガー
      format.ts              # expandHome, sleep, nowIso 等
  test/
    domain/**, use-cases/**, interface-adapters/**, infrastructure/**  # bun test。
    純粋関数中心（slugify, ブランチ名, ページJSONパース, 結果判定, フィルタJSON組み立て,
    バックオフ計算, decidePrWatchAction, eligibility）+ アダプタの薄い統合テスト
  scripts/
    install-launchd.sh              # launchd 登録（ラベルは BATON_LABEL で変更可）
    uninstall-launchd.sh
    baton.plist.template            # __LABEL__ 等のプレースホルダを install 時に置換
  state/    (gitignore, 中身)
  logs/     (gitignore, 中身)
  workspaces/ (gitignore, 中身)
```

## 実装上の注意

- すべてのコメント・ログメッセージは英語または日本語どちらでもよいが一貫させる（日本語推奨、コードの識別子は英語）。
- `infrastructure/process-runner.ts` の spawn ヘルパーは shell を経由しない（`spawn(cmd, args)` 形式、shell injection 防止）。プロンプトや Notion 由来の文字列を argv に渡すときも配列渡しなので安全だが、git ブランチ名などは必ず sanitize 済みの値のみ使う。
- ntn の JSON 出力は stdout のみパースする（stderr に警告が出ることがある）。
- Notion ページ JSON → 内部 `Ticket` 型: `{pageId, url, title, lane, repo, condition, lastEditedTime, createdTime}`。rich_text/title は plain_text を連結。
- テストは ntn / claude / git を実際に呼ばない。純粋関数と、`CommandRunner`（`process-runner.ts` が実装する型）をスタブ注入できる形にした薄い統合テストのみ。
