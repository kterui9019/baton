#!/usr/bin/env node
// baton の Node 互換ラッパー。
// 実体は Bun 上で動く src/main.ts。`npm i -g` された環境で Bun が無い場合に
// 分かりやすいエラーを出し、Bun があれば bun 経由で起動する。
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// bin/ の親ディレクトリがパッケージのインストール先
const installRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mainPath = join(installRoot, "src", "main.ts");

// Bun が PATH にあるか確認する
const check = spawnSync("bun", ["--version"], { stdio: "ignore" });
if (check.error || check.status !== 0) {
  console.error("baton の実行には Bun (>= 1.3) が必要です。");
  console.error("https://bun.sh からインストールしてください。");
  process.exit(1);
}

const child = spawn("bun", [mainPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// launchd 等がラッパー（このプロセス）へ送るシグナルを子（bun）へ転送する。
// src/main.ts 側の graceful shutdown（SIGTERM ハンドラ）を活かすため、
// ラッパー自身は子の終了を待ってから終了する。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

child.on("exit", (code, signal) => {
  // シグナル終了時は慣例に従い 128 + シグナル番号を返す
  if (signal) {
    process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  } else {
    process.exitCode = code ?? 1;
  }
});
