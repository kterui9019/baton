/** カンバンプラットフォーム非依存のチケット（カード）表現。 */
export interface Ticket {
  pageId: string;
  url: string;
  title: string;
  lane: string | null;
  repo: string | null;
  condition: string | null;
  lastEditedTime: string;
  createdTime: string;
  /** チケット作成者 ID（Notion user id / GitHub login）。未取得時は ""）。 */
  authorId: string;
}

/** チケットへのコメント 1 件（rework 時のフィードバック取り込み用）。 */
export interface CommentInfo {
  createdTime: string;
  authorId: string;
  text: string;
}

/**
 * チケット更新の汎用 DTO。プロパティ名・型変換などプラットフォーム固有の
 * マッピングは KanbanPort 実装（interface-adapters）側の責務とし、
 * use-cases 層はこの形にしか依存しない。
 */
export interface TicketUpdate {
  lane?: string;
  prUrl?: string;
}

/**
 * KanbanPort.getPage の返り値。カンバン実装固有の JSON 形状（Notion の
 * `properties[...].status.name` 等）を一切含まない汎用スナップショット。
 */
export interface KanbanPageSnapshot {
  ticket: Ticket;
  isArchived: boolean;
  isDeleted: boolean;
}

/** created_time 昇順 → page_id 辞書順で安定ソート。 */
export function sortTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    if (a.createdTime !== b.createdTime) {
      return a.createdTime < b.createdTime ? -1 : 1;
    }
    return a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
  });
}
