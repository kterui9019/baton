import { test, expect } from "bun:test";
import {
  isWithinRoot,
  mapRepoName,
  renderBranch,
  repoDirFor,
  shortId,
  slugify,
  worktreePathFor,
} from "../../src/domain/workspace.ts";

test("slugify: 基本のサニタイズ", () => {
  expect(slugify("Fix the Login Bug!")).toBe("fix-the-login-bug");
});

test("slugify: 日本語や記号は - に、連続 - は圧縮", () => {
  expect(slugify("hello world github repo")).toBe("hello-world-github-repo");
  expect(slugify("Foo   Bar")).toBe("foo-bar");
});

test("slugify: 許可文字 . _ - は保持", () => {
  expect(slugify("a.b_c-d")).toBe("a.b_c-d");
});

test("slugify: 先頭末尾の - を除去", () => {
  expect(slugify("---hello---")).toBe("hello");
});

test("slugify: 40 文字上限＋末尾ハイフン除去", () => {
  const s = slugify("a".repeat(60));
  expect(s.length).toBe(40);
});

test("slugify: 空/記号のみは task", () => {
  expect(slugify("")).toBe("task");
  expect(slugify("！？＃")).toBe("task");
});

test("shortId: ハイフン除去後 8 文字", () => {
  expect(shortId("38b76d6c-08eb-802f-9dda-c7f4ec790b5e")).toBe("38b76d6c");
});

test("renderBranch: {id}/{slug} 置換", () => {
  expect(renderBranch("feature/notion-{id}/{slug}", "38b76d6c", "fix-bug")).toBe(
    "feature/notion-38b76d6c/fix-bug",
  );
});

test("renderBranch: 同じ変数が複数回でも全部置換", () => {
  expect(renderBranch("{id}-{slug}-{id}", "aa", "bb")).toBe("aa-bb-aa");
});

const repoMapping = { "sample-app-legacy": "sample-app-full" };

test("mapRepoName: mapping 適用/未適用", () => {
  expect(mapRepoName(repoMapping, "sample-app-legacy")).toBe(
    "sample-app-full",
  );
  expect(mapRepoName(repoMapping, "sample-app")).toBe("sample-app");
});

test("repoDirFor: repoRoot 配下＋mapping", () => {
  const root = "/home/u/ghq/github.com/kterui9019";
  expect(repoDirFor(root, repoMapping, "sample-app")).toBe(
    "/home/u/ghq/github.com/kterui9019/sample-app",
  );
  expect(repoDirFor(root, repoMapping, "sample-app-legacy")).toBe(
    "/home/u/ghq/github.com/kterui9019/sample-app-full",
  );
});

test("worktreePathFor: workspaces/<repo>/<id-slug>", () => {
  expect(worktreePathFor("/proj", "sample-app", "38b76d6c", "fix")).toBe(
    "/proj/workspaces/sample-app/38b76d6c-fix",
  );
});

test("isWithinRoot: 配下判定と越境拒否", () => {
  const root = "/proj/workspaces";
  expect(isWithinRoot(root, "/proj/workspaces/repo/x")).toBe(true);
  expect(isWithinRoot(root, "/proj/workspaces")).toBe(true);
  expect(isWithinRoot(root, "/proj/workspaces/../secret")).toBe(false);
  expect(isWithinRoot(root, "/etc/passwd")).toBe(false);
  expect(isWithinRoot(root, "/proj/workspaces-evil/x")).toBe(false);
});
