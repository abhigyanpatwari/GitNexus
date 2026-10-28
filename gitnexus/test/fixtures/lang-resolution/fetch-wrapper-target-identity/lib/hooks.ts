const memoize = <T>(fn: T): T => fn;
export const memoRequest = memoize((url: string) => fetch(url));
