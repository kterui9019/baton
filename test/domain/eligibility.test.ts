import { test, expect } from "bun:test";
import {
  buildResumeContext,
  decideEligibility,
  isNativeResumable,
  nextDispatchParams,
  resolveResumePlan,
} from "../../src/domain/eligibility.ts";
import type {
  EligibilityDecision,
  NeedsInfoState,
  RunPlan,
} from "../../src/domain/eligibility.ts";
import type { PageState } from "../../src/domain/state.ts";
import type { Ticket } from "../../src/domain/ticket.ts";

test("isNativeResumable: human_rework は false、他2種は true", () => {
  expect(isNativeResumable("human_rework")).toBe(false);
  expect(isNativeResumable("ci_failure")).toBe(true);
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

test("resolveResumePlan: ci_failure/needs_info_answer は記録済みならネイティブresume", () => {
  for (const kind of ["ci_failure", "needs_info_answer"] as const) {
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
    authorId: "user-me",
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

/** eligible=true に narrow するアサーション。TS の判別 Union で `d.run` にアクセスできるようにする。 */
function assertEligible(d: EligibilityDecision): asserts d is EligibilityDecision & { eligible: true } {
  if (!d.eligible) throw new Error(`expected eligible, got: ${d.reason}`);
}
function assertIneligible(d: EligibilityDecision): asserts d is EligibilityDecision & { eligible: false } {
  if (d.eligible) throw new Error(`expected ineligible, got: ${d.reason}`);
}

test("未処理のチケットは eligible / run=fresh", () => {
  const d = decide(ticket(), undefined);
  assertEligible(d);
  expect(d.run.kind).toBe("fresh");
});

test("onlyOwnTickets: 作成者一致なら eligible", () => {
  const d = decideEligibility({
    ticket: ticket({ authorId: "user-me" }),
    cfg: { ...cfg, onlyOwnTickets: true, operatorUserId: "user-me" },
    isActive: false,
    ps: undefined,
  });
  assertEligible(d);
});

test("onlyOwnTickets: 作成者不一致はスキップ", () => {
  const d = decideEligibility({
    ticket: ticket({ authorId: "other-user" }),
    cfg: { ...cfg, onlyOwnTickets: true, operatorUserId: "user-me" },
    isActive: false,
    ps: undefined,
  });
  assertIneligible(d);
  expect(d.reason).toContain("作成者不一致");
});

test("onlyOwnTickets: 操作者不明はスキップ", () => {
  const d = decideEligibility({
    ticket: ticket({ authorId: "user-me" }),
    cfg: { ...cfg, onlyOwnTickets: true, operatorUserId: null },
    isActive: false,
    ps: undefined,
  });
  assertIneligible(d);
  expect(d.reason).toContain("操作者不明");
});

test("onlyOwnTickets: false なら他人のチケットも eligible", () => {
  const d = decideEligibility({
    ticket: ticket({ authorId: "other-user" }),
    cfg: { ...cfg, onlyOwnTickets: false, operatorUserId: "user-me" },
    isActive: false,
    ps: undefined,
  });
  assertEligible(d);
});

test("done: 記録時刻より編集が進んでいれば human_rework で eligible", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    pageState({
      status: "done",
      lastEditedTime: "2026-07-02T11:00:00.000Z",
      prUrl: "https://github.com/o/r/pull/1",
    }),
  );
  assertEligible(d);
  expect(d.run.kind).toBe("human_rework");
  if (d.run.kind === "human_rework") {
    expect(d.run.from.status).toBe("done");
  }
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

test("failed: 編集後の再実行は human_rework", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    pageState({ status: "failed", lastEditedTime: "2026-07-02T11:00:00.000Z" }),
  );
  assertEligible(d);
  expect(d.run.kind).toBe("human_rework");
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

test("retry_queued: 満了で eligible（run=fresh、attempt はリセットしない）", () => {
  const d = decide(ticket(), pageState({ status: "retry_queued", retryAt: Date.now() - 1000 }));
  assertEligible(d);
  expect(d.run.kind).toBe("fresh");
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

function needsInfoState(over: Partial<PageState> = {}): PageState {
  return pageState({
    status: "needs_info",
    questionAskedAt: "2026-07-02T10:30:00.000Z",
    question: "確認事項",
    lastEditedTime: "2026-07-02T10:30:05.000Z",
    ...over,
  });
}

test("needs_info: 回答コメントあり(answered=true)は needs_info_answer で eligible / from が narrow される", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    needsInfoState(),
    false,
    true,
  );
  assertEligible(d);
  expect(d.run.kind).toBe("needs_info_answer");
  if (d.run.kind === "needs_info_answer") {
    // 型上 from は NeedsInfoState、runtime でも needs_info。
    expect(d.run.from.status).toBe("needs_info");
    expect(d.run.from.question).toBe("確認事項");
  }
});

test("needs_info: ページ本文編集でも eligible（answered=false でも）", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T12:00:00.000Z" }),
    needsInfoState({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    false,
    false,
  );
  assertEligible(d);
  expect(d.run.kind).toBe("needs_info_answer");
});

test("needs_info: answered 未指定は needsCommentCheck を返してスキップ", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    needsInfoState(),
    false,
    undefined,
  );
  assertIneligible(d);
  expect(d.needsCommentCheck).toBe(true);
});

test("needs_info: 回答なし(answered=false)・未編集はスキップ（回答待ち）", () => {
  const d = decide(
    ticket({ lastEditedTime: "2026-07-02T10:30:05.000Z" }),
    needsInfoState(),
    false,
    false,
  );
  assertIneligible(d);
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

// ---- buildResumeContext / nextDispatchParams: ResumeInput ADT 経由 ----

const donePs: PageState = {
  status: "done",
  attempt: 3,
  lastEditedTime: "2026-07-01T00:00:00.000Z",
  prUrl: "https://github.com/o/r/pull/1",
  updatedAt: "t",
};

const needsInfoPs: NeedsInfoState = {
  status: "needs_info",
  attempt: 1,
  lastEditedTime: "2026-07-01T00:00:00.000Z",
  questionAskedAt: "2026-07-02T00:00:00.000Z",
  question: "A案かB案か",
  prUrl: "https://github.com/o/r/pull/1",
  updatedAt: "t",
};

test("buildResumeContext: needs_info_answer → from の questionAskedAt/question を採用", () => {
  expect(buildResumeContext({ kind: "needs_info_answer", from: needsInfoPs })).toEqual({
    kind: "needs_info_answer",
    prUrl: "https://github.com/o/r/pull/1",
    since: "2026-07-02T00:00:00.000Z",
    question: "A案かB案か",
  });
});

test("buildResumeContext: human_rework は lastEditedTime を since に、question なし", () => {
  expect(buildResumeContext({ kind: "human_rework", from: donePs })).toEqual({
    kind: "human_rework",
    prUrl: "https://github.com/o/r/pull/1",
    since: "2026-07-01T00:00:00.000Z",
  });
});

test("buildResumeContext: ci_failure は ciFailures を透過、since=lastEditedTime", () => {
  expect(
    buildResumeContext({ kind: "ci_failure", from: donePs, ciFailures: "log-tail" }),
  ).toEqual({
    kind: "ci_failure",
    prUrl: "https://github.com/o/r/pull/1",
    since: "2026-07-01T00:00:00.000Z",
    ciFailures: "log-tail",
  });
});

test("nextDispatchParams: run=fresh → attempt = prev.attempt+1、resume=undefined", () => {
  const run: RunPlan = { kind: "fresh" };
  expect(nextDispatchParams(run, { ...donePs, attempt: 4 })).toEqual({
    attempt: 5,
    resume: undefined,
  });
});

test("nextDispatchParams: run=fresh + prev なし → attempt=1", () => {
  expect(nextDispatchParams({ kind: "fresh" }, undefined)).toEqual({
    attempt: 1,
    resume: undefined,
  });
});

test("nextDispatchParams: run=needs_info_answer → attempt=1 で振り直し、buildResumeContext と一致", () => {
  const run: RunPlan = { kind: "needs_info_answer", from: needsInfoPs };
  expect(nextDispatchParams(run, needsInfoPs)).toEqual({
    attempt: 1,
    resume: buildResumeContext(run),
  });
});
