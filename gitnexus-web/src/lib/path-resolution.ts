// Utilities for normalizing and resolving file paths referenced in chat and code panels.
export const normalizePath = (p: string): string => {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '');
};

/**
 * Resolve a user-supplied path (which may be partial) to an exact file path in the repo.
 * Follows the same heuristics previously embedded in useAppState:
 * 1) exact match, 2) ends-with match (prefers shorter paths), 3) segment containment.
 */
export const resolveFilePath = (
  fileContents: Map<string, string>,
  requestedPath: string,
): string | null => {
  const req = normalizePath(requestedPath).toLowerCase();
  if (!req) return null;

  // Exact match first
  for (const key of fileContents.keys()) {
    if (normalizePath(key).toLowerCase() === req) return key;
  }

  // Ends-with match (best for partial paths like "src/foo.ts")
  let best: { path: string; score: number } | null = null;
  for (const key of fileContents.keys()) {
    const norm = normalizePath(key).toLowerCase();
    if (norm.endsWith(req)) {
      const score = 1000 - norm.length; // shorter is better
      if (!best || score > best.score) best = { path: key, score };
    }
  }
  if (best) return best.path;

  // Segment match fallback
  const segs = req.split('/').filter(Boolean);
  for (const key of fileContents.keys()) {
    const normSegs = normalizePath(key).toLowerCase().split('/').filter(Boolean);
    let idx = 0;
    for (const s of segs) {
      const found = normSegs.findIndex((x, i) => i >= idx && x.includes(s));
      if (found === -1) {
        idx = -1;
        break;
      }
      idx = found + 1;
    }
    if (idx !== -1) return key;
  }

  return null;
};
