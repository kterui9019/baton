import type { StateFile } from "../../domain/state.ts";

/** オーケストレーション状態（state.json 相当）の永続化を表す関数の集合。 */
export type StateRepositoryPort = {
  load: () => StateFile;
  save: (state: StateFile) => void;
};
