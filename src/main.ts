import { existsSync, cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOrchestrator } from "./composition.ts";
import { createConfigManager, validateConfig } from "./infrastructure/config.ts";
import { oneLine, resolveDataHome, sleep } from "./infrastructure/format.ts";
import { installLaunchd, uninstallLaunchd } from "./infrastructure/launchd.ts";
import { createLogger } from "./infrastructure/logger.ts";

type Command = "run" | "status" | "init" | "launchd-install" | "launchd-uninstall";

interface CliArgs {
  command: Command;
  once: boolean;
  dryRun: boolean;
  configPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command: Command = ((): Command => {
    if (args[0] === "status") return "status";
    if (args[0] === "init") return "init";
    if (args[0] === "launchd" && args[1] === "install") return "launchd-install";
    if (args[0] === "launchd" && args[1] === "uninstall") return "launchd-uninstall";
    return "run";
  })();
  const once = args.includes("--once");
  const dryRun = args.includes("--dry-run");
  let configPath: string | undefined;
  const ci = args.indexOf("--config");
  if (ci >= 0) {
    const next = args[ci + 1];
    if (next) configPath = resolve(next);
  }
  return { command, once, dryRun, configPath };
}

/** パッケージのインストール先（コード自体の場所）。デフォルト資産（prompts/, config.example.json）の参照にのみ使う。 */
function installRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(here);
}

/** `baton init`: dataHome を作成し、config.example.json / prompts をひな形としてコピーする。 */
function runInit(installRoot: string, dataHome: string): void {
  mkdirSync(dataHome, { recursive: true });

  const configPath = join(dataHome, "config.json");
  if (existsSync(configPath)) {
    console.log(`既に存在します（変更なし）: ${configPath}`);
  } else {
    cpSync(join(installRoot, "config.example.json"), configPath);
    console.log(`作成しました: ${configPath}`);
  }

  const promptsDst = join(dataHome, "prompts");
  mkdirSync(promptsDst, { recursive: true });
  for (const file of ["task.md", "system.example.md"]) {
    const dst = join(promptsDst, file);
    if (existsSync(dst)) continue;
    const src = join(installRoot, "prompts", file);
    if (existsSync(src)) cpSync(src, dst);
  }

  console.log("");
  console.log("次の手順:");
  console.log(`  1. ${configPath} を編集（kanban.notion.dataSourceId / repoConfig.<repo>.localDirPath は必須。事前に git clone しておくこと）`);
  console.log("  2. `baton --once --dry-run` で候補検出と設定を確認");
  console.log("  3. 問題なければ `baton launchd install` で常駐化（macOS）");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const installRoot = installRootDir();
  const dataHome = resolveDataHome();

  if (cli.command === "init") {
    runInit(installRoot, dataHome);
    return;
  }

  const configPath = cli.configPath ?? join(dataHome, "config.json");

  if (cli.command === "launchd-install") {
    const res = await installLaunchd(dataHome);
    console.log(`登録完了: ${res.plistPath}`);
    console.log(`状態確認: launchctl print gui/$(id -u)/${res.label} | head -20`);
    console.log(`ログ:     tail -f ${join(dataHome, "logs", "launchd.out.log")}`);
    return;
  }
  if (cli.command === "launchd-uninstall") {
    const res = await uninstallLaunchd();
    console.log(`解除完了: ${res.label}`);
    return;
  }

  if (!existsSync(configPath)) {
    console.error(`config.json が見つかりません: ${configPath}`);
    console.error("`baton init` を実行してセットアップしてください。");
    process.exit(1);
  }

  const logsDir = join(dataHome, "logs");
  const log = createLogger(logsDir);
  const configManager = createConfigManager(configPath, (err) => {
    log.error("config_reload", { msg: `設定読込エラー: ${oneLine(String(err))}` });
  });

  const orch = buildOrchestrator({
    dataHome,
    configManager,
    log,
    dryRun: cli.dryRun,
  });

  if (cli.command === "status") {
    orch.printStatus();
    return;
  }

  const configErrors = validateConfig(configManager.get());
  if (configErrors.length > 0) {
    console.error(`config.json (${configPath}) の設定エラー:`);
    for (const e of configErrors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  if (!cli.dryRun) {
    await orch.recoverOnStartup();
  }

  let shuttingDown = false;
  const onSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("tick", { msg: `${sig} 受信、graceful shutdown 開始` });
    orch
      .shutdown()
      .catch((err) =>
        log.error("tick", { msg: `shutdown エラー: ${oneLine(String(err))}` }),
      )
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  log.info("tick", {
    msg: `起動 dataHome=${dataHome} once=${cli.once} dryRun=${cli.dryRun}`,
  });

  do {
    await orch.tick();
    if (cli.once || shuttingDown) break;
    const interval = configManager.get().pollIntervalMs;
    const until = Date.now() + interval;
    while (Date.now() < until && !shuttingDown) {
      await sleep(Math.min(500, until - Date.now()));
    }
  } while (!shuttingDown);

  if (cli.once && !cli.dryRun && orch.hasActive()) {
    log.info("tick", {
      msg: "--once: 実行中のエージェントを待たずに終了します",
    });
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
