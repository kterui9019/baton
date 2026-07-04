import { test, expect } from "bun:test";
import {
  renderCiFixSection,
  renderNeedsInfoResumeSection,
  renderResumeSection,
  renderReviewFixSection,
  renderReworkSection,
  renderTemplate,
} from "../../src/use-cases/prompt-builder.ts";

test("renderTemplate: {{var}} 置換、未定義は空文字", () => {
  const out = renderTemplate("Hi {{name}} in {{repo}}!", { name: "A" });
  expect(out).toBe("Hi A in !");
});

test("renderTemplate: 空白入りプレースホルダも置換", () => {
  expect(renderTemplate("{{ title }}", { title: "T" })).toBe("T");
});

test("renderReworkSection: PR とコメントを含む", () => {
  const out = renderReworkSection({
    prUrl: "https://github.com/o/r/pull/12",
    comments: [
      { createdTime: "2026-07-02T12:34:00.000Z", text: "エラー処理が抜けている" },
      { createdTime: "2026-07-02T12:40:00.000Z", text: "テストも追加して" },
    ],
  });
  expect(out).toContain("やり直し依頼");
  expect(out).toContain("https://github.com/o/r/pull/12");
  expect(out).toContain("[2026-07-02 12:34] エラー処理が抜けている");
  expect(out).toContain("[2026-07-02 12:40] テストも追加して");
  expect(out).toContain("新しい PR は作らない");
});

test("renderReworkSection: コメントなしは本文確認を促す", () => {
  const out = renderReworkSection({ prUrl: undefined, comments: [] });
  expect(out).toContain("（記録なし）");
  expect(out).toContain("レビューコメントは見つかりませんでした");
});

test("renderReworkSection: 空文字コメントは無視される", () => {
  const out = renderReworkSection({
    prUrl: "https://github.com/o/r/pull/1",
    comments: [{ createdTime: "2026-07-02T00:00:00.000Z", text: "  " }],
  });
  expect(out).toContain("レビューコメントは見つかりませんでした");
});

test("renderNeedsInfoResumeSection: 質問・PR・回答コメントを含む", () => {
  const out = renderNeedsInfoResumeSection({
    question: "DB は Postgres と MySQL のどちらですか",
    prUrl: "https://github.com/o/r/pull/5",
    comments: [
      { createdTime: "2026-07-02T09:00:00.000Z", text: "Postgres でお願いします" },
    ],
  });
  expect(out).toContain("作業再開");
  expect(out).toContain("作業を中断しました");
  expect(out).toContain("DB は Postgres と MySQL のどちらですか");
  expect(out).toContain("https://github.com/o/r/pull/5");
  expect(out).toContain("[2026-07-02 09:00] Postgres でお願いします");
});

test("renderNeedsInfoResumeSection: 回答コメントなしは本文確認を促す", () => {
  const out = renderNeedsInfoResumeSection({ question: "Q", comments: [] });
  expect(out).toContain("前回の PR: （なし）");
  expect(out).toContain("回答コメントは見つかりませんでした");
});

test("renderResumeSection: kind 別ディスパッチ", () => {
  const comments = [{ createdTime: "2026-07-02T09:00:00.000Z", text: "回答です" }];
  expect(
    renderResumeSection({ kind: "human_rework", prUrl: "u" }, comments),
  ).toBe(renderReworkSection({ prUrl: "u", comments }));
  const ni = renderResumeSection(
    { kind: "needs_info_answer", question: "確認事項X" },
    comments,
  );
  expect(ni).toContain("確認事項X");
  expect(ni).toContain("作業再開");
  expect(
    renderResumeSection({ kind: "ci_failure", prUrl: "u", ciFailures: "log" }, comments),
  ).toBe(renderCiFixSection({ prUrl: "u", ciFailures: "log" }));
  const reviews = [{ author: "a", body: "b", submittedAt: "t" }];
  expect(
    renderResumeSection({ kind: "review_changes", prUrl: "u", reviews }, comments),
  ).toBe(renderReviewFixSection({ prUrl: "u", reviews }));
});

test("renderCiFixSection: PR・失敗ログ・作業条件を含む", () => {
  const out = renderCiFixSection({
    prUrl: "https://github.com/o/r/pull/1",
    ciFailures: "### test\nFAIL: foo.test.ts",
  });
  expect(out).toContain("CI が失敗");
  expect(out).toContain("https://github.com/o/r/pull/1");
  expect(out).toContain("FAIL: foo.test.ts");
  expect(out).toContain("同じブランチへ push");
  expect(out).toContain("PR は作り直さない");
  expect(out).toContain("ローカルで再現");
});

test("renderCiFixSection: ログなしはフォールバック文言", () => {
  const out = renderCiFixSection({ prUrl: undefined, ciFailures: "" });
  expect(out).toContain("失敗ログを取得できませんでした");
  expect(out).toContain("（記録なし）");
});

test("renderReviewFixSection: レビュー列挙（author/submittedAt/body）と作業条件を含む", () => {
  const out = renderReviewFixSection({
    prUrl: "https://github.com/o/r/pull/2",
    reviews: [
      {
        author: "reviewer1",
        body: "エラーハンドリングを追加してください",
        submittedAt: "2026-07-01T10:30:00Z",
      },
      { author: "reviewer2", body: "  ", submittedAt: "2026-07-01T11:00:00Z" },
    ],
  });
  expect(out).toContain("changes requested");
  expect(out).toContain("https://github.com/o/r/pull/2");
  expect(out).toContain("@reviewer1");
  expect(out).toContain("2026-07-01 10:30");
  expect(out).toContain("エラーハンドリングを追加してください");
  expect(out).not.toContain("@reviewer2");
  expect(out).toContain("同じブランチへ push");
  expect(out).toContain("PR コメントで説明");
});

test("renderReviewFixSection: レビューなしはフォールバック文言", () => {
  const out = renderReviewFixSection({ prUrl: "u", reviews: [] });
  expect(out).toContain("レビュー本文を取得できませんでした");
});
