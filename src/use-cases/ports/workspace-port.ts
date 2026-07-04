import type { WorkspaceInfo } from "../../domain/workspace.ts";

/** git worktree（またはそれに相当するもの）でのワークスペース管理を表す関数の集合。 */
export type WorkspacePort = {
  createWorktree: (
    pageId: string,
    title: string,
    repo: string,
  ) => Promise<WorkspaceInfo>;
  setupWorktree: (ws: WorkspaceInfo, repo: string) => Promise<void>;
  removeWorktree: (repoDir: string, path: string) => Promise<void>;
};
