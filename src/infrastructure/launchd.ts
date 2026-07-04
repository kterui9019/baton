import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "./process-runner.ts";
import type { CommandRunner } from "./process-runner.ts";

/** launchd ラベル。`BATON_LABEL` で上書き可能（未設定なら `com.<user>.baton`）。 */
function label(): string {
  return process.env.BATON_LABEL || `com.${process.env.USER ?? "user"}.baton`;
}

function plistPath(lbl: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${lbl}.plist`);
}

function uid(): number {
  return process.getuid?.() ?? 0;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** PATH 上のコマンドを絶対パスへ解決する。見つからなければ throw。 */
async function resolveBin(run: CommandRunner, cmd: string): Promise<string> {
  const res = await run("which", [cmd]);
  const path = res.stdout.trim();
  if (res.code !== 0 || !path) {
    throw new Error(`${cmd} が見つかりません（PATH を確認してください）`);
  }
  return path;
}

function renderPlist(opts: {
  label: string;
  batonBin: string;
  dataHome: string;
  pathEnv: string;
  home: string;
}): string {
  const logsDir = join(opts.dataHome, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(opts.label)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(opts.batonBin)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(opts.dataHome)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xmlEscape(opts.pathEnv)}</string>
        <key>HOME</key>
        <string>${xmlEscape(opts.home)}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${xmlEscape(join(logsDir, "launchd.out.log"))}</string>

    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(logsDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

export interface LaunchdResult {
  label: string;
  plistPath: string;
}

/**
 * baton を launchd に登録して常駐化する。
 * `baton` / `node` / `bun` / `ntn` / `claude` / `gh` / `git` を PATH から解決し、
 * launchd 用の最小 PATH を組み立てた上で plist を書き出す。
 */
export async function installLaunchd(
  dataHome: string,
  run: CommandRunner = runCommand,
): Promise<LaunchdResult> {
  const lbl = label();
  const dst = plistPath(lbl);

  const batonBin = await resolveBin(run, "baton");
  const toolDirs = [dirname(batonBin)];
  // node: bin/baton.js の shebang (#!/usr/bin/env node) の解決に必要
  // bun:  ラッパーが src/main.ts を bun で spawn するのに必要
  for (const tool of ["node", "bun", "ntn", "claude", "gh", "git"]) {
    const dir = dirname(await resolveBin(run, tool));
    if (!toolDirs.includes(dir)) toolDirs.push(dir);
  }
  toolDirs.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");

  mkdirSync(join(dataHome, "logs"), { recursive: true });
  mkdirSync(dirname(dst), { recursive: true });

  const plist = renderPlist({
    label: lbl,
    batonBin,
    dataHome,
    pathEnv: toolDirs.join(":"),
    home: homedir(),
  });
  writeFileSync(dst, plist);

  await run("launchctl", ["bootout", `gui/${uid()}/${lbl}`]);
  const bootstrap = await run("launchctl", ["bootstrap", `gui/${uid()}`, dst]);
  if (bootstrap.code !== 0) {
    throw new Error(`launchctl bootstrap 失敗: ${bootstrap.stderr.trim()}`);
  }
  return { label: lbl, plistPath: dst };
}

/** launchd の登録を解除する。 */
export async function uninstallLaunchd(
  run: CommandRunner = runCommand,
): Promise<LaunchdResult> {
  const lbl = label();
  const dst = plistPath(lbl);
  await run("launchctl", ["bootout", `gui/${uid()}/${lbl}`]);
  if (existsSync(dst)) rmSync(dst);
  return { label: lbl, plistPath: dst };
}
