import { z } from "zod";
import type { CommentInfo, KanbanPageSnapshot, Ticket, TicketUpdate } from "../../domain/ticket.ts";
import { sortTickets } from "../../domain/ticket.ts";
import { KanbanPageNotFoundError } from "../../domain/errors.ts";
import type { Config } from "../../infrastructure/config.ts";
import { runCommand } from "../../infrastructure/process-runner.ts";
import type { CommandRunner } from "../../infrastructure/process-runner.ts";
import type { KanbanPort } from "../../use-cases/ports/kanban-port.ts";

const RichTextArraySchema = z.array(z.object({ plain_text: z.string().optional() }));

/** rich_text / title 配列の plain_text を連結する。 */
export function plainText(arr: unknown): string {
  const parsed = RichTextArraySchema.safeParse(arr);
  if (!parsed.success) return "";
  return parsed.data.map((it) => it.plain_text ?? "").join("");
}

const SelectPropSchema = z.object({
  select: z.object({ name: z.string().optional() }).nullable().optional(),
});
function selectName(prop: unknown): string | null {
  const parsed = SelectPropSchema.safeParse(prop);
  return parsed.success ? parsed.data.select?.name ?? null : null;
}

const StatusPropSchema = z.object({
  status: z.object({ name: z.string().optional() }).nullable().optional(),
});
function statusName(prop: unknown): string | null {
  const parsed = StatusPropSchema.safeParse(prop);
  return parsed.success ? parsed.data.status?.name ?? null : null;
}

const NotionPageSchema = z.object({
  id: z.string().optional(),
  url: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  last_edited_time: z.string().optional(),
  created_time: z.string().optional(),
  created_by: z.object({ id: z.string().optional() }).optional(),
  is_archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
});
type NotionPage = z.infer<typeof NotionPageSchema>;

function parseNotionPage(pageJson: unknown): NotionPage {
  const parsed = NotionPageSchema.safeParse(pageJson);
  return parsed.success ? parsed.data : {};
}

/** Notion ページ JSON → 内部 Ticket 型。プロパティ名は config に従う。 */
export function parseTicket(pageJson: unknown, config: Config): Ticket {
  const page = parseNotionPage(pageJson);
  const props = page.properties ?? {};
  return {
    pageId: page.id ?? "",
    url: page.url ?? "",
    title: plainText((props[config.kanban.notion.titleProperty] as { title?: unknown })?.title),
    lane: statusName(props[config.kanban.notion.laneProperty]),
    repo: selectName(props[config.kanban.notion.repoProperty]),
    condition: selectName(props[config.kanban.notion.conditionProperty]),
    lastEditedTime: page.last_edited_time ?? "",
    createdTime: page.created_time ?? "",
    authorId: page.created_by?.id ?? "",
  };
}

/**
 * GET /v1/users/me のレスポンス。internal integration の場合 `id` は bot 自身の ID なので、
 * onlyOwnTickets の比較には bot.owner.user.id（インテグレーションの所有者）を使う。
 */
const NotionMeSchema = z.object({
  id: z.string().optional(),
  bot: z
    .object({
      owner: z
        .object({
          type: z.string().optional(),
          user: z.object({ id: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

const NotionCommentSchema = z.object({
  created_time: z.string().optional(),
  created_by: z.object({ id: z.string().optional() }).optional(),
  rich_text: z.unknown().optional(),
});
const NotionCommentsResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

/** /v1/comments のレスポンス JSON → CommentInfo[]（純粋関数）。 */
export function parseComments(json: unknown): CommentInfo[] {
  const top = NotionCommentsResponseSchema.safeParse(json);
  if (!top.success || !top.data.results) return [];
  return top.data.results.map((c) => {
    const parsed = NotionCommentSchema.safeParse(c);
    const d = parsed.success ? parsed.data : {};
    return {
      createdTime: d.created_time ?? "",
      authorId: d.created_by?.id ?? "",
      text: plainText(d.rich_text),
    };
  });
}

/**
 * properties オブジェクトを組み立てる（純粋関数）。
 * キーが空文字（プロパティ名 "" = その列が DB に無い環境）と
 * 値が undefined のエントリを除外する。
 */
export function compactProps(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (key === "" || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** ディスパッチ候補取得用のサーバーサイドフィルタ JSON を組み立てる（純粋関数）。 */
export function buildCandidateFilter(config: Config): unknown {
  const laneClauses = config.kanban.triggerLanes.map((lane) => ({
    property: config.kanban.notion.laneProperty,
    status: { equals: lane },
  }));
  return {
    and: [
      {
        property: config.kanban.notion.conditionProperty,
        select: { equals: config.kanban.notion.conditionValue },
      },
      { or: laneClauses },
    ],
  };
}

export function linkProp(url: string): unknown {
  return { rich_text: [{ text: { content: url, link: { url } } }] };
}

export function statusProp(name: string): unknown {
  return { status: { name } };
}

const NTN_TIMEOUT_MS = 30_000;
const NOT_FOUND_PATTERN = /not_found|could not find|404/i;

/** ntn CLI (Notion CLI) による KanbanPort 実装を組み立てる。 */
export function createNotionKanbanAdapter(
  config: Config,
  run: CommandRunner = runCommand,
): KanbanPort {
  const ntn = config.kanban.notion.ntnCommand;

  async function ntnStdout(args: string[]): Promise<string> {
    const res = await run(ntn, args, { timeoutMs: NTN_TIMEOUT_MS });
    if (res.code !== 0) {
      throw new Error(
        `ntn ${args.join(" ")} が失敗 (code=${res.code}${
          res.timedOut ? ", timedOut" : ""
        }): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    return res.stdout;
  }

  async function queryCandidates(): Promise<Ticket[]> {
    const filter = JSON.stringify(buildCandidateFilter(config));
    const tickets: Ticket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const args = [
        "datasources",
        "query",
        config.kanban.notion.dataSourceId,
        "--json",
        "--limit",
        "100",
        "--filter",
        filter,
      ];
      if (cursor) args.push("--start-cursor", cursor);
      const stdout = await ntnStdout(args);
      const parsed = JSON.parse(stdout) as { results?: unknown[]; has_more?: boolean; next_cursor?: string };
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      for (const r of results) tickets.push(parseTicket(r, config));
      if (parsed?.has_more && typeof parsed?.next_cursor === "string") {
        cursor = parsed.next_cursor;
      } else {
        break;
      }
    }
    return sortTickets(tickets);
  }

  async function getPage(pageId: string): Promise<KanbanPageSnapshot> {
    let stdout: string;
    try {
      stdout = await ntnStdout(["api", `/v1/pages/${pageId}`]);
    } catch (err) {
      if (NOT_FOUND_PATTERN.test(String(err))) {
        throw new KanbanPageNotFoundError(pageId, { cause: err });
      }
      throw err;
    }
    const raw = JSON.parse(stdout);
    const page = parseNotionPage(raw);
    return {
      ticket: parseTicket(raw, config),
      isArchived: page.is_archived === true,
      isDeleted: page.in_trash === true,
    };
  }

  async function getPageMarkdown(pageId: string): Promise<string> {
    try {
      const res = await run(ntn, ["pages", "get", pageId], {
        timeoutMs: NTN_TIMEOUT_MS,
      });
      if (res.code !== 0) return "";
      return res.stdout;
    } catch {
      return "";
    }
  }

  async function listComments(pageId: string): Promise<CommentInfo[]> {
    const stdout = await ntnStdout([
      "api",
      `/v1/comments?block_id=${pageId}&page_size=100`,
    ]);
    return parseComments(JSON.parse(stdout));
  }

  async function getBotUserId(): Promise<string | null> {
    const stdout = await ntnStdout(["api", "/v1/users/me"]);
    const parsed = NotionMeSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    const j = parsed.data;
    return j.bot?.owner?.type === "user" ? j.bot.owner.user?.id ?? j.id ?? null : j.id ?? null;
  }

  async function updateProperties(
    pageId: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(props).length === 0) return;
    const body = JSON.stringify({ properties: props });
    await ntnStdout(["api", `/v1/pages/${pageId}`, "-X", "PATCH", "-d", body]);
  }

  async function updateTicket(pageId: string, update: TicketUpdate): Promise<void> {
    await updateProperties(
      pageId,
      compactProps([
        [
          config.kanban.notion.laneProperty,
          update.lane !== undefined ? statusProp(update.lane) : undefined,
        ],
        [
          config.kanban.notion.prProperty,
          update.prUrl !== undefined ? linkProp(update.prUrl) : undefined,
        ],
      ]),
    );
  }

  async function addComment(pageId: string, text: string): Promise<void> {
    const body = JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ text: { content: text } }],
    });
    await ntnStdout(["api", "/v1/comments", "-X", "POST", "-d", body]);
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
