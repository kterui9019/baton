import type { Result } from "../domain/result.ts";
import { err as errResult, ok } from "../domain/result.ts";
import { oneLine } from "../infrastructure/format.ts";

/**
 * Promise を Result に変換する薄いラッパ。例外はメッセージ文字列だけ拾い
 * ok/err の 2 択に落とす。domain 層の Result<T, string> と一貫させたい use-case の
 * IO 呼び出し（workspace / kanban 等）を try/catch なしで直列化するのに使う。
 */
export async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, string>> {
  try {
    return ok(await fn());
  } catch (e) {
    return errResult(oneLine(String(e)));
  }
}
