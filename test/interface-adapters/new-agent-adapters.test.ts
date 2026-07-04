import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/infrastructure/config.ts";
import type { Config } from "../../src/infrastructure/config.ts";
import { buildCodexArgs } from "../../src/interface-adapters/codex/codex-agent-adapter.ts";
import { buildGrokArgs } from "../../src/interface-adapters/grok/grok-agent-adapter.ts";
import { buildOpencodeArgs } from "../../src/interface-adapters/opencode/opencode-agent-adapter.ts";

function withAgent(overrides: Partial<Config["agent"]> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, ...overrides },
  };
}

test("buildOpencodeArgs: 通常起動は run と task", () => {
  const cfg = withAgent({
    opencode: { command: "opencode", args: ["--model", "grok-4"] },
  });
  expect(buildOpencodeArgs(cfg, undefined, "hello")).toEqual([
    "run",
    "--model",
    "grok-4",
    "hello",
  ]);
});

test("buildOpencodeArgs: sessionId 指定時は --session を先頭に", () => {
  const cfg = withAgent({ opencode: { command: "opencode", args: [] } });
  expect(buildOpencodeArgs(cfg, "sess-1", "hello")).toEqual([
    "run",
    "--session",
    "sess-1",
    "hello",
  ]);
});

test("buildGrokArgs: 通常起動は -p の末尾に task", () => {
  const cfg = withAgent({ grok: { command: "grok", args: ["--no-auto-update"] } });
  expect(buildGrokArgs(cfg, undefined, "hello")).toEqual([
    "--no-auto-update",
    "-p",
    "hello",
  ]);
});

test("buildGrokArgs: sessionId 指定時は --session-id を先頭に", () => {
  const cfg = withAgent({ grok: { command: "grok", args: [] } });
  expect(buildGrokArgs(cfg, "sess-2", "hello")).toEqual([
    "--session-id",
    "sess-2",
    "-p",
    "hello",
  ]);
});

test("buildCodexArgs: 通常起動は exec と task", () => {
  const cfg = withAgent({ codex: { command: "codex", args: ["--full-auto"] } });
  expect(buildCodexArgs(cfg, undefined, "hello")).toEqual([
    "exec",
    "--full-auto",
    "hello",
  ]);
});

test("buildCodexArgs: sessionId 指定時は exec resume サブコマンド", () => {
  const cfg = withAgent({ codex: { command: "codex", args: ["--full-auto"] } });
  expect(buildCodexArgs(cfg, "sess-3", "hello")).toEqual([
    "exec",
    "resume",
    "sess-3",
    "--full-auto",
    "hello",
  ]);
});
