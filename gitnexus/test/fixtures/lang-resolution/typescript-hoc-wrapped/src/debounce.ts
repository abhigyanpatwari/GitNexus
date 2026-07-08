// Library-wrapper / utility-HOC form: `debounce`, `throttle`, `once`,
// `memoize` — all share the same shape `const X = wrap(arrow)` and should
// produce a `Function:X` def named after the const.

import { doStuff } from './helpers';

const debounce = <F extends (...args: unknown[]) => unknown>(fn: F, _ms: number): F => fn;

export const debouncedSearch = debounce((query: string) => {
  doStuff(query.length);
}, 250);
