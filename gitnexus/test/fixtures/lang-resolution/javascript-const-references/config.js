// A2: a module-scope const referenced only as a bare identifier.
const DEFAULT_FETCH_LIMIT = 500;

// Inline-exported form — the common spelling.
export const INLINE_LIMIT = 250;

export function fetchAll(limit = DEFAULT_FETCH_LIMIT) {
  return Math.max(DEFAULT_FETCH_LIMIT, limit);
}

export function pageSize() {
  return DEFAULT_FETCH_LIMIT;
}

export { DEFAULT_FETCH_LIMIT };
