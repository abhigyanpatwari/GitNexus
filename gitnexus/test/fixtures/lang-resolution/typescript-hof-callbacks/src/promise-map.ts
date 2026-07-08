import { transform } from './helpers';

// Pattern: call inside `.map` callback inside `Promise.all(...)`.
// Mirrors `clients/web/src/utils/file-upload.ts` `processSelectedFiles`
// from the bug report — `transform` should be reachable as
// `fanOut → transform`.
export const fanOut = async (xs: string[]): Promise<string[]> => {
  return Promise.all(xs.map((x) => transform(x)));
};
