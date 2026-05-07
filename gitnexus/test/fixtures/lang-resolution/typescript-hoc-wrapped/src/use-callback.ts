// React Hook callback bound to a const — `useCallback((...) => ..., [deps])`.
// Calls inside the callback body should attribute to `handleClick` /
// `handleSubmit`, the names the developer wrote on the LHS.

import { doStuff, fmt } from './helpers';

const useCallback = <F extends (...args: unknown[]) => unknown>(fn: F, _deps: unknown[]): F => fn;

export const handleClick = useCallback(() => {
  const n = doStuff(1);
  fmt(n);
}, []);

export const handleSubmit = useCallback((value: number) => {
  doStuff(value);
}, []);
