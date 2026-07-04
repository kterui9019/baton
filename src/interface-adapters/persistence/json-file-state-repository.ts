import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState } from "../../domain/state.ts";
import type { StateFile } from "../../domain/state.ts";
import type { StateRepositoryPort } from "../../use-cases/ports/state-repository-port.ts";

/** state.json を読む。存在しなければ空 state。 */
function loadState(path: string): StateFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as StateFile;
    if (!parsed || typeof parsed !== "object" || !parsed.pages) {
      return emptyState();
    }
    return { version: 1, pages: parsed.pages };
  } catch {
    return emptyState();
  }
}

/** atomic write: tmp に書いて rename。 */
function saveState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** ローカル JSON ファイルによる StateRepositoryPort 実装。 */
export function createJsonFileStateRepository(
  path: string,
): StateRepositoryPort {
  return {
    load: () => loadState(path),
    save: (state) => saveState(path, state),
  };
}
