import type {
  CommentInfo,
  KanbanPageSnapshot,
  Ticket,
  TicketUpdate,
} from "../../domain/ticket.ts";

/**
 * カンバンプラットフォームとのやり取りを表す関数の集合。
 * Notion 固有の JSON 形状・プロパティ名変換はこの Port の実装
 * （interface-adapters/notion 等）側に完全に隠蔽される。
 */
export type KanbanPort = {
  queryCandidates: () => Promise<Ticket[]>;
  getPage: (pageId: string) => Promise<KanbanPageSnapshot>;
  getPageMarkdown: (pageId: string) => Promise<string>;
  listComments: (pageId: string) => Promise<CommentInfo[]>;
  /** この統合（bot）自身のユーザー ID。自分が書いたコメントの除外に使う。 */
  getBotUserId: () => Promise<string | null>;
  updateTicket: (pageId: string, update: TicketUpdate) => Promise<void>;
  addComment: (pageId: string, text: string) => Promise<void>;
};
