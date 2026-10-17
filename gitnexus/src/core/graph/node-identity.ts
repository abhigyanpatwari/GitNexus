/** Identity columns must survive CSV encoding and address exactly one node. */
export function assertValidGraphNodeId(id: unknown, context: string): asserts id is string {
  if (typeof id === 'string' && id.trim().length > 0 && !id.includes('\0')) return;
  const sample = typeof id === 'string' ? JSON.stringify(id.slice(0, 120)) : typeof id;
  throw new Error(
    `${context}: invalid graph node ID (${sample}). Index integrity cannot be verified; rebuild with analyze --force.`,
  );
}
