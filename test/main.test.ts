import { test, expect } from "bun:test";
import { formatHelpText, parseArgs } from "../src/main.ts";

test("parseArgs: -h で help が true", () => {
  const cli = parseArgs(["node", "baton", "-h"]);
  expect(cli.help).toBe(true);
});

test("parseArgs: --help で help が true", () => {
  const cli = parseArgs(["node", "baton", "--help"]);
  expect(cli.help).toBe(true);
});

test("parseArgs: ヘルプ以外では help が false", () => {
  expect(parseArgs(["node", "baton"]).help).toBe(false);
  expect(parseArgs(["node", "baton", "status"]).help).toBe(false);
  expect(parseArgs(["node", "baton", "--once"]).help).toBe(false);
});

test("parseArgs: コマンドとオプションの解析", () => {
  expect(parseArgs(["node", "baton", "status"]).command).toBe("status");
  expect(parseArgs(["node", "baton", "init"]).command).toBe("init");
  expect(parseArgs(["node", "baton", "launchd", "install"]).command).toBe(
    "launchd-install",
  );
  expect(parseArgs(["node", "baton", "--once", "--dry-run"]).once).toBe(true);
  expect(parseArgs(["node", "baton", "--once", "--dry-run"]).dryRun).toBe(true);
  expect(
    parseArgs(["node", "baton", "--config", "/tmp/config.json"]).configPath,
  ).toBe("/tmp/config.json");
});

test("formatHelpText: 主要なコマンドと -h を含む", () => {
  const text = formatHelpText();
  expect(text).toContain("baton");
  expect(text).toContain("status");
  expect(text).toContain("init");
  expect(text).toContain("launchd install");
  expect(text).toContain("-h, --help");
});