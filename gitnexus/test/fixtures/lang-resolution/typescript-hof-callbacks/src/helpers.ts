// Plain helpers — the targets of HOF-callback calls.
// `transform` is intentionally not a Node.js / browser global so naming
// collisions with built-ins don't pollute the resolution test.
export const fetchData = (): string => 'data';

export const transform = (x: string): string => x.toUpperCase();
