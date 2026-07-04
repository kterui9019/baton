import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { expandHome, oneLine, tail } from "../../src/infrastructure/format.ts";

test("expandHome: ~ とパスを展開", () => {
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  expect(expandHome("/abs/path")).toBe("/abs/path");
});

test("tail / oneLine", () => {
  expect(tail("abcdef", 3)).toBe("def");
  expect(oneLine("a\n  b\tc", 100)).toBe("a b c");
  expect(oneLine("abcdef", 3)).toBe("ab…");
});
