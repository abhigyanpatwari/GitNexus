/**
 * LadybugDB Schema Definitions
 *
 * Hybrid Schema:
 * - Separate node tables for each code element type (File, Function, Class, etc.)
 * - Single CodeRelation table with 'type' property for all relationships
 *
 * This allows LLMs to write natural Cypher queries like:
 *   MATCH (f:Function)-[r:CodeRelation {type: 'CALLS'}]->(g:Function) RETURN f, g
 */

import { createHash } from 'crypto';
// Import from shared package (single source of truth) — used in DDL templates below
import { NODE_TABLES, REL_TABLE_NAME, REL_TYPES, EMBEDDING_TABLE_NAME } from 'gitnexus-shared';
import type { NodeLabel, NodeTableName } from 'gitnexus-shared';
import { parseRelationSchemaPairs } from './rel-pair-routing.js';
import { LINKABLE_LABELS } from '../ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { CALL_TARGET_TYPES } from '../ingestion/model/symbol-table.js';
// Re-export so downstream consumers keep the same import path
export { NODE_TABLES, REL_TABLE_NAME, REL_TYPES, EMBEDDING_TABLE_NAME };
export type { NodeTableName, RelType } from 'gitnexus-shared';

// ============================================================================
// NODE TABLE SCHEMAS
// ============================================================================

export const FILE_SCHEMA = `
CREATE NODE TABLE File (
  id STRING,
  name STRING,
  filePath STRING,
  content STRING,
  PRIMARY KEY (id)
)`;

export const FOLDER_SCHEMA = `
CREATE NODE TABLE Folder (
  id STRING,
  name STRING,
  filePath STRING,
  PRIMARY KEY (id)
)`;

export const FUNCTION_SCHEMA = `
CREATE NODE TABLE Function (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  convexEndpointFactory STRING,
  PRIMARY KEY (id)
)`;

export const CLASS_SCHEMA = `
CREATE NODE TABLE Class (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  frameworkAnnotations STRING[],
  PRIMARY KEY (id)
)`;

export const INTERFACE_SCHEMA = `
CREATE NODE TABLE Interface (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const METHOD_SCHEMA = `
CREATE NODE TABLE Method (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  parameterCount INT32,
  returnType STRING,
  PRIMARY KEY (id)
)`;

export const CODE_ELEMENT_SCHEMA = `
CREATE NODE TABLE CodeElement (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// COMMUNITY NODE TABLE (for Leiden algorithm clusters)
// ============================================================================

export const COMMUNITY_SCHEMA = `
CREATE NODE TABLE Community (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  keywords STRING[],
  description STRING,
  enrichedBy STRING,
  cohesion DOUBLE,
  symbolCount INT32,
  PRIMARY KEY (id)
)`;

// ============================================================================
// PROCESS NODE TABLE (for execution flow detection)
// ============================================================================

export const PROCESS_SCHEMA = `
CREATE NODE TABLE Process (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  processType STRING,
  stepCount INT32,
  communities STRING[],
  entryPointId STRING,
  terminalId STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// MULTI-LANGUAGE NODE TABLE SCHEMAS
// ============================================================================

// Generic code element with startLine/endLine for C, C++, Rust, Go, Java, C#
// description: optional metadata (e.g. Eloquent $fillable fields, relationship targets)
const CODE_ELEMENT_BASE = (name: string) => `
CREATE NODE TABLE \`${name}\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const STRUCT_SCHEMA = CODE_ELEMENT_BASE('Struct');
export const ENUM_SCHEMA = CODE_ELEMENT_BASE('Enum');
export const MACRO_SCHEMA = CODE_ELEMENT_BASE('Macro');
export const TYPEDEF_SCHEMA = CODE_ELEMENT_BASE('Typedef');
export const UNION_SCHEMA = CODE_ELEMENT_BASE('Union');
export const NAMESPACE_SCHEMA = CODE_ELEMENT_BASE('Namespace');
export const TRAIT_SCHEMA = CODE_ELEMENT_BASE('Trait');
export const IMPL_SCHEMA = CODE_ELEMENT_BASE('Impl');
export const TYPE_ALIAS_SCHEMA = CODE_ELEMENT_BASE('TypeAlias');
export const CONST_SCHEMA = `
CREATE NODE TABLE \`Const\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  description STRING,
  convexEndpointFactory STRING,
  PRIMARY KEY (id)
)`;
export const STATIC_SCHEMA = CODE_ELEMENT_BASE('Static');
export const VARIABLE_SCHEMA = CODE_ELEMENT_BASE('Variable');
export const PROPERTY_SCHEMA = `
CREATE NODE TABLE \`Property\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  description STRING,
  declaredType STRING,
  /*
   * DETAIL SYMBOL — true when this property is a member of a shape that has no
   * independent identity: the keys of an anonymous literal returned from a
   * function (R3-4).
   *
   * It exists because indexing those keys is right for the GRAPH and wrong for
   * TEXT SEARCH. They are ordinary words (message, value, timestamp) and
   * there are many of them, so letting them into the FTS result set pushes the
   * CALLABLES named after the same concept past the row cap the search applies
   * — measured: query('message') went from two processes to none on the
   * mini-repo fixture. A ranking tweak cannot fix that, because the rows never
   * come back from the FTS call in the first place.
   *
   * So the search layer gained a notion it did not have — a symbol that is
   * queryable, walkable and impact-analysable, but not a concept a text search
   * should surface on its own. buildFtsQueryCypher excludes these for the
   * Property table only; every other consumer sees them normally.
   */
  isDetail BOOLEAN,
  PRIMARY KEY (id)
)`;
export const RECORD_SCHEMA = CODE_ELEMENT_BASE('Record');
export const DELEGATE_SCHEMA = CODE_ELEMENT_BASE('Delegate');
export const ANNOTATION_SCHEMA = CODE_ELEMENT_BASE('Annotation');
export const CONSTRUCTOR_SCHEMA = CODE_ELEMENT_BASE('Constructor');
export const TEMPLATE_SCHEMA = CODE_ELEMENT_BASE('Template');
export const MODULE_SCHEMA = CODE_ELEMENT_BASE('Module');
// API route endpoints (Next.js, Express, etc.)
export const ROUTE_SCHEMA = `
CREATE NODE TABLE Route (
  id STRING,
  name STRING,
  filePath STRING,
  responseKeys STRING[],
  errorKeys STRING[],
  middleware STRING[],
  method STRING,
  handlerSymbolId STRING,
  runtimeConfirmed BOOLEAN,
  runtimeSource STRING,
  runtimeStatus STRING,
  PRIMARY KEY (id)
)`;

// MCP tool definitions
export const TOOL_SCHEMA = `
CREATE NODE TABLE Tool (
  id STRING,
  name STRING,
  filePath STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// Markdown heading sections
export const SECTION_SCHEMA = `
CREATE NODE TABLE Section (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  level INT64,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// Taint/PDG substrate (issue #2080) — intra-procedural control-flow node.
// Emitted by no phase yet; M1 (#2081) populates these behind an opt-in.
// REACHING_DEF carries its variable name in the relation's existing `reason`
// column (see RELATION_SCHEMA) — LadybugDB has no secondary index on rel
// properties, so a dedicated indexed column would buy nothing for the
// variable-filtered path query (M0/S1 verdict). No `name` column: blocks are
// identified by id + source span, not a symbol name.
export const BASICBLOCK_SCHEMA = `
CREATE NODE TABLE BasicBlock (
  id STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  text STRING,
  callees STRING,
  calleeIds STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// RELATION TABLE SCHEMA
// Single table with 'type' property - connects all node tables
// ============================================================================

/**
 * Labels the scope-resolution graph bridge can put on the SOURCE side of a
 * CALLS / ACCESSES / USES / EXTENDS edge: everything `buildGraphNodeLookup`
 * registers (`LINKABLE_LABELS`), plus the `File` node `resolveCallerGraphId`
 * falls back to for a module-level call site.
 *
 * Imported from the ingestion layer, NOT re-listed here: a hand-copied twin is
 * pure drift risk, since a label added to it (or dropped from the original) is
 * invisible to every guard. `csv-generator.ts` and `lbug-adapter.ts`, both
 * siblings in this directory, already import from `../ingestion/`.
 *
 * The cost is that importing this module pulls five ingestion modules into the
 * runtime closure. `gitnexus-web` does not depend on this package at all (only
 * on `gitnexus-shared`), so nothing here reaches a browser bundle. The MCP
 * server still pays it, though: `local-backend.ts` no longer imports this
 * module directly (its two embedding constants come from `gitnexus-shared`),
 * but pool-adapter -> lbug-adapter -> csv-generator reaches it anyway.
 */
const SCOPE_BRIDGE_SOURCE_LABELS: readonly NodeLabel[] = ['File', ...LINKABLE_LABELS];

/**
 * Labels the bridge can put on the TARGET side: `LINKABLE_LABELS` again (every
 * `resolveDefGraphId` hit), plus `CALL_TARGET_TYPES` —
 * `tryEmitEdgeWithExplicitTargetId` bypasses the lookup and emits such a def's
 * own node id, and C# `Delegate` is in that set without being linkable.
 *
 * Both sets are `NodeLabel`-typed rather than `NodeTableName`-typed because
 * that is what the originals carry, and `NodeLabel` is the wider union — it
 * admits five labels with no node table (`Project`, `Package`, `Decorator`,
 * `Import`, `Type`). A label from that gap would emit DDL naming a table that
 * does not exist, so `test/unit/schema-pair-coverage.test.ts` asserts every
 * declared endpoint against `NODE_TABLES`. The hand-written sets below take the
 * narrower `NodeTableName` constraint, where a typo is the actual risk.
 */
const SCOPE_BRIDGE_TARGET_LABELS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  ...LINKABLE_LABELS,
  ...CALL_TARGET_TYPES,
]);

/**
 * Node tables that are NOT definitions.
 *
 *  - `Community` / `Process` are analysis overlays synthesized after ingestion;
 *    nothing is ever attached to one, they are only attached TO.
 *  - `Route` / `Tool` are framework overlays. They do source exactly two edges
 *    — `ENTRY_POINT_OF` to a `Process` (`pipeline-phases/processes.ts`) — but
 *    that emitter hard-codes both labels as literals in one file rather than
 *    resolving an anchor through a lookup, so those two pairs stay in
 *    {@link STRUCTURAL_PAIR_DDL}. Admitting them as anchors would mint twelve
 *    further pairs (`Route→Annotation`, `Tool→Record`, …) no emitter can reach.
 *  - `Folder` is a filesystem container (`Folder→Folder` / `Folder→File` only).
 *  - `BasicBlock` is the PDG substrate (`BasicBlock→BasicBlock` only; measured
 *    over 300k PDG edges, no other pair is emitted).
 */
const NON_DEFINITION_LABELS: readonly NodeTableName[] = [
  'Community',
  'Process',
  'Route',
  'Tool',
  'Folder',
  'BasicBlock',
];

/**
 * Every label a DEFINITION node can carry — derived from `NODE_TABLES` by
 * subtraction so a new node table joins this set automatically and only an
 * explicit entry above can keep it out.
 */
const DEFINITION_ANCHOR_LABELS: readonly NodeTableName[] = NODE_TABLES.filter(
  (label) => !NON_DEFINITION_LABELS.includes(label),
);

/**
 * Labels whose nodes are minted OUTSIDE the scope-resolution bridge, by a
 * phase or framework emitter, and then hung off whichever definition node that
 * emitter happened to resolve. For most of them the anchor is a LOOKUP RESULT,
 * so its label is not constrained by the emitter — which is exactly why
 * hand-listing these pairs has crashed `analyze` four separate times:
 *
 *  | target       | emitter                                        | anchor comes from                     |
 *  |--------------|------------------------------------------------|---------------------------------------|
 *  | `Annotation` | `frameworks/spring/conditionals.ts` CONDITIONAL_ON | `resolveDefGraphId` / `resolveCallerGraphId` |
 *  | `Community`  | `pipeline-phases/communities.ts` MEMBER_OF     | Leiden membership, `isCommunitySymbol`-gated |
 *  | `Process`    | `pipeline-phases/processes.ts` STEP_IN_PROCESS | trace step node                       |
 *  | `Route`      | `pipeline-phases/routes.ts` HANDLES_ROUTE      | `generateId('File', handlerPath)` — a literal — plus, when the route's handler resolves, that definition |
 *  | `Tool`       | `pipeline-phases/tools.ts` HANDLES_TOOL        | `handlerNodeId` — whatever definition the decorator sat on |
 *  | `File`       | `languages/vue/scope-resolver.ts` BINDS_EVENT_HANDLER | handler node                    |
 *  | `Record`     | `cobol-processor.ts` × 8 external-resource sites | `scopedCallerLookup`                |
 *
 * The four reproduced hard-aborts are one cell of this table each:
 * `Method→Annotation` (Spring `@Bean` + `@ConditionalOnMissingBean`),
 * `Method→File` (Vue Options-API handler), `Namespace→Record` (COBOL
 * `DECLARATIVES`), `Class→Tool` (`@mcp.tool()` on a class). Declaring
 * {@link DEFINITION_ANCHOR_LABELS} × this set covers all four plus every
 * sibling the same emitters can reach.
 *
 * TWO TARGETS USE ONLY PART OF THEIR CROSS PRODUCT TODAY, and it over-declares
 * for them ON PURPOSE (~45 of the 182 attachment pairs have no emitter that can
 * reach them right now):
 *  - `Community` — `isCommunitySymbol` (`community-processor.ts`) admits only
 *    `Function` / `Class` / `Method` / `Interface` as members, so the other 22
 *    anchors cannot source a MEMBER_OF edge until that predicate widens.
 *  - `Route` — HANDLES_ROUTE always sources the literal
 *    `generateId('File', handlerPath)`, and additionally the route's HANDLER
 *    DEFINITION whenever `routeHandlerSymbols` produced an id that
 *    `ctx.graph.getNode` confirms is in the graph. That second anchor is a
 *    lookup result the emitter never label-checks; handler resolution returns
 *    `Function` / `Method` definitions today, so `Route` is no longer a
 *    `File`-only target and the remaining anchors are headroom.
 *
 * Those pairs stay declared because the two sides of the error are not
 * symmetric: an UNDECLARED pair makes LadybugDB reject the edge and aborts
 * `analyze` outright on a user's repo, while an unused DECLARED pair costs
 * almost nothing — `bench/schema-pairs` measured the pre-#2801 332→450 growth
 * (118 pairs, of which these ~45 are a part) at 0.93–1.05×, i.e. inside
 * run-to-run noise. #2801's 11 generated `Record` pairs bring the total to 461.
 * Its Windows measurements and noise caveats live in the benchmark README; the
 * operational production ceiling is the checked 1.5× budget.
 * Every one of the four aborts above came from re-narrowing a set to what one
 * predicate looked like it allowed — so a reading of `isCommunitySymbol` is not
 * grounds to shrink this. `Route` is the worked example in the other direction:
 * the definition-level HANDLES_ROUTE edge started emitting `Function|Route` /
 * `Method|Route` with no DDL change, because those pairs were already declared.
 * Widening `isCommunitySymbol`, or handler resolution returning a further
 * label, is likewise a no-op here.
 *
 * `Route` / `Tool` being excluded as ANCHORS (see {@link NON_DEFINITION_LABELS})
 * is likewise a SIZE choice, not something derived from a rule: they do source
 * `ENTRY_POINT_OF`, and admitting them would mint twelve further pairs no
 * emitter can currently reach.
 *
 * Sized deliberately: this rule plus the `Record` bridge brings the DDL to 461
 * pairs. `bench/schema-pairs` measures real `@ladybugdb/core` with identical
 * data — untyped-endpoint anchored queries
 * (`MATCH (a {id: $id})-[r:CodeRelation]->(b)`, the shape `impact` / `context` /
 * `detect_changes` issue), relative to the 332-pair hand-list it replaced.
 * Keep the historical reference-box and current Windows measurements separate:
 *
 *   reference box: 450 → 0.93–1.05×   641 → 1.22–1.43×   1024 → 2.03–2.34×
 *   Windows:       461 → 1.20–1.42× across three comparable runs
 *
 * Those rows are not a cross-machine ordering. The current operational claim is
 * only that 461 remains below its 1.5× production budget. The historical
 * same-box 450→641 comparison still shows the cost of the deferred third cross
 * product, so the containment half below stays hand-declared. Re-run all
 * candidate sizes on one box and quote the range before proposing that rule.
 */
const ATTACHMENT_TARGET_LABELS: readonly NodeTableName[] = [
  'Annotation',
  'Community',
  'Process',
  'Route',
  'Tool',
  'File',
  'Record',
];

/**
 * The 69 pairs NEITHER rule above generates — everything left after the two
 * cross products are subtracted. Carried by CONTAINMENT, inheritance, imports
 * and DI: a container label crossed with a contained label. No predicate
 * describes that surface (any container can hold any definition).
 *
 * What survives here is characteristic, not arbitrary. Almost all of it is a
 * TARGET no rule reaches — `CodeElement`, `Impl`, `Namespace`, `Template`,
 * `Typedef`, `Union`, `Static`, `Section`, `Folder` are in neither
 * `SCOPE_BRIDGE_TARGET_LABELS` nor {@link ATTACHMENT_TARGET_LABELS} — plus the
 * `Impl|*` and `Template|*` member rows (Rust `impl`/`trait` bodies, C++
 * templates), the two `Route|Process` / `Tool|Process` entry points whose
 * emitter names both labels as literals, and `BasicBlock|BasicBlock`, the PDG
 * substrate.
 *
 * NOTHING A RULE ALREADY COVERS BELONGS HERE. `generatedRelationPairs` skips
 * any pair present in this block, so a redundant line does not merely duplicate
 * — it SUPPRESSES generation, and later narrowing a rule would silently keep
 * that pair alive with no test failing. 166 such lines now live in the generated
 * half (161 from #2793, the three `Record` member pairs moved by #2801/#2871,
 * and the two `TypeAlias` pairs moved by R2-2 here);
 * `test/unit/schema-pair-coverage.test.ts` now fails if one comes back.
 *
 * Those last two arrived by MERGE, and the shape is worth recording because it
 * is the one this block's warning cannot catch by itself. #2871 and this branch
 * each deleted their OWN label's hand-written pairs — `Record` there,
 * `TypeAlias` here — for the identical reason, in the identical region. Git
 * presents that as one conflict in which each side appears to be deleting the
 * other's lines, and "keep ours" or "keep theirs" both resolve cleanly, compile,
 * and silently re-suppress the other label's generation. The correct resolution
 * is neither: take the UNION of the deletions. Verified by asserting all five
 * pairs are still present in the emitted DDL — a check that does not read
 * `LINKABLE_LABELS`, unlike the pair-coverage test, which derives both sides
 * from it and so moves with any change to it.
 *
 * Folding this remainder into a third cross product
 * (`DEFINITION_ANCHOR_LABELS × {CodeElement, Section, Typedef, Union,
 * Namespace, Impl, TypeAlias, Static, Template}`) would take the table to 641
 * pairs and leave only ~29 lines here. `bench/schema-pairs` measures 641 at
 * 1.22–1.43× on the historical reference box; current production's 461 pairs
 * remain below their 1.5× Windows budget. Those cross-machine values are not an
 * ordering, so any proposal must remeasure both sizes on one box. Until then,
 * the rule stays deferred rather than trading ~40 lines for unmeasured query cost.
 *
 * Exported so `test/unit/schema-pair-coverage.test.ts` can subtract it and
 * assert the GENERATED region of the DDL for exact equality against the two
 * rules, rather than one-directional containment.
 * `test/integration/structural-pair-coverage.test.ts` guards this half from a
 * corpus — that is the guard, not this comment.
 */
export const STRUCTURAL_PAIR_DDL = `  FROM File TO Folder,
  FROM File TO CodeElement,
  FROM File TO \`Typedef\`,
  FROM File TO \`Union\`,
  FROM File TO \`Namespace\`,
  FROM File TO \`Impl\`,
  FROM File TO \`Static\`,
  FROM File TO \`Template\`,
  FROM File TO Section,
  FROM Folder TO Folder,
  FROM Folder TO File,
  FROM Function TO \`Template\`,
  FROM Function TO \`Namespace\`,
  FROM Function TO \`Impl\`,
  FROM Function TO \`Typedef\`,
  FROM Function TO \`Union\`,
  FROM Function TO CodeElement,
  FROM Class TO \`Template\`,
  FROM Class TO \`Impl\`,
  FROM Class TO \`Union\`,
  FROM Class TO \`Namespace\`,
  FROM Class TO \`Typedef\`,
  FROM Class TO CodeElement,
  FROM Method TO \`Template\`,
  FROM Method TO \`Namespace\`,
  FROM Method TO \`Impl\`,
  FROM Method TO CodeElement,
  FROM \`Template\` TO \`Template\`,
  FROM \`Template\` TO Function,
  FROM \`Template\` TO Method,
  FROM \`Template\` TO Class,
  FROM \`Template\` TO \`Struct\`,
  FROM \`Template\` TO \`TypeAlias\`,
  FROM \`Template\` TO \`Enum\`,
  FROM \`Template\` TO \`Macro\`,
  FROM \`Template\` TO Interface,
  FROM \`Template\` TO \`Constructor\`,
  FROM \`Module\` TO CodeElement,
  FROM \`Module\` TO \`Namespace\`,
  FROM \`Namespace\` TO Function,
  FROM CodeElement TO CodeElement,
  FROM CodeElement TO \`Module\`,
  FROM CodeElement TO \`Property\`,
  FROM Section TO Section,
  FROM Interface TO CodeElement,
  FROM \`Namespace\` TO \`Struct\`,
  FROM \`Impl\` TO Method,
  FROM \`Impl\` TO Function,
  FROM \`Impl\` TO \`Constructor\`,
  FROM \`Impl\` TO \`Property\`,
  FROM \`Impl\` TO \`Trait\`,
  FROM \`Impl\` TO \`Struct\`,
  FROM \`Impl\` TO \`Impl\`,
  FROM \`Constructor\` TO \`Template\`,
  FROM \`Constructor\` TO \`Impl\`,
  FROM \`Constructor\` TO \`Namespace\`,
  FROM \`Constructor\` TO \`Typedef\`,
  FROM Route TO Process,
  FROM Tool TO Process,
  FROM BasicBlock TO BasicBlock`;

/**
 * The generated half of the DDL — one `  FROM \`x\` TO \`y\`` line per pair of
 * the two cross products below.
 *
 * 1. SCOPE BRIDGE — `SCOPE_BRIDGE_SOURCE_LABELS × SCOPE_BRIDGE_TARGET_LABELS`.
 *    Those sets ARE the bridge's emit surface: `buildGraphNodeLookup` holds
 *    only `LINKABLE_LABELS`, so every id `resolveDefGraphId` returns wears one
 *    of those labels (#2792).
 * 2. ATTACHMENT — `DEFINITION_ANCHOR_LABELS × ATTACHMENT_TARGET_LABELS`, the
 *    phase/framework overlays hung off a resolved anchor (#2793).
 *
 * Generated rather than hand-listed because in both families the endpoint
 * labels are LOOKUP RESULTS, not literals at the emit site — so any pair drawn
 * from the sets can reach `assertDeclaredPair`, and an undeclared one aborts
 * `analyze` outright on whichever codebase happens to produce it. Every
 * hand-listed fix so far declared only the pair in the stack trace and left the
 * rest of its family missing: `Const→Method` (#2781), `Class→Variable` (#2792),
 * `Interface→CodeElement` (#2416), then `Method→Annotation` / `Method→File` /
 * `Namespace→Record` / `Class→Tool` (#2793) — four more from three different
 * emitters, all live at once.
 *
 * A `Set` guards the emit against a DUPLICATED pair — the asymmetric failure
 * mode `rel-pair-routing.ts` documents at length: a duplicate makes LadybugDB
 * reject `CREATE REL TABLE` and kills EVERY `analyze`, where a missing pair only
 * kills the codebases that emit it. The two target sets are disjoint TODAY, so
 * nothing is deduped in practice; the Set is here so that moving one label
 * between the rules can never cause it. Pairs already in
 * {@link STRUCTURAL_PAIR_DDL} are skipped for the same reason.
 */
const generatedPairDdl = (): string => {
  const structural = parseRelationSchemaPairs(STRUCTURAL_PAIR_DDL);
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (from: NodeLabel, to: NodeLabel): void => {
    const pairKey = `${from}|${to}`;
    if (structural.has(pairKey) || seen.has(pairKey)) return;
    seen.add(pairKey);
    lines.push(`  FROM \`${from}\` TO \`${to}\``);
  };
  for (const from of SCOPE_BRIDGE_SOURCE_LABELS) {
    for (const to of SCOPE_BRIDGE_TARGET_LABELS) add(from, to);
  }
  for (const from of DEFINITION_ANCHOR_LABELS) {
    for (const to of ATTACHMENT_TARGET_LABELS) add(from, to);
  }
  return lines.join(',\n');
};

export const RELATION_SCHEMA = `
CREATE REL TABLE ${REL_TABLE_NAME} (
${STRUCTURAL_PAIR_DDL},
${generatedPairDdl()},
  type STRING,
  confidence DOUBLE,
  reason STRING,
  step INT32
)`;

// ============================================================================
// EMBEDDING TABLE SCHEMA
// Separate table for vector storage to avoid copy-on-write overhead
// ============================================================================

/** Embedding vector dimensions. Default 384 (snowflake-arctic-embed-xs). */
const _rawDims = parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '384', 10);
if (Number.isNaN(_rawDims) || _rawDims <= 0) {
  throw new Error(
    `GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${process.env.GITNEXUS_EMBEDDING_DIMS}"`,
  );
}
export const EMBEDDING_DIMS = _rawDims;

/** HNSW vector index name for the CodeEmbedding table. */
export const EMBEDDING_INDEX_NAME = 'code_embedding_idx';

/**
 * Sentinel value for "no content hash available" — used in legacy DBs and null rows.
 * Nodes with this hash are always treated as stale and re-embedded.
 */
export const STALE_HASH_SENTINEL = '';

export const EMBEDDING_SCHEMA = `
CREATE NODE TABLE ${EMBEDDING_TABLE_NAME} (
  id STRING,
  nodeId STRING,
  chunkIndex INT32,
  startLine INT64,
  endLine INT64,
  embedding FLOAT[${EMBEDDING_DIMS}],
  contentHash STRING,
  PRIMARY KEY (id)
)`;

/**
 * Create vector index for semantic search
 * Uses HNSW (Hierarchical Navigable Small World) algorithm with cosine similarity
 */
export const CREATE_VECTOR_INDEX_QUERY = `
CALL CREATE_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}', 'embedding', metric := 'cosine')
`;

// ============================================================================
// ALL SCHEMA QUERIES IN ORDER
// Node tables must be created before relationship tables that reference them
// ============================================================================

export const NODE_SCHEMA_QUERIES = [
  FILE_SCHEMA,
  FOLDER_SCHEMA,
  FUNCTION_SCHEMA,
  CLASS_SCHEMA,
  INTERFACE_SCHEMA,
  METHOD_SCHEMA,
  CODE_ELEMENT_SCHEMA,
  COMMUNITY_SCHEMA,
  PROCESS_SCHEMA,
  // Multi-language support
  STRUCT_SCHEMA,
  ENUM_SCHEMA,
  MACRO_SCHEMA,
  TYPEDEF_SCHEMA,
  UNION_SCHEMA,
  NAMESPACE_SCHEMA,
  TRAIT_SCHEMA,
  IMPL_SCHEMA,
  TYPE_ALIAS_SCHEMA,
  CONST_SCHEMA,
  STATIC_SCHEMA,
  VARIABLE_SCHEMA,
  PROPERTY_SCHEMA,
  RECORD_SCHEMA,
  DELEGATE_SCHEMA,
  ANNOTATION_SCHEMA,
  CONSTRUCTOR_SCHEMA,
  TEMPLATE_SCHEMA,
  MODULE_SCHEMA,
  // Markdown support
  SECTION_SCHEMA,
  // API routes
  ROUTE_SCHEMA,
  // MCP tools
  TOOL_SCHEMA,
  // Taint/PDG substrate (issue #2080) — must be appended here, not just
  // declared above: SCHEMA_QUERIES (the list initLbug actually runs) is built
  // from NODE_SCHEMA_QUERIES. Omitting this leaves the BasicBlock table
  // uncreated and the bulk-COPY round-trip fails with "table does not exist".
  BASICBLOCK_SCHEMA,
];

export const REL_SCHEMA_QUERIES = [RELATION_SCHEMA];

export const SCHEMA_QUERIES = [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES, EMBEDDING_SCHEMA];

/**
 * Digest of the graph DDL this build creates — the exact statements
 * {@link runSchemaCreationQueries} (lbug-adapter.ts) executes for the node and
 * relation tables.
 *
 * This REPLACED `INCREMENTAL_SCHEMA_VERSION` (#2798), a hand-incremented
 * integer in repo-manager.ts that had to PREDICT whether an on-disk database
 * was created from this build's DDL. It could not: the number collided with
 * `main` eight times, twice EXACTLY, and an exact clash was the quiet failure —
 * two builds stamp the same number over different DDL, the strict `===` gate
 * reads the index as current, every `CREATE … TABLE` is skipped as "already
 * exists" (suppressed in `runSchemaCreationQueries`), and the edges whose
 * endpoint pair the live DB cannot persist are dropped by
 * `fallbackRelationshipInserts`' bare `catch`. A wrong graph, not an error.
 *
 * A digest cannot collide BY ACCIDENT at this scale: 12 hex chars is 48 bits,
 * so even 1,000 distinct DDL variants over the project's whole life put the
 * birthday probability of any pair matching at ≈1.8e-9. Two builds agree
 * exactly when their DDL agrees, so concurrent branches never need renumbering.
 * Do not shorten the slice: the odds double per bit dropped. On mismatch —
 * including the ABSENT stamp every pre-#2798 index carries — run-analyze warns
 * and forces a full re-analyze, which wipes the database and recreates the
 * tables from the DDL below.
 *
 * {@link EMBEDDING_SCHEMA} is deliberately EXCLUDED. Its `FLOAT[N]` width comes
 * from `GITNEXUS_EMBEDDING_DIMS` at module load, so folding it in would make
 * this a function of the ENVIRONMENT rather than of code: two runs of the same
 * build under different env would disagree and force alternating full rebuilds.
 * Vector-column drift is therefore a SEPARATE gate, not an ungated hazard:
 * {@link embeddingDimsMismatch} compares the width stamped in
 * `RepoMeta.embeddingDims` against {@link EMBEDDING_DIMS} and run-analyze
 * forces a rebuild on drift. Do not merge the two — an env-derived value in a
 * code digest makes the same build disagree with itself. (The older reaction in
 * run-analyze remains, and is to the CACHE, not the schema: when the cached
 * vectors' length differs from `EMBEDDING_DIMS` it discards the cache and
 * re-embeds.)
 */
export const SCHEMA_FINGERPRINT: string = createHash('sha256')
  .update([...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES].join('\n'))
  .digest('hex')
  .slice(0, 12);

/**
 * Whether an index built under `recorded` can be reused by this build.
 *
 * Lives here rather than in run-analyze so the query side can ask the same
 * question without importing the analyze pipeline — the reason
 * `cjkSegmentationModeMismatch` sits in `core/search/` rather than beside its
 * caller. ABSENT counts as a mismatch: that is the backward-compatibility path
 * for every index written before the field existed, and grandfathering it would
 * stamp a fresh fingerprint onto a database whose DDL was never verified.
 */
export const schemaFingerprintMismatch = (recorded: string | undefined): boolean =>
  recorded !== SCHEMA_FINGERPRINT;

/**
 * Whether a stamped value has the shape {@link SCHEMA_FINGERPRINT} produces —
 * the lowercase-hex prefix of a sha256 digest. The width is read from the live
 * constant, so changing the slice above needs no edit here.
 *
 * Used to decide whether a stamp is worth NAMING in a diagnostic: an index with
 * no fingerprint and one carrying a malformed value are both "not this build",
 * but only the first has an explanation worth printing. Not a comparison gate —
 * {@link schemaFingerprintMismatch} already rejects every value that is not
 * exactly this build's.
 */
export const isSchemaFingerprintShaped = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length === SCHEMA_FINGERPRINT.length &&
  /^[0-9a-f]+$/.test(value);

/**
 * Whether the vector-column width an index's `CodeEmbedding` table was created
 * at (as persisted in `RepoMeta.embeddingDims`) differs from the width this
 * process would embed at ({@link EMBEDDING_DIMS}). The gate
 * {@link SCHEMA_FINGERPRINT} deliberately cannot be: `FLOAT[N]` comes from
 * `GITNEXUS_EMBEDDING_DIMS` at module load, so folding it into a digest of the
 * DDL would make that digest a function of the ENVIRONMENT. Splitting it out
 * here keeps the fingerprint purely code-derived and still gates the width —
 * before this, flipping `GITNEXUS_EMBEDDING_DIMS` on a same-commit clean tree
 * fired no guard at all: `alreadyUpToDate` returned over a `FLOAT[384]` table
 * while the process embedded at 768. (The one pre-existing reaction, in
 * run-analyze, discards the embedding CACHE and re-embeds — into a column whose
 * width was never revisited.) A single scalar, so plain equality suffices.
 *
 * ABSENT does NOT count as a mismatch — the opposite of
 * {@link schemaFingerprintMismatch}, and deliberately:
 *
 *  - Absence carries no signal about the width. A missing fingerprint means
 *    "DDL this build cannot vouch for", and the field ships WITH a DDL change,
 *    so absence is itself evidence of drift. A missing dims stamp means only
 *    "written before the field existed"; the width was whatever that run's env
 *    resolved, almost always the 384 default, and it was consistent with the
 *    table it wrote. Drift needs the env to CHANGE, which absence says nothing
 *    about.
 *  - Forcing on absence would buy no safety anyway. Every index that lacks this
 *    stamp also lacks `schemaFingerprint` (both landed together in #2798), and
 *    that guard already forces a rebuild for exactly those indexes — after
 *    which the width is stamped and the hazard is closed for good. A second
 *    trigger for the same one rebuild is dead weight that would keep firing
 *    forever on any future path that legitimately omits the stamp.
 *  - The cost of guessing wrong is asymmetric: a fleet-wide full re-analyze
 *    (minutes to hours per repo) for a hazard that requires a rare, deliberate
 *    env change.
 *
 * Absence is precisely `undefined`. Any other recorded value that is not this
 * build's width — including a malformed one, since `meta.json` is a schema-less
 * `JSON.parse` of on-disk state — reads as a mismatch and errs toward a
 * rebuild, which is the safe direction.
 *
 * Pure + exported for testing, and takes `current` explicitly rather than
 * closing over {@link EMBEDDING_DIMS}: that constant is frozen at module load,
 * so a parameter is the only way to exercise both sides of the comparison.
 * Lives here rather than in run-analyze for the reason
 * `cjkSegmentationModeMismatch` lives in `core/search/` — a caller that only
 * needs the comparator should not have to pull in the analyze pipeline.
 */
export const embeddingDimsMismatch = (recorded: number | undefined, current: number): boolean =>
  recorded !== undefined && recorded !== current;
