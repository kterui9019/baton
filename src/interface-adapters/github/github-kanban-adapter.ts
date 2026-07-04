import { z } from "zod";
import type {
  CommentInfo,
  KanbanPageSnapshot,
  Ticket,
  TicketUpdate,
} from "../../domain/ticket.ts";
import { sortTickets } from "../../domain/ticket.ts";
import { KanbanPageNotFoundError } from "../../domain/errors.ts";
import type { Config } from "../../infrastructure/config.ts";
import { runCommand } from "../../infrastructure/process-runner.ts";
import type { CommandRunner } from "../../infrastructure/process-runner.ts";
import type { KanbanPort } from "../../use-cases/ports/kanban-port.ts";

/**
 * GitHub Issue を一意に指す pageId 表現: `${owner}/${repo}#${number}`。
 * `/` と `#` は GitHub の owner/repo/issue 番号のどれにも含まれないため
 * 一意分解できる。ブランチ命名では `shortId` が先頭 8 文字を取るだけなので、
 * この形式の pageId をそのまま `{id}` として使っても実害はない。
 */
export function formatPageId(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export function parsePageId(
  pageId: string,
): { owner: string; repo: string; number: number } | null {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(pageId);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

const GhLabelSchema = z.object({ name: z.string().optional() });
const GhAuthorSchema = z.object({ login: z.string().optional() }).optional();

const GhIssueListItemSchema = z.object({
  number: z.number(),
  title: z.string().optional(),
  url: z.string().optional(),
  labels: z.array(GhLabelSchema).optional(),
  updatedAt: z.string().optional(),
  createdAt: z.string().optional(),
  author: GhAuthorSchema,
  state: z.string().optional(),
  closed: z.boolean().optional(),
});
type GhIssueListItem = z.infer<typeof GhIssueListItemSchema>;

/** ラベル配列から lanePrefix にマッチする最初のラベルの lane 名（プレフィックス除去後）を返す。 */
export function extractLaneFromLabels(
  labels: Array<{ name?: string }> | undefined,
  lanePrefix: string,
): string | null {
  if (!labels) return null;
  for (const l of labels) {
    const name = l.name ?? "";
    if (name.startsWith(lanePrefix)) return name.slice(lanePrefix.length);
  }
  return null;
}

/**
 * `gh issue list` の1エントリ → 内部 Ticket 型。
 * `condition` は GitHub Issues では意味を持たない（条件フィルタは queryCandidates
 * 段階で `--label` で消化済み）ため常に null。
 */
export function parseIssueListItem(
  owner: string,
  repo: string,
  item: unknown,
  lanePrefix: string,
): Ticket | null {
  const parsed = GhIssueListItemSchema.safeParse(item);
  if (!parsed.success) return null;
  const j = parsed.data;
  return {
    pageId: formatPageId(owner, repo, j.number),
    url: j.url ?? "",
    title: j.title ?? "",
    lane: extractLaneFromLabels(j.labels, lanePrefix),
    repo,
    condition: null,
    lastEditedTime: j.updatedAt ?? "",
    createdTime: j.createdAt ?? "",
    authorId: j.author?.login ?? "",
  };
}

const GhIssueViewSchema = z.object({
  number: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  labels: z.array(GhLabelSchema).optional(),
  updatedAt: z.string().optional(),
  createdAt: z.string().optional(),
  author: GhAuthorSchema,
  state: z.string().optional(),
  closed: z.boolean().optional(),
  body: z.string().optional(),
});

const GhCommentSchema = z.object({
  user: z.object({ login: z.string().optional() }).optional(),
  body: z.string().optional(),
  created_at: z.string().optional(),
});

/** `gh api repos/O/R/issues/N/comments` の結果 → CommentInfo[]（純粋関数）。 */
export function parseIssueComments(json: unknown): CommentInfo[] {
  if (!Array.isArray(json)) return [];
  return json.map((c) => {
    const parsed = GhCommentSchema.safeParse(c);
    const d = parsed.success ? parsed.data : {};
    return {
      createdTime: d.created_at ?? "",
      authorId: d.user?.login ?? "",
      text: d.body ?? "",
    };
  });
}

const GH_TIMEOUT_MS = 30_000;
const NOT_FOUND_PATTERN = /not\s*found|could not find|404|no issue found/i;

/**
 * `gh` CLI ベースの GitHub Issues KanbanPort 実装。
 * lane はラベル (`${lanePrefix}${lane}`) で表現する。
 */
export function createGitHubKanbanAdapter(
  config: Config,
  run: CommandRunner = runCommand,
): KanbanPort {
  const gh = config.ghCommand;
  const gcfg = config.kanban.github;

  async function ghStdout(args: string[]): Promise<string> {
    const res = await run(gh, args, { timeoutMs: GH_TIMEOUT_MS });
    if (res.code !== 0) {
      throw new Error(
        `gh ${args.join(" ")} が失敗 (code=${res.code}${
          res.timedOut ? ", timedOut" : ""
        }): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    return res.stdout;
  }

  async function queryCandidates(): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    for (const repo of gcfg.repos) {
      for (const lane of config.kanban.triggerLanes) {
        const labels: string[] = [`${gcfg.lanePrefix}${lane}`];
        if (gcfg.conditionLabel !== "") labels.push(gcfg.conditionLabel);
        const args = [
          "issue",
          "list",
          "--repo",
          `${gcfg.owner}/${repo}`,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,title,url,labels,updatedAt,createdAt,author,state",
        ];
        for (const l of labels) {
          args.push("--label", l);
        }
        const stdout = await ghStdout(args);
        const parsed = JSON.parse(stdout) as unknown;
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          const t = parseIssueListItem(gcfg.owner, repo, item, gcfg.lanePrefix);
          if (t) tickets.push(t);
        }
      }
    }
    return sortTickets(tickets);
  }

  async function viewIssue(
    slug: { owner: string; repo: string; number: number },
    fields: string,
  ): Promise<z.infer<typeof GhIssueViewSchema>> {
    const args = [
      "issue",
      "view",
      String(slug.number),
      "--repo",
      `${slug.owner}/${slug.repo}`,
      "--json",
      fields,
    ];
    let stdout: string;
    try {
      stdout = await ghStdout(args);
    } catch (err) {
      if (NOT_FOUND_PATTERN.test(String(err))) {
        throw new KanbanPageNotFoundError(formatPageId(slug.owner, slug.repo, slug.number), {
          cause: err,
        });
      }
      throw err;
    }
    const parsed = GhIssueViewSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : {};
  }

  function resolveSlug(pageId: string): { owner: string; repo: string; number: number } {
    const slug = parsePageId(pageId);
    if (!slug) {
      throw new Error(
        `pageId が GitHub 形式ではありません: ${pageId} (期待: owner/repo#number)`,
      );
    }
    return slug;
  }

  async function getPage(pageId: string): Promise<KanbanPageSnapshot> {
    const slug = resolveSlug(pageId);
    const view = await viewIssue(
      slug,
      "number,title,url,labels,updatedAt,createdAt,author,state,closed",
    );
    const closed = view.closed === true || view.state === "CLOSED";
    return {
      ticket: {
        pageId,
        url: view.url ?? "",
        title: view.title ?? "",
        lane: extractLaneFromLabels(view.labels, gcfg.lanePrefix),
        repo: slug.repo,
        condition: null,
        lastEditedTime: view.updatedAt ?? "",
        createdTime: view.createdAt ?? "",
        authorId: view.author?.login ?? "",
      },
      // GitHub Issues にはアーカイブ状態はないため、close を「進行不可」として扱う。
      isArchived: closed,
      isDeleted: false,
    };
  }

  async function getPageMarkdown(pageId: string): Promise<string> {
    try {
      const slug = resolveSlug(pageId);
      const view = await viewIssue(slug, "body");
      return view.body ?? "";
    } catch {
      return "";
    }
  }

  async function listComments(pageId: string): Promise<CommentInfo[]> {
    const slug = resolveSlug(pageId);
    const stdout = await ghStdout([
      "api",
      `repos/${slug.owner}/${slug.repo}/issues/${slug.number}/comments`,
    ]);
    return parseIssueComments(JSON.parse(stdout));
  }

  async function getBotUserId(): Promise<string | null> {
    try {
      const stdout = await ghStdout(["api", "user", "-q", ".login"]);
      const login = stdout.trim();
      return login === "" ? null : login;
    } catch {
      return null;
    }
  }

  async function addComment(pageId: string, text: string): Promise<void> {
    const slug = resolveSlug(pageId);
    await ghStdout([
      "issue",
      "comment",
      String(slug.number),
      "--repo",
      `${slug.owner}/${slug.repo}`,
      "--body",
      text,
    ]);
  }

  async function updateTicket(pageId: string, update: TicketUpdate): Promise<void> {
    const slug = resolveSlug(pageId);
    if (update.lane !== undefined) {
      const view = await viewIssue(slug, "labels");
      const current = (view.labels ?? [])
        .map((l) => l.name ?? "")
        .filter((n) => n !== "");
      const toRemove = current.filter((n) => n.startsWith(gcfg.lanePrefix));
      const toAdd = `${gcfg.lanePrefix}${update.lane}`;
      const args = [
        "issue",
        "edit",
        String(slug.number),
        "--repo",
        `${slug.owner}/${slug.repo}`,
      ];
      for (const r of toRemove) {
        if (r === toAdd) continue; // 既に付いている
        args.push("--remove-label", r);
      }
      if (!current.includes(toAdd)) args.push("--add-label", toAdd);
      // remove/add がゼロなら副作用なしなので呼ばない。
      if (args.length > 5) await ghStdout(args);
    }
    if (update.prUrl !== undefined) {
      await addComment(pageId, `🔗 PR: ${update.prUrl}`);
    }
    if (update.activity !== undefined) {
      await addComment(pageId, update.activity);
    }
  }

  return {
    queryCandidates,
    getPage,
    getPageMarkdown,
    listComments,
    getBotUserId,
    updateTicket,
    addComment,
  };
}
