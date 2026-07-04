import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hhmmss, nowIso } from "./format.ts";
import { shortId } from "../domain/workspace.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  page_id?: string;
  msg?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * JSONL ファイル (`logs/orchestrator.log`) と stdout の 2 系統に書き出す
 * ロガーを組み立てる。可変状態（出力先ファイルパス）はクロージャで保持し、
 * class は使わない。
 */
export function createLogger(dir: string): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "orchestrator.log");

  function write(level: LogLevel, event: string, fields: LogFields): void {
    const ts = nowIso();
    const record = { ts, level, event, ...fields };
    const line = JSON.stringify(record);
    try {
      appendFileSync(file, line + "\n");
    } catch {
      // ログ書き込み失敗はオーケストレーションを止めない
    }
    print(level, event, fields);
  }

  function print(level: LogLevel, event: string, fields: LogFields): void {
    const parts = [hhmmss(), level.toUpperCase(), event];
    if (typeof fields.page_id === "string") {
      parts.push(`[${shortId(fields.page_id)}]`);
    }
    if (typeof fields.msg === "string" && fields.msg.length > 0) {
      parts.push(fields.msg);
    }
    const text = parts.join(" ");
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  }

  return {
    info: (event, fields = {}) => write("info", event, fields),
    warn: (event, fields = {}) => write("warn", event, fields),
    error: (event, fields = {}) => write("error", event, fields),
  };
}
