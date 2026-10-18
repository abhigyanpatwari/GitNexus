/** Identity columns must survive CSV encoding and address exactly one node. */
export function assertValidGraphNodeId(id: unknown, context: string): asserts id is string {
  if (
    typeof id === 'string' &&
    id.trim().length > 0 &&
    // CSV normalizes CR and strips these characters. The Unicode flag matches
    // lone surrogates while preserving valid supplementary code points.
    !/[\x00-\x08\x0B-\x1F\x7F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(id)
  )
    return;
  const sample = typeof id === 'string' ? JSON.stringify(id.slice(0, 120)) : typeof id;
  throw new Error(
    `${context}: invalid graph node ID (${sample}). Index integrity cannot be verified; rebuild with analyze --force.`,
  );
}
