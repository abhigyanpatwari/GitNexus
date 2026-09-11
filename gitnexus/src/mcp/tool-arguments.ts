/**
 * MCP tool-argument contract (#3261).
 *
 * `tools/list` advertises `inputSchema`; `tools/call` used to forward any JSON
 * object. A misspelled or CLI-taught key (`depth` instead of `maxDepth`) then
 * produced a well-formed answer computed from the server default — no error,
 * no warning. This module is the single dispatch-time check that the keys a
 * caller sent are ones the advertised schema (or an unpublished handler alias)
 * actually reads.
 */

import { GITNEXUS_TOOLS } from './tools.js';

/** Legacy MCP names that reuse another tool's advertised schema. */
export const LEGACY_TOOL_SCHEMA_SOURCE: Readonly<Record<string, string>> = {
  search: 'query',
  explore: 'context',
};

/**
 * Keys the handler still reads but that must NOT appear in `inputSchema`
 * (#2175: advertising `query` makes Claude Code drop the argument).
 */
export const UNPUBLISHED_TOOL_ARGUMENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  query: ['query'],
  cypher: ['query'],
  // Group-mode context still reads `target` as the symbol name; local
  // `name` is the advertised key. Advertising `target` would collide with
  // impact's target vocabulary and is not in tools/list. Legacy `search`
  // and `explore` inherit via schemaSourceToolName.
  context: ['target'],
};

export interface NumericArgumentAlias {
  canonical: string;
  aliases: readonly string[];
}

/**
 * Numeric aliases that the backend folds onto the advertised canonical key.
 * `depth` is the CLI flag name for `maxDepth` on impact and trace.
 */
export const TOOL_NUMERIC_ARGUMENT_ALIASES: Readonly<
  Record<string, readonly NumericArgumentAlias[]>
> = {
  impact: [{ canonical: 'maxDepth', aliases: ['depth'] }],
  trace: [{ canonical: 'maxDepth', aliases: ['depth'] }],
};

export function schemaSourceToolName(toolName: string): string {
  return LEGACY_TOOL_SCHEMA_SOURCE[toolName] ?? toolName;
}

export function advertisedToolPropertyNames(toolName: string): string[] | undefined {
  const source = schemaSourceToolName(toolName);
  const tool = GITNEXUS_TOOLS.find((entry) => entry.name === source);
  if (!tool) return undefined;
  return Object.keys(tool.inputSchema.properties);
}

function normalizeArgumentKey(key: string): string {
  return key.toLowerCase().replace(/_/gu, '');
}

export function suggestKnownToolArgument(
  unknownKey: string,
  knownKeys: readonly string[],
): string | undefined {
  const needle = normalizeArgumentKey(unknownKey);
  if (!needle) return undefined;
  const exact = knownKeys.find((key) => normalizeArgumentKey(key) === needle);
  if (exact) return exact;
  const contained = knownKeys.filter((key) => {
    const normalized = normalizeArgumentKey(key);
    return normalized.includes(needle) || needle.includes(normalized);
  });
  return contained.length === 1 ? contained[0] : undefined;
}

function formatUnknownArgumentError(
  toolName: string,
  unknownKeys: readonly string[],
  advertisedKeys: readonly string[],
): string {
  const quoted = unknownKeys.map((key) => `"${key}"`).join(', ');
  const noun = unknownKeys.length === 1 ? 'argument' : 'arguments';
  const verb = unknownKeys.length === 1 ? 'does' : 'do';
  const suggestion =
    unknownKeys.length === 1 ? suggestKnownToolArgument(unknownKeys[0], advertisedKeys) : undefined;
  if (suggestion) {
    return `Unknown ${noun} ${quoted} for tool "${toolName}". Did you mean "${suggestion}"?`;
  }
  return (
    `Unknown ${noun} ${quoted} for tool "${toolName}". ` +
    `The advertised inputSchema ${verb} not include ${unknownKeys.length === 1 ? 'this key' : 'these keys'}.`
  );
}

/**
 * Reject top-level tool arguments that are neither advertised nor an
 * unpublished handler alias. `advertisedProperties` should be the schema the
 * caller actually saw (`tools/list` after read-only / repository-policy
 * scrubbing). When it is omitted, the canonical `GITNEXUS_TOOLS` schema is
 * used. Tools with no schema (legacy `overview`) are left unchecked.
 */
export function assertKnownMcpToolArguments(
  toolName: string,
  args: Record<string, unknown> | undefined,
  advertisedProperties?: Record<string, unknown>,
): void {
  if (!args) return;
  const propertyNames =
    advertisedProperties !== undefined
      ? Object.keys(advertisedProperties)
      : advertisedToolPropertyNames(toolName);
  if (!propertyNames) return;

  const unpublished =
    UNPUBLISHED_TOOL_ARGUMENT_ALIASES[toolName] ??
    UNPUBLISHED_TOOL_ARGUMENT_ALIASES[schemaSourceToolName(toolName)] ??
    [];
  const allowed = new Set([...propertyNames, ...unpublished]);
  const unknownKeys = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknownKeys.length === 0) return;
  throw new Error(formatUnknownArgumentError(toolName, unknownKeys, propertyNames));
}

/**
 * Fold numeric aliases onto their canonical key (e.g. `depth` → `maxDepth`).
 * Conflicting values error; a single agreed value is written to the canonical
 * key and the alias keys are removed so every downstream reader sees one name.
 */
export function foldNumericToolArgumentAliases(
  toolName: string,
  params: Record<string, unknown>,
): { params: Record<string, unknown> } | { error: string } {
  const definitions = TOOL_NUMERIC_ARGUMENT_ALIASES[toolName];
  if (!definitions) return { params };

  const normalized = { ...params };
  for (const { canonical, aliases } of definitions) {
    const keys = [canonical, ...aliases];
    const supplied: Array<{ key: string; value: number }> = [];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(normalized, key)) continue;
      const value = normalized[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return { error: `MCP parameter ${toolName}.${key} must be a number.` };
      }
      // #2279: some MCP adapters materialize an omitted optional number as 0.
      // Treat that sentinel as absent so it cannot conflict with a real
      // maxDepth or fold onto params.maxDepth || 3.
      if (value === 0) continue;
      supplied.push({ key, value });
    }
    const distinctValues = new Set(supplied.map(({ value }) => value));
    if (distinctValues.size > 1) {
      return {
        error: `Conflicting MCP parameters for ${toolName}.${canonical}: ${supplied
          .map(({ key }) => key)
          .join(', ')} must agree.`,
      };
    }
    for (const key of aliases) delete normalized[key];
    if (normalized[canonical] === 0) delete normalized[canonical];
    if (supplied.length > 0) normalized[canonical] = supplied[0].value;
  }
  return { params: normalized };
}
