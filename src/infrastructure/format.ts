import { homedir } from "node:os";
import { join } from "node:path";

/** 先頭の `~` をホームディレクトリに展開する。 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * ユーザーデータ（config.json / state / logs / workspaces）の置き場所。
 * `$XDG_CONFIG_HOME/baton`、無ければ `~/.config/baton`。
 * インストール先（パッケージのコード）とは独立させ、グローバルインストール後も
 * ユーザーごとの状態を一箇所に固定する。
 */
export function resolveDataHome(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "baton");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** `HH:MM`（ローカル時刻）。カンバン側の表示用。 */
export function hhmm(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** `HH:MM:SS`（ローカル時刻）。stdout ログ用。 */
export function hhmmss(date: Date = new Date()): string {
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${hhmm(date)}:${s}`;
}

/** 文字列を末尾 n 文字に切り詰める（ログ/コメント用）。 */
export function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

/** 一行に収めるための短縮（エラーメッセージ表示用）。 */
export function oneLine(s: string, n = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}
