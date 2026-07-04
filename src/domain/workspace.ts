import { join, resolve, sep } from "node:path";

export interface WorkspaceInfo {
  path: string;
  branch: string;
  baseBranch: string;
  repoDir: string;
  reused: boolean;
}

/**
 * タスクタイトルを git ブランチ/ディレクトリ名に使える slug へ変換する。
 * `[A-Za-z0-9._-]` 以外を `-` に、連続 `-` 圧縮、先頭末尾 trim、
 * 小文字化、最大 40 文字。空になったら `task`。
 */
export function slugify(input: string): string {
  let s = (input ?? "").toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^[-]+|[-]+$/g, "");
  if (s.length > 40) {
    s = s.slice(0, 40).replace(/[-]+$/g, "");
  }
  if (s.length === 0) return "task";
  return s;
}

/** page_id 先頭 8 文字（ハイフン除去後）。 */
export function shortId(pageId: string): string {
  return pageId.replace(/-/g, "").slice(0, 8);
}

/** branchTemplate の {id}/{slug} を置換（純粋関数）。 */
export function renderBranch(
  template: string,
  id: string,
  slug: string,
): string {
  return template.replace(/\{id\}/g, id).replace(/\{slug\}/g, slug);
}

/**
 * リポジトリ名 → repoMapping 適用後の実名。
 * Config 型そのものではなく必要な値だけを受け取ることで、domain 層が
 * インフラ側の Config 型に依存しないようにしている。
 */
export function mapRepoName(
  repoMapping: Record<string, string>,
  repo: string,
): string {
  return repoMapping[repo] ?? repo;
}

/** リポジトリ名 → ローカルの clone ディレクトリ (絶対パス)。 */
export function repoDirFor(
  repoRoot: string,
  repoMapping: Record<string, string>,
  repo: string,
): string {
  return join(repoRoot, mapRepoName(repoMapping, repo));
}

/**
 * worktree パス: `<dataHome>/workspaces/<repo名>/<{id}-{slug}>`。
 * repo 名はチケットの表示名（mapping 前）をそのまま層に使う。
 */
export function worktreePathFor(
  dataHome: string,
  repo: string,
  id: string,
  slug: string,
): string {
  return join(dataHome, "workspaces", repo, `${id}-${slug}`);
}

/** path が root 配下（resolve 後）かどうかを検証する安全チェック。 */
export function isWithinRoot(root: string, path: string): boolean {
  const r = resolve(root);
  const p = resolve(path);
  if (p === r) return true;
  return p.startsWith(r + sep);
}
