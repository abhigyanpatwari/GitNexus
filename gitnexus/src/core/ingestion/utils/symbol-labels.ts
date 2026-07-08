import type { NodeLabel } from 'gitnexus-shared';

/**
 * Graph-node labels that represent a resolvable code symbol — a definition with
 * its own source span (function, type, member, module-like container).
 *
 * These get EXACT source-span content in the FTS index: `csv-generator.ts`
 * slices exactly `[startLine, endLine]` for them (no ±2 padding), while every
 * other label keeps the context window. That exactness depends on the 0-based
 * `startLine`/`endLine` invariant enforced by `line-base.ts` — the slice is only
 * correct because all emitters store 0-based lines. Keep the two together.
 *
 * Single source of truth so the set can't silently drift the way the inline copy
 * did in #2379.
 *
 * NOTE: `group/extractors/manifest-extractor.ts`'s `CUSTOM_CONTRACT_RESOLVE_QUERY`
 * carries a near-identical hand-list that is intentionally a SUBSET — it excludes
 * `Namespace`, `Variable`, `Module`. Unifying the two needs a contract-resolution
 * behavior check (would widen which nodes resolve as contract symbols), so it is
 * deliberately left separate for now.
 */
export const SYMBOL_NODE_LABELS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  'Function',
  'Method',
  'Class',
  'Interface',
  'CodeElement',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Variable',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
]);
