import { match } from "ts-pattern";
import type { PageState } from "./state.ts";
import type { Ticket } from "./ticket.ts";

/** decideEligibility が必要とする設定値のみを narrow に受け取る（Config 全体には依存しない）。 */
export interface EligibilityConfig {
  triggerLanes: string[];
  /** null は「condition チェックなし」（例: GitHub provider は Ticket.condition が常に null）。 */
  conditionValue: string | null;
  /**
   * true のとき operatorUserId と ticket.authorId が一致するチケットのみ dispatch 対象。
   * 未指定時はフィルタなし（テスト互換）。
   */
  onlyOwnTickets?: boolean;
  /** カンバン上の操作者 ID（getBotUserId の戻り値）。onlyOwnTickets 時に使用。 */
  operatorUserId?: string | null;
}

/** needs_info variant を型で narrow して取り回すためのエイリアス。 */
export type NeedsInfoState = Extract<PageState, { status: "needs_info" }>;

/**
 * eligible 判定で決まる「なぜ dispatch するか」の ADT。
 * - fresh: 通常実行（未処理 / retry_queued 満了）。attempt = prev.attempt+1（未処理なら 1）。
 * - human_rework: 人間による差し戻し（done/failed 編集後）。attempt=1、新規セッション。
 * - needs_info_answer: 質問への回答検知で再開。attempt=1、ネイティブ resume 可。
 *   source state を needs_info に narrow しているため questionAskedAt/question に
 *   optional chaining なしで届く。
 */
export type RunPlan =
  | { kind: "fresh" }
  | { kind: "human_rework"; from: PageState }
  | { kind: "needs_info_answer"; from: NeedsInfoState };

/**
 * dispatch 実行の入力 ADT。RunPlan の上位集合で、advancePrWatch から発火する
 * CI 起因の自動 rework を追加したもの。ci_failure は「上限まで自動でやり直す」
 * 経路なので、そのメタ情報（失敗チェックのログ）を持つ。
 */
export type ResumeInput =
  | { kind: "human_rework"; from: PageState }
  | { kind: "needs_info_answer"; from: NeedsInfoState }
  | { kind: "ci_failure"; from: PageState; ciFailures?: string };

/** eligibility 判定の結果 ADT。false 側だけが needsCommentCheck を持ちうる。 */
export type EligibilityDecision =
  | { eligible: false; reason: string; needsCommentCheck?: boolean }
  | { eligible: true; reason: string; run: RunPlan };

/** resume（rework / CI 修正 / レビュー対応 / 質問回答）実行に引き継ぐ前回実行のコンテキスト。 */
export interface ResumeContext {
  kind: "human_rework" | "ci_failure" | "needs_info_answer";
  /** 前回作成した PR（同じ PR を更新させるためプロンプトへ渡す）。 */
  prUrl?: string;
  /** 基準時刻（done/failed 記録時刻 or questionAskedAt）。これより新しいコメントを拾う。 */
  since?: string;
  /** needs_info_answer 用: 前回自分が投げた質問。 */
  question?: string;
  /** ci_failure 用: 失敗 check の要約 + ログ。 */
  ciFailures?: string;
}

/** resume種別がネイティブセッション継続（CLIの--resume相当）の対象かどうか。human_reworkのみ新規セッション扱い。 */
export function isNativeResumable(kind: ResumeContext["kind"]): boolean {
  return kind !== "human_rework";
}

/**
 * ResumeInput から ResumeContext を組む純粋関数。variant で完全に場合分けするので
 * 実行時の status 文字列比較や optional chaining は不要（needs_info_answer の from は
 * 型レベルで needs_info に narrow されている）。
 */
export function buildResumeContext(input: ResumeInput): ResumeContext {
  return match(input)
    .with({ kind: "human_rework" }, ({ from }) => ({
      kind: "human_rework" as const,
      prUrl: from.prUrl,
      since: from.lastEditedTime,
    }))
    .with({ kind: "needs_info_answer" }, ({ from }) => ({
      kind: "needs_info_answer" as const,
      prUrl: from.prUrl,
      since: from.questionAskedAt,
      question: from.question,
    }))
    .with({ kind: "ci_failure" }, ({ from, ciFailures }) => ({
      kind: "ci_failure" as const,
      prUrl: from.prUrl,
      since: from.lastEditedTime,
      ciFailures,
    }))
    .exhaustive();
}

/**
 * RunPlan と前回 prev から、dispatch に渡す attempt と ResumeContext を決める純粋関数。
 * fresh は attempt = (prev?.attempt ?? 0)+1、それ以外は attempt=1 で振り直し。
 * RunPlan の非 fresh バリアントは ResumeInput のサブセットなのでそのまま渡せる。
 */
export function nextDispatchParams(
  run: RunPlan,
  prev: PageState | undefined,
): { attempt: number; resume: ResumeContext | undefined } {
  if (run.kind === "fresh") {
    return { attempt: (prev?.attempt ?? 0) + 1, resume: undefined };
  }
  return { attempt: 1, resume: buildResumeContext(run) };
}

export interface ResumePlan {
  /** agent().start() に渡す session_id。undefined なら新規セッション。 */
  sessionIdForAgent: string | undefined;
  /** true ならネイティブ resume 用の軽量プロンプト（resumePromptTemplate）を使う。 */
  useNativeResume: boolean;
}

/**
 * resume種別と前回記録済みの session_id から、今回どうセッションを継続するか決める（純粋関数）。
 * human_rework は常に新規セッション。それ以外は記録済み session_id があればネイティブ resume、
 * なければ（未記録/抽出失敗）フルプロンプト・新規セッションにフォールバックする。
 */
export function resolveResumePlan(
  resume: ResumeContext | undefined,
  recordedSessionId: string | undefined,
): ResumePlan {
  const sessionIdForAgent = resume?.kind === "human_rework" ? undefined : recordedSessionId;
  const useNativeResume = !!resume && isNativeResumable(resume.kind) && !!sessionIdForAgent;
  return { sessionIdForAgent, useNativeResume };
}

/**
 * ディスパッチ可否判定（純粋関数）。
 * 候補クエリ自体がレーン/実行環境でフィルタ済みだが、config 再読込との
 * ずれに備えてここでも検証する。
 *
 * done の再実行（rework）: 成功時に記録した lastEditedTime よりページの
 * last_edited_time が進んでいれば「人間がカードを触って差し戻した」とみなす。
 * 成功直後に結果整合性で古い lane=In Progress が返ってきても、
 * last_edited_time は記録値以下なので二重実行にはならない。
 */
export function decideEligibility(opts: {
  ticket: Ticket;
  cfg: EligibilityConfig;
  isActive: boolean;
  ps: PageState | undefined;
  /**
   * needs_info の回答コメント有無（checkNeedsInfoAnswers の結果）。
   * true=回答あり / false=回答なし / undefined=未確認（needsCommentCheck を返す）。
   */
  needsInfoAnswered?: boolean;
}): EligibilityDecision {
  const { ticket: t, cfg, isActive, ps, needsInfoAnswered } = opts;
  if (cfg.onlyOwnTickets) {
    if (!cfg.operatorUserId) {
      return { eligible: false, reason: "作成者フィルタ(操作者不明)" };
    }
    if (!t.authorId) {
      return { eligible: false, reason: "作成者不明" };
    }
    if (t.authorId !== cfg.operatorUserId) {
      return { eligible: false, reason: `作成者不一致(${t.authorId})` };
    }
  }
  if (!t.repo) return { eligible: false, reason: "リポジトリ未設定" };
  if (!t.lane || !cfg.triggerLanes.includes(t.lane)) {
    return { eligible: false, reason: `レーン対象外(${t.lane})` };
  }
  if (t.condition !== cfg.conditionValue) {
    return { eligible: false, reason: `条件不一致(${t.condition})` };
  }
  if (isActive) {
    return { eligible: false, reason: "処理中" };
  }
  if (!ps) return { eligible: true, reason: "未処理", run: { kind: "fresh" } };

  return match<PageState, EligibilityDecision>(ps)
    .with({ status: "running" }, () => ({ eligible: false, reason: "running" }))
    .with({ status: "done" }, (p) =>
      p.lastEditedTime && t.lastEditedTime > p.lastEditedTime
        ? {
            eligible: true,
            reason: "done→差し戻しで再実行",
            run: { kind: "human_rework", from: p },
          }
        : {
            eligible: false,
            reason: p.lastEditedTime ? "done(差し戻しなし)" : "done(基準時刻なし)",
          },
    )
    .with({ status: "failed" }, (p) =>
      p.lastEditedTime && t.lastEditedTime > p.lastEditedTime
        ? {
            eligible: true,
            reason: "failed→編集後の再実行",
            run: { kind: "human_rework", from: p },
          }
        : { eligible: false, reason: "failed(未編集)" },
    )
    .with({ status: "retry_queued" }, (p) => {
      if (Date.now() >= p.retryAt) {
        return { eligible: true, reason: "retry 満了", run: { kind: "fresh" } };
      }
      const waitS = Math.ceil((p.retryAt - Date.now()) / 1000);
      return { eligible: false, reason: `retry 待ち(${waitS}s)` };
    })
    .with({ status: "needs_info" }, (p) => {
      if (needsInfoAnswered === true) {
        return {
          eligible: true,
          reason: "needs_info→回答コメントあり",
          run: { kind: "needs_info_answer", from: p },
        };
      }
      if (p.lastEditedTime && t.lastEditedTime > p.lastEditedTime) {
        return {
          eligible: true,
          reason: "needs_info→ページ本文編集",
          run: { kind: "needs_info_answer", from: p },
        };
      }
      if (needsInfoAnswered === undefined) {
        return {
          eligible: false,
          reason: "needs_info(コメント未確認)",
          needsCommentCheck: true,
        };
      }
      return { eligible: false, reason: "needs_info(回答待ち)" };
    })
    .exhaustive();
}
