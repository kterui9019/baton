import type { StateFile } from "../domain/state.ts";
import type { AgentHandle } from "./process-runner.ts";
import { oneLine } from "./format.ts";

/** `baton status` サブコマンドが表示する 1 プロセスの表示行が必要とする最小情報。 */
export interface StatusActiveEntry {
  pageId: string;
  attempt: number;
  handle?: AgentHandle;
}

/**
 * state.json と in-memory の active プロセス一覧をコンソール出力する。
 * 表示専用（副作用は console.log のみ）で orchestrator のドメイン操作から独立。
 */
export function printStatus(state: StateFile, active: StatusActiveEntry[]): void {
  const pages = Object.entries(state.pages);
  console.log(`baton status`);
  console.log(`pages: ${pages.length}`);
  for (const [pageId, ps] of pages) {
    const extra: string[] = [`attempt=${ps.attempt}`];
    if (ps.status === "retry_queued") {
      const waitS = Math.max(0, Math.round((ps.retryAt - Date.now()) / 1000));
      extra.push(`retryIn=${waitS}s`);
    }
    if (ps.status === "needs_info") {
      extra.push(`askedAt=${ps.questionAskedAt}`);
      if (ps.question) extra.push(`Q: ${oneLine(ps.question, 60)}`);
    }
    if (ps.prWatch) {
      extra.push(
        `prWatch=${ps.prWatch.phase} ciReworks=${ps.prWatch.autoReworkCount}${
          ps.prWatch.awaitingHuman ? " awaitingHuman" : ""
        }`,
      );
    }
    if (ps.prUrl) extra.push(ps.prUrl);
    if (ps.branch) extra.push(ps.branch);
    console.log(`  ${pageId}  ${ps.status.padEnd(12)} ${extra.join(" ")}`);
  }
  const running = active.filter((e) => e.handle);
  console.log(`running processes (this instance): ${running.length}`);
  for (const e of running) {
    console.log(`  ${e.pageId}  pid=${e.handle?.pid ?? "-"} attempt=${e.attempt}`);
  }
}
