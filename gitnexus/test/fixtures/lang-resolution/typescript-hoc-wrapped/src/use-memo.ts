// `useMemo((...) => value, [deps])` — same shape as useCallback but the
// arrow returns a value instead of a callable. The shape we care about is
// `const X = useMemo(() => { ... }, [...])` and the test is symmetric:
// calls inside should attribute to `computed`.

import { doStuff } from './helpers';

const useMemo = <T>(factory: () => T, _deps: unknown[]): T => factory();

export const computed = useMemo(() => {
  return doStuff(42);
}, []);
