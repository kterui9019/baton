// bun:test の最小型宣言（tsc が bun:test を解決できるようにするため）。
// 実行は Bun が行う。ここでは型チェックを通すことだけが目的。
declare module "bun:test" {
  type TestFn = () => void | Promise<void>;
  export const test: (name: string, fn: TestFn) => void;
  export const it: (name: string, fn: TestFn) => void;
  export const describe: (name: string, fn: () => void) => void;
  export const expect: (value: unknown) => any;
  export const beforeAll: (fn: TestFn) => void;
  export const afterAll: (fn: TestFn) => void;
  export const beforeEach: (fn: TestFn) => void;
  export const afterEach: (fn: TestFn) => void;
}
