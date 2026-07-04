import { test, expect } from "bun:test";
import {
  decideEligibility,
  isNativeResumable,
  resolveResumePlan,
} from "../../src/domain/eligibility.ts";
import type { PageState } from "../../src/domain/state.ts";
import type { Ticket } from "../../src/domain/ticket.ts";

test("isNativeResumable: human_rework は false、他3種は true", () => {
  expect(isNativeResumable("human_rework")).toBe(false);
  expect(isNativeResumable("ci_failure")).toBe(true);
  expect(isNativeResumable("review_changes")).toBe(true);
  expect(isNativeResumable("needs_info_answer")).toBe(true);
});

test("resolveResumePlan: resume なし（通常retry）は記録済み session_id をそのまま渡す", () => {
  const plan = resolveResumePlan(undefined, "sess-1");
  expect(plan.sessionIdForAgent).toBe("sess-1");
  expect(plan.useNativeResume).toBe(false);
});

test("resolveResumePlan: human_rework は session_id が記録済みでも新規セッション", () => {
  const plan = resolveResumePlan({ kind: "human_rework" }, "sess-1");
  expect(plan.sessionIdForAgent).toBeUndefined();
  expect(plan.useNativeResume).toBe(false);
});

test("resolveResumePlan: ci_failure/review_changes/needs_info_answer は記録済みならネイティブresume", () => {
  for (const kind of ["ci_failure", "review_changes", "needs_info_answer"] as const) {
    const plan = resolveResumePlan({ kind }, "sess-2");
    expect(plan.sessionIdForAgent).toBe("sess-2");
    expect(plan.useNativeResume).toBe(true);
  }
});

test("resolveResumePlan: 記録済み session_id が無ければ resume種別でもフルプロンプトへフォールバック", () => {
  const plan = resolveResumePlan({ kind: "ci_failure" }, undefined);
  expect(plan.sessionIdForAgent).toBeUndefined();
  expect(plan.useNativeResume).toBe(false);
});

const cfg = { triggerLanes: ["In Progress"], conditionValue: "Local" };

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    pageId: "page-1",
    url: "https://app.notion.com/p/page-1",
    title: "テストチケット",
    lane: "In Progress",
    repo: "sample-app",
    condition: "Local",
    lastEditedTime: "2026-07-02T10:00:00.000Z",
    createdTime: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

/** テスト用フィクスチャ: status ごとに必須フィールドが変わる判別 Union のため、内部でのみ as を使う。 */
function pageState(over: Partial<PageState> & { status: PageState["status"] }): PageState {
  return {
    attempt: 1,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  } as PageState;
}

function decide(t: Ticket, ps?: PageState, isActive = false, needsInfoAnswered?: boolean) {
  return decideEligibility({ ticket: t, cfg, isActive, ps, needsInfoAnswered });
}

test("未処理のチケットは eligible", () => {
  const d = decide(ticket(), undefined);
  expect(d.eligible).toBe(true);
  expect(d.rework).toBeUndefined();
});

test("done: 記録時刻より編集が進んでいれば rework として eligible", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    pageState({ status: "done", lastEditedTime: "2026-07-02T11:00:00.000Z", prUrl: "https://github.com/o/r/pull/1" }),
  );
  expect(d.eligible).toBe(true);
  expect(d.rework).toBe(true);
});

test("done: 編集が進んでいなければスキップ（成功直後の stale クエリ対策）", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T11:00:00.000Z" }),
    pageState({ status: "done", lastEditedTime: "2026-07-02T11:00:00.000Z" }),
  );
  expect(d.eligible).toBe(false);
  expect(d.reason).toContain("差し戻しなし");
});

test("done: 基準時刻が未記録なら安全側でスキップ", () => {
  const d = decide(ticket(), pageState({ status: "done" }));
  expect(d.eligible).toBe(false);
  expect(d.reason).toContain("基準時刻なし");
});

test("failed: 編集後の再実行は rework フラグ付き", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    pageState({ status: "failed", lastEditedTime: "2026-07-02T11:00:00.000Z" }),
  );
  expect(d.eligible).toBe(true);
  expect(d.rework).toBe(true);
});

test("failed: 未編集ならスキップ", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T11:00:00.000Z" }),
    pageState({ status: "failed", lastEditedTime: "2026-07-02T11:00:00.000Z" }),
  );
  expect(d.eligible).toBe(false);
});

test("running / 処理中(active) はスキップ", () => {
  expect(decide(ticket(), pageState({ status: "running" })).eligible).toBe(false);
  expect(decide(ticket(), undefined, true).eligible).toBe(false);
});

test("retry_queued: 満了で eligible（rework ではない）", () => {
  const d = decide(ticket(), pageState({ status: "retry_queued", retryAt: Date.now() - 1000 }));
  expect(d.eligible).toBe(true);
  expect(d.rework).toBeUndefined();
});

test("retry_queued: 未満了はスキップ", () => {
  const d = decide(ticket(), pageState({ status: "retry_queued", retryAt: Date.now() + 60_000 }));
  expect(d.eligible).toBe(false);
});

test("レーン対象外 / リポジトリ未設定 / 条件不一致はスキップ", () => {
  expect(decide(ticket({ lane: "Human Review" })).eligible).toBe(false);
  expect(decide(ticket({ repo: null })).eligible).toBe(false);
  expect(decide(ticket({ condition: "Cloud" })).eligible).toBe(false);
});

test("done/failed の rework には resumeKind=human_rework が付く", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    pageState({ status: "done", lastEditedTime: "2026-07-02T11:00:00.000Z" }),
  );
  expect(d.resumeKind).toBe("human_rework");
});

function needsInfoState(over: Partial<PageState> = {}): PageState {
  return pageState({
    status: "needs_info",
    questionAskedAt: "2026-07-02T10:30:00.000Z",
    question: "確認事項",
    lastEditedTime: "2026-07-02T10:30:05.000Z",
    ...over,
  });
}

test("needs_info: 回答コメントあり(answered=true)は resume として eligible", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    needsInfoState(),
    false,
    true,
  );
  expect(d.eligible).toBe(true);
  expect(d.resumeKind).toBe("needs_info_answer");
  expect(d.rework).toBeUndefined();
});

test("needs_info: ページ本文編集でも eligible（answered=false でも）", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    needsInfoState({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    false,
    false,
  );
  expect(d.eligible).toBe(true);
  expect(d.resumeKind).toBe("needs_info_answer");
});

test("needs_info: answered 未指定は needsCommentCheck を返してスキップ", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    needsInfoState(),
    false,
    undefined,
  );
  expect(d.eligible).toBe(false);
  expect(d.needsCommentCheck).toBe(true);
});

test("needs_info: 回答なし(answered=false)・未編集はスキップ（回答待ち）", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    needsInfoState(),
    false,
    false,
  );
  expect(d.eligible).toBe(false);
  expect(d.needsCommentCheck).toBeUndefined();
  expect(d.reason).toContain("回答待ち");
});

test("needs_info: lastEditedTime 未記録なら本文編集では発火しない（answered=true でのみ再開）", () => {
  const notAnswered = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    needsInfoState({ lastEditedTime: undefined }),
    false,
    false,
  );
  expect(notAnswered.eligible).toBe(false);
  const answered = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    needsInfoState({ lastEditedTime: undefined }),
    false,
    true,
  );
  expect(answered.eligible).toBe(true);
});
