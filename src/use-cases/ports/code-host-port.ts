import type { PrCheck, PrSnapshot, ReviewInfo } from "../../domain/review.ts";

/** コードホスト（GitHub 等）の PR 監視に必要な関数の集合。 */
export type CodeHostPort = {
  fetchPrSnapshot: (prUrl: string) => Promise<PrSnapshot | null>;
  fetchReviews: (prUrl: string) => Promise<ReviewInfo[]>;
  fetchInlineComments: (prUrl: string) => Promise<ReviewInfo[]>;
  fetchFailedCheckLogs: (
    prUrl: string,
    failed: PrCheck[],
  ) => Promise<string>;
};
