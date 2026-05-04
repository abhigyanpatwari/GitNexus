import { transform } from './helpers';

// Pattern: call inside `new Promise((resolve, reject) => ...)` callback.
// Mirrors `fileToDataUrl` from the bug report. The synchronous body of
// the executor invokes `transform` directly — the edge `wrap → transform`
// should exist regardless of the surrounding HOF.
export const wrap = (x: string): Promise<string> =>
  new Promise<string>((resolve) => {
    const v = transform(x);
    resolve(v);
  });
