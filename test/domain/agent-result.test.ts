import { test, expect } from "bun:test";
import {
  extractPrUrl,
  judgeResult,
  parseFinalJson,
  parseResultFile,
} from "../../src/domain/agent-result.ts";

test("extractPrUrl: GitHub PR URL 抽出", () => {
  expect(
    extractPrUrl("done: https://github.com/kterui9019/sample-app/pull/42 !"),
  ).toBe("https://github.com/kterui9019/sample-app/pull/42");
  expect(extractPrUrl("no url here")).toBeNull();
});

test("parseResultFile: 正常/異常", () => {
  expect(
    parseResultFile('{"status":"success","pr_url":"u","summary":"s"}'),
  ).toEqual({ status: "success", prUrl: "u", summary: "s" });
  expect(parseResultFile('{"status":"failure","summary":"reason"}')).toEqual({
    status: "failure",
    prUrl: undefined,
    summary: "reason",
  });
  expect(parseResultFile("not json")).toBeNull();
  expect(parseResultFile('{"status":"weird"}')).toBeNull();
});

test("judgeResult tier1: result_file 優先", () => {
  const r = judgeResult({
    resultFileText: '{"status":"success","pr_url":"https://github.com/o/r/pull/1"}',
    exitCode: 1,
    stdout: "",
  });
  expect(r.status).toBe("success");
  expect(r.prUrl).toBe("https://github.com/o/r/pull/1");
});

test("judgeResult tier2: exit0 + stdout の PR URL", () => {
  const r = judgeResult({
    resultFileText: null,
    exitCode: 0,
    stdout: JSON.stringify({
      is_error: false,
      result: "created https://github.com/o/r/pull/7",
    }),
  });
  expect(r.status).toBe("success");
  expect(r.prUrl).toBe("https://github.com/o/r/pull/7");
});

test("judgeResult tier2: exit0 だが PR URL なし → failure", () => {
  const r = judgeResult({ resultFileText: null, exitCode: 0, stdout: "{}" });
  expect(r.status).toBe("failure");
  expect(r.reason).toContain("PR URL");
});

test("judgeResult: claude is_error:true → failure", () => {
  const r = judgeResult({
    resultFileText: null,
    exitCode: 0,
    stdout: JSON.stringify({
      is_error: true,
      result: "https://github.com/o/r/pull/9",
    }),
  });
  expect(r.status).toBe("failure");
});

test("judgeResult tier3: 非ゼロ終了 → failure", () => {
  const r = judgeResult({ resultFileText: null, exitCode: 137, stdout: "" });
  expect(r.status).toBe("failure");
  expect(r.reason).toContain("137");
});

test("parseFinalJson: JSONL の末尾 result 行を返す", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant" } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ].join("\n");
  const obj = parseFinalJson(stdout) as { type?: string; is_error?: boolean } | null;
  expect(obj?.type).toBe("result");
  expect(obj?.is_error).toBe(false);
});

test("parseFinalJson: 単一 JSON も 1 行として扱える（後方互換）", () => {
  expect((parseFinalJson('{"is_error":true}') as { is_error?: boolean } | null)?.is_error).toBe(
    true,
  );
});

test("parseFinalJson: 末尾に空行・部分行があっても直近の JSON を拾う", () => {
  const stdout = '{"type":"result","is_error":false}\n{partial\n\n';
  expect((parseFinalJson(stdout) as { type?: string } | null)?.type).toBe("result");
});

test("parseFinalJson: JSON が無ければ null", () => {
  expect(parseFinalJson("not json at all\n")).toBeNull();
});

test("judgeResult tier2: stream-json (JSONL) の最終行 + PR URL で success", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "assistant",
      message: { content: "created https://github.com/o/r/pull/11" },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ].join("\n");
  const r = judgeResult({ resultFileText: null, exitCode: 0, stdout });
  expect(r.status).toBe("success");
  expect(r.prUrl).toBe("https://github.com/o/r/pull/11");
});

test("judgeResult: stream-json の最終行 is_error:true → failure", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: {} }),
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    }),
  ].join("\n");
  const r = judgeResult({ resultFileText: null, exitCode: 0, stdout });
  expect(r.status).toBe("failure");
});

test("parseResultFile: needs_info を受理（question 必須）", () => {
  expect(
    parseResultFile(
      '{"status":"needs_info","question":"A案とB案どちらにしますか","summary":"s"}',
    ),
  ).toEqual({
    status: "needs_info",
    question: "A案とB案どちらにしますか",
    prUrl: undefined,
    summary: "s",
  });
});

test("parseResultFile: needs_info で question 欠落/空なら failure に落とす", () => {
  const missing = parseResultFile('{"status":"needs_info","summary":"s"}');
  expect(missing?.status).toBe("failure");
  expect(missing?.reason).toContain("question");
  const empty = parseResultFile('{"status":"needs_info","question":"  "}');
  expect(empty?.status).toBe("failure");
});

test("judgeResult tier1: result_file の needs_info が優先される", () => {
  const r = judgeResult({
    resultFileText: '{"status":"needs_info","question":"仕様確認"}',
    exitCode: 0,
    stdout: "created https://github.com/o/r/pull/1",
  });
  expect(r.status).toBe("needs_info");
  expect(r.question).toBe("仕様確認");
});
