import { z } from "zod";
import type { PrCheck, PrSnapshot } from "../../domain/review.ts";
import { runCommand } from "../../infrastructure/process-runner.ts";
import type { CommandRunner } from "../../infrastructure/process-runner.ts";
import type { CodeHostPort } from "../../use-cases/ports/code-host-port.ts";

export function repoSlugFromPrUrl(
  prUrl: string,
): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)(?:[\/?#].*)?$/.exec(
    prUrl,
  );
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

const RawCheckSchema = z
  .object({
    __typename: z.string().optional(),
    context: z.string().optional(),
    state: z.string().optional(),
    targetUrl: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().optional(),
    detailsUrl: z.string().optional(),
  })
  .passthrough();

/** rollup 要素は CheckRun / StatusContext の混在で __typename が欠落する場合もあるため、duck-typing で判別する。 */
function normalizeCheck(raw: unknown): PrCheck {
  const parsed = RawCheckSchema.safeParse(raw);
  const e = parsed.success ? parsed.data : {};
  const isStatusContext =
    e.__typename === "StatusContext" ||
    (e.__typename === undefined && typeof e.context === "string");

  if (isStatusContext) {
    let status: PrCheck["status"];
    if (e.state === "SUCCESS") status = "success";
    else if (e.state === "FAILURE" || e.state === "ERROR") status = "failure";
    else status = "pending";
    return {
      name: e.context ?? "",
      status,
      ...(e.targetUrl ? { detailsUrl: e.targetUrl } : {}),
    };
  }

  let status: PrCheck["status"];
  if (e.status !== "COMPLETED") {
    status = "pending";
  } else if (
    e.conclusion === "SUCCESS" ||
    e.conclusion === "NEUTRAL" ||
    e.conclusion === "SKIPPED"
  ) {
    status = "success";
  } else if (
    e.conclusion === "FAILURE" ||
    e.conclusion === "CANCELLED" ||
    e.conclusion === "TIMED_OUT" ||
    e.conclusion === "ACTION_REQUIRED"
  ) {
    status = "failure";
  } else {
    status = "pending";
  }
  return {
    name: e.name ?? "",
    status,
    ...(e.detailsUrl ? { detailsUrl: e.detailsUrl } : {}),
  };
}

const GhPrViewSchema = z.object({
  headRefOid: z.string().optional(),
  statusCheckRollup: z.array(z.unknown()).nullish(),
});

/** `gh pr view --json statusCheckRollup,headRefOid` の出力をパースする。不正入力は null。 */
export function parsePrSnapshot(json: unknown): PrSnapshot | null {
  const parsed = GhPrViewSchema.safeParse(json);
  if (!parsed.success) return null;
  const j = parsed.data;
  const checks = Array.isArray(j.statusCheckRollup)
    ? j.statusCheckRollup.map(normalizeCheck)
    : [];
  return {
    headSha: j.headRefOid ?? "",
    checks,
  };
}

export function extractRunId(detailsUrl: string | undefined): string | null {
  if (!detailsUrl) return null;
  const m = /\/actions\/runs\/(\d+)/.exec(detailsUrl);
  return m ? m[1]! : null;
}

const TRUNCATE_MARKER = "…(先頭省略)…\n";

/** ログを末尾優先で maxChars に切り詰める。 */
export function truncateLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATE_MARKER.length) {
    return text.slice(text.length - Math.max(0, maxChars));
  }
  return (
    TRUNCATE_MARKER + text.slice(text.length - (maxChars - TRUNCATE_MARKER.length))
  );
}

const GH_TIMEOUT_MS = 30_000;
const PER_CHECK_LOG_CHARS = 3_000;
const TOTAL_LOG_CHARS = 8_000;

export interface GhClientOptions {
  ghCommand: string;
  timeoutMs?: number;
}

/** gh CLI による CodeHostPort 実装を組み立てる。 */
export function createGitHubCodeHostAdapter(
  opts: GhClientOptions,
  run: CommandRunner = runCommand,
): CodeHostPort {
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;

  async function fetchPrSnapshot(prUrl: string): Promise<PrSnapshot | null> {
    try {
      const res = await run(
        opts.ghCommand,
        ["pr", "view", prUrl, "--json", "statusCheckRollup,headRefOid"],
        { timeoutMs },
      );
      if (res.code !== 0) return null;
      return parsePrSnapshot(JSON.parse(res.stdout));
    } catch {
      return null;
    }
  }

  async function fetchFailedCheckLogs(
    prUrl: string,
    failed: PrCheck[],
  ): Promise<string> {
    const slug = repoSlugFromPrUrl(prUrl);
    const sections: string[] = [];
    for (const check of failed) {
      const fallback = `${check.name}: ${check.detailsUrl ?? "(詳細URLなし)"}`;
      const runId = extractRunId(check.detailsUrl);
      if (!runId || !slug) {
        sections.push(fallback);
        continue;
      }
      try {
        const res = await run(
          opts.ghCommand,
          [
            "run",
            "view",
            runId,
            "--log-failed",
            "-R",
            `${slug.owner}/${slug.repo}`,
          ],
          { timeoutMs },
        );
        if (res.code !== 0) {
          sections.push(fallback);
          continue;
        }
        sections.push(
          `### ${check.name}\n${truncateLog(res.stdout, PER_CHECK_LOG_CHARS)}`,
        );
      } catch {
        sections.push(fallback);
      }
    }
    return truncateLog(sections.join("\n\n"), TOTAL_LOG_CHARS);
  }

  return { fetchPrSnapshot, fetchFailedCheckLogs };
}
