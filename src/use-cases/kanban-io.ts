import type { PageState, StateFile } from "../domain/state.ts";
import type { CommentInfo } from "../domain/ticket.ts";
import { nowIso, oneLine } from "../infrastructure/format.ts";
import type { Logger } from "../infrastructure/logger.ts";
import type { KanbanPort } from "./ports/kanban-port.ts";

/**
 * Kanban 側への書き込みに一貫したエラーハンドリングを与えるラッパ群。
 * すべての副作用は KanbanPort と log/state 更新のみ。orchestrator は
 * 生の port 呼び出しではなくここを経由することで、失敗時のログ形式・
 * lastEditedTime 更新の一元管理・state.pages 更新の atomicity を確保する。
 */
export interface KanbanIo {
  /**
   * Kanban への 1 操作を実行し、失敗しても warn ログのみで握りつぶす。
   * dispatch/PR watch 等でネットワーク一時失敗が原因のタスク中断を防ぐ。
   */
  safeUpdate: (
    event: string,
    pageId: string,
    fn: (k: KanbanPort) => Promise<void>,
  ) => Promise<void>;
  /**
   * ページの最新 lastEditedTime を state に反映する。expectStatus と実際の
   * status が一致する場合にのみ更新し、他の遷移とレースしないようにする。
   */
  refreshLastEditedTime: (
    event: string,
    pageId: string,
    expectStatus: "done" | "failed" | "needs_info",
  ) => Promise<void>;
  /**
   * 「since より新しく、bot 自身以外が書いた」コメントを取得する。
   * needs_info 回答検知と rework コメント取り込みの両方で共通に使う。
   * 失敗時は warn ログを吐いて空配列を返し、上位はコメントなしで続行する。
   */
  fetchFeedbackComments: (pageId: string, since: string | undefined) => Promise<CommentInfo[]>;
}

export interface KanbanIoDeps {
  kanban: () => KanbanPort;
  log: Logger;
  getState: () => StateFile;
  persist: () => void;
}

export function createKanbanIo(deps: KanbanIoDeps): KanbanIo {
  const safeUpdate: KanbanIo["safeUpdate"] = async (event, pageId, fn) => {
    try {
      await fn(deps.kanban());
    } catch (err) {
      deps.log.warn("kanban_update_error", {
        page_id: pageId,
        msg: `${event}: ${oneLine(String(err))}`,
      });
    }
  };

  const refreshLastEditedTime: KanbanIo["refreshLastEditedTime"] = async (
    event,
    pageId,
    expectStatus,
  ) => {
    await safeUpdate(event, pageId, async (k) => {
      const snapshot = await k.getPage(pageId);
      const state = deps.getState();
      const ps: PageState | undefined = state.pages[pageId];
      if (snapshot.ticket.lastEditedTime && ps?.status === expectStatus) {
        state.pages[pageId] = { ...ps, lastEditedTime: snapshot.ticket.lastEditedTime, updatedAt: nowIso() };
        deps.persist();
      }
    });
  };

  let botUserId: string | null | undefined;

  const fetchFeedbackComments: KanbanIo["fetchFeedbackComments"] = async (pageId, since) => {
    try {
      if (botUserId === undefined) {
        try {
          botUserId = await deps.kanban().getBotUserId();
        } catch {
          botUserId = null;
        }
      }
      const all = await deps.kanban().listComments(pageId);
      return all.filter(
        (c) => (!since || c.createdTime > since) && (botUserId == null || c.authorId !== botUserId),
      );
    } catch (err) {
      deps.log.warn("rework", {
        page_id: pageId,
        msg: `コメント取得失敗（本文のみで続行）: ${oneLine(String(err))}`,
      });
      return [];
    }
  };

  return { safeUpdate, refreshLastEditedTime, fetchFeedbackComments };
}
