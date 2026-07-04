/**
 * 例外の型のみ class を用いる（`instanceof` によるナローイングとスタック
 * トレースを両立する標準的な方法が Error のサブクラス化以外に無いため）。
 * 状態・振る舞いを持つコンポーネントに class は使わない、という方針とは別軸。
 */
export class KanbanPageNotFoundError extends Error {
  constructor(pageId: string, options?: { cause?: unknown }) {
    super(`kanban page not found: ${pageId}`, options);
    this.name = "KanbanPageNotFoundError";
  }
}
