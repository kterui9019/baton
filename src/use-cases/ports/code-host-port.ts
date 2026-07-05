import type { PrCheck, PrSnapshot } from "../../domain/review.ts";

/** コードホスト（GitHub 等）の PR 監視に必要な関数の集合。 */
export type CodeHostPort = {
  fetchPrSnapshot: (prUrl: string) => Promise<PrSnapshot | null>;
  fetchFailedCheckLogs: (
    prUrl: string,
    failed: PrCheck[],
  ) => Promise<string>;
};
