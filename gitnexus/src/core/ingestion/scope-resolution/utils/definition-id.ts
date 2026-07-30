export interface DefinitionIdPosition {
  readonly line: number;
  readonly column: number;
}

/**
 * Extract coordinates from `def:<filePath>#<line>:<column>:<type>:<name>`.
 *
 * File paths are embedded verbatim and may themselves contain fragments such
 * as `#12:34:`, while names may themselves contain `#` (TypeScript private
 * members). Anchor on the known file path so neither side can be mistaken for
 * the declaration separator.
 */
export function definitionIdPosition(
  nodeId: string | undefined,
  filePath: string,
): DefinitionIdPosition | undefined {
  if (nodeId === undefined) return undefined;
  const prefix = `def:${filePath}#`;
  if (!nodeId.startsWith(prefix)) return undefined;
  const match = /^(\d+):(\d+):/.exec(nodeId.slice(prefix.length));
  if (match === null) return undefined;
  return { line: Number(match[1]), column: Number(match[2]) };
}
