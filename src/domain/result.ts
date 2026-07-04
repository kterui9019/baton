/**
 * 成功か失敗かの二択を持ち回るための Result 型。呼び出し側が原因で分岐したい／
 * try/catch がフロー制御を歪めている箇所で使う。log.warn して既定値で続行するだけの
 * 場所には使わず、そこは薄いラッパー（safeKanban 等）に寄せる。
 */
export type Result<T, E = string> = { type: "ok"; value: T } | { type: "err"; reason: E };

export const ok = <T>(value: T): Result<T, never> => ({ type: "ok", value });
export const err = <E>(reason: E): Result<never, E> => ({ type: "err", reason });
