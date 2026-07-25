/**
 * Graph type definitions — single source of truth.
 *
 * Both gitnexus (CLI) and gitnexus-web import from this package.
 * Do NOT add Node.js-specific or browser-specific imports here.
 */

import { SupportedLanguages } from '../languages.js';

export type NodeLabel =
  | 'Project'
  | 'Package'
  | 'Module'
  | 'Folder'
  | 'File'
  | 'Class'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'Interface'
  | 'Enum'
  | 'Decorator'
  | 'Import'
  | 'Type'
  | 'CodeElement'
  | 'Community'
  | 'Process'
  // Multi-language node types
  | 'Struct'
  | 'Macro'
  | 'Typedef'
  | 'Union'
  | 'Namespace'
  | 'Trait'
  | 'Impl'
  | 'TypeAlias'
  | 'Const'
  | 'Static'
  | 'Property'
  | 'Record'
  | 'Delegate'
  | 'Annotation'
  | 'Constructor'
  | 'Template'
  | 'Section'
  | 'Route'
  | 'Tool'
  // Move/Aptos: one EnumVariant node per Move 2 enum variant, linked to its
  // Enum via CONTAINS. Sourced from the move-flow `facts` query.
  | 'EnumVariant'
  // Taint/PDG substrate (issue #2080). Intra-procedural control-flow node.
  // Emitted by no phase yet — M1 (#2081) populates these behind an opt-in.
  | 'BasicBlock';

export type NodeProperties = {
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  language?: SupportedLanguages | string;
  isExported?: boolean;
  astFrameworkMultiplier?: number;
  astFrameworkReason?: string;
  // Community
  heuristicLabel?: string;
  cohesion?: number;
  symbolCount?: number;
  keywords?: string[];
  description?: string;
  enrichedBy?: 'heuristic' | 'llm';
  // Process
  processType?: 'intra_community' | 'cross_community';
  stepCount?: number;
  communities?: string[];
  entryPointId?: string;
  terminalId?: string;
  entryPointScore?: number;
  entryPointReason?: string;
  // Method/property
  parameterCount?: number;
  level?: number;
  returnType?: string;
  declaredType?: string;
  /** Verbatim declared-type source text with generics preserved
   *  (e.g. `List<Shape>` where `declaredType` is the stripped `List`). */
  rawDeclaredType?: string;
  visibility?: string;
  isStatic?: boolean;
  isReadonly?: boolean;
  isAbstract?: boolean;
  isFinal?: boolean;
  isVirtual?: boolean;
  isOverride?: boolean;
  isAsync?: boolean;
  isPartial?: boolean;
  annotations?: string[];
  // Route/response
  responseKeys?: string[];
  errorKeys?: string[];
  middleware?: string[];
  // ── Move/Aptos (compiler-first, sourced from the move-flow `facts` query) ──
  // All fields below are populated by the thin facts→graph mapper. They are
  // optional and additive; non-Move nodes never set them.
  qualifiedName?: string;
  moduleQualifiedName?: string;
  moduleAddress?: string;
  visibilityModifier?: string;
  isEntry?: boolean;
  isView?: boolean;
  isInline?: boolean;
  isNative?: boolean;
  isResource?: boolean;
  isEvent?: boolean;
  isTest?: boolean;
  isTestOnly?: boolean;
  hasSpec?: boolean;
  /** Subset of {'copy','drop','store','key'} — Move struct/enum abilities. */
  abilities?: string[];
  /** Resource qualified names from `acquiresInferred` (move-flow facts). */
  acquires?: string[];
  /** Generic type parameters (facts `typeParams`: abilities → constraints). */
  typeParams?: Array<{ name: string; constraints?: string[]; isPhantom?: boolean }>;
  /** Resource qualified names reached transitively (move-flow function_usage). */
  usedTypes?: string[];
  /** Full attribute name list (`["view","event","test_only",...]`). */
  attributes?: string[];
  /** Full attribute payload as JSON - nested `args` and assignment `value`s,
   *  e.g. `[{"name":"resource_group_member","args":[{"name":"group","value":"0xa::vault::Group"}]}]`.
   *  Persisted without a code consumer, deliberately: preserving attribute
   *  args/values is the whole point, and the raw Cypher surface (MCP `cypher`
   *  tool) makes the column user-queryable directly - re-deriving it later
   *  would cost another full re-index. Unset (not `"[]"`) when the symbol has
   *  no attributes. */
  attributesJson?: string;
  /** Parsed `#[expected_failure(...)]` payload (true for the bare form). */
  expectedFailure?: true | Record<string, string>;
  /** Move 1 vs Move 2 distinction: `'struct'` or `'enum'`. */
  moveDeclarationKind?: 'struct' | 'enum';
  /** EnumVariant shape (facts `variants[].kind`). */
  variantKind?: 'unit' | 'positional' | 'named';
  /** Struct / variant fields (facts `fields`: name/type/positional). */
  fields?: Array<{ name: string; type: string; positional?: boolean }>;
  /**
   * Node-location precision. `'precise'` = per-symbol file/span from the
   * move-flow `facts` query; `'module'` = only the containing module/type file
   * is known; `'package'` = coarse package-root fallback; `'external'` =
   * declaration belongs to a dependency outside the indexed repository.
   */
  locationFidelity?: 'precise' | 'module' | 'package' | 'external';
  // BasicBlock (taint/PDG substrate, issue #2080) — reuses filePath/startLine/endLine.
  text?: string;
  /** BasicBlock: space-joined leaf callee names invoked in the block — the
   *  statement-precise inter-procedural reach substrate for impact mode. */
  callees?: string;
  // Extensible
  [key: string]: unknown;
};

export type RelationshipType =
  | 'CONTAINS'
  | 'CALLS'
  | 'INHERITS'
  | 'METHOD_OVERRIDES'
  | 'OVERRIDES'
  | 'METHOD_IMPLEMENTS'
  | 'IMPORTS'
  | 'USES'
  | 'DEFINES'
  | 'DECORATES'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'HAS_METHOD'
  | 'HAS_PROPERTY'
  | 'ACCESSES'
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'
  | 'HANDLES_ROUTE'
  | 'FETCHES'
  | 'HANDLES_TOOL'
  | 'ENTRY_POINT_OF'
  | 'WRAPS'
  | 'QUERIES'
  /** Dependency-injection edge: a consumer class receives a likely provider
   *  through constructor, field, method, or collection injection. A
   *  per-language resolver identifies the site and provider metadata; the
   *  shared DI phase uses type heritage, qualifier names, and preferred
   *  provider markers to resolve it. Ambiguous single injection is represented
   *  by multiple lower-confidence edges instead of a fabricated exact target.
   *  Source = the consumer Class node (the one owning the injection site).
   *  Target = a concrete provider Class node.
   *  Framework specifics live in the `reason` payload (e.g.
   *  `Spring DI: @Autowired List<T>`), not in this type contract.
   *  Lets Cypher queries trace which beans the container injects into a given
   *  consumer, complementing the structural `IMPLEMENTS` heritage edges. */
  | 'INJECTS'
  /** Vue component event system: a handler function in a parent component is
   *  bound to an event emitted by a child component (`@event="handlerFn"`).
   *  Source = handler Function/Method node in the parent.
   *  Target = the child component's File node.
   *  `reason` encodes the event name: `vue-event: @<eventName>`.
   *  Complements `EMITS_EVENT`; together they enable Cypher queries that
   *  trace which handlers receive which component's emitted events. */
  // ── Move/Aptos edges (compiler-first via the move-flow `facts` query) ──
  /** `friend` module declaration: source module → friend module. */
  | 'FRIEND_OF'
  /** Function reads a resource (`facts.resourceAccess.reads`). */
  | 'READS_RESOURCE'
  /** Function writes a resource (`facts.resourceAccess.writes`). */
  | 'WRITES_RESOURCE'
  /** Function acquires a resource (`facts.acquiresInferred`). */
  | 'ACQUIRES'
  /** Function signature mentions a Move struct/enum type. */
  | 'USES_TYPE'
  /** Reserved: function emits an event struct (not yet sourced from facts). */
  | 'EMITS'
  | 'BINDS_EVENT_HANDLER'
  /** Vue component event system: a component calls `emit('eventName', ...)`
   *  or `this.$emit('eventName', ...)`, advertising that it can emit that event.
   *  Source = the component's own File node (self-referential annotation).
   *  Target = the same File node.
   *  `reason` encodes the event name: `vue-emit: <eventName>`.
   *  Complements `BINDS_EVENT_HANDLER`; a Cypher query joining on the
   *  component File node reveals all (emitter, handler) pairs. */
  | 'EMITS_EVENT'
  // ── Taint/PDG substrate (issue #2080) ────────────────────────────────────
  // Reserved edge types for the taint-first PDG substrate. No phase emits any
  // of these yet; they are populated behind an opt-in by later milestones
  // (CFG → M1 #2081, REACHING_DEF → M2 #2082, TAINTED/SANITIZES/TAINT_PATH →
  // M3/M4 #2083/#2084). Adding them here keeps the shared schema stable so
  // downstream work does not re-ripple the exhaustiveness sites.
  /** Control-flow edge between two BasicBlock nodes (intra-procedural CFG). */
  | 'CFG'
  /** Data-dependence edge: a definition of `variable` reaches a use of it.
   *  The `variable` name is stored in the relation's existing `reason` column
   *  (M0/S1 verdict: LadybugDB has no secondary index on relationship
   *  properties, so a dedicated indexed column would not speed the
   *  variable-filtered path query). */
  | 'REACHING_DEF'
  /** A tainted value flows from source toward sink. */
  | 'TAINTED'
  /** A sanitizer clears taint along a flow. */
  | 'SANITIZES'
  /** Materialized source→sink taint path. Working name — final name/representation
   *  is confirmed when M3/M4 emits it; no persisted edge exists before then. */
  | 'TAINT_PATH'
  /** Control-dependence edge (PDG, issue #2085 M5): block `dependent` (target)
   *  executes only because the branch at block `controller` (source) took a
   *  given side. The branch sense (`'T'` | `'F'`) rides the relation's existing
   *  `reason` column — mirroring how `CFG` stores its edge kind there — since
   *  the single `CodeRelation` table has no dedicated label column. */
  | 'CDG'
  /** Debug-only post-dominator-tree edge (#2085 M5): a block → its immediate
   *  post-dominator, emitted behind the `GITNEXUS_PDG_EMIT_POST_DOMINATE` env
   *  flag for inspection. Never emitted in a normal `--pdg` run. Note: as a
   *  member of this exported union it is a forward-compatibility commitment —
   *  removing it later is a breaking schema change — and it is deliberately
   *  excluded from `VALID_RELATION_TYPES` so it never enters impact-style
   *  symbol-space traversal (same posture as the taint substrate edges). */
  | 'POST_DOMINATE'
  /** Per-callee dependence SUMMARY edge (PDG FU-C): a self-loop on a
   *  Function/Method/Constructor node carrying that callee's RETURN-VALUE
   *  ASCENT — which formal-parameter indices flow to the function's return
   *  value, encoded as a versioned bitset in the relation's existing `reason`
   *  column (the same single-channel pattern `CFG`/`REACHING_DEF`/`CDG` use,
   *  since the lone `CodeRelation` table has no dedicated label column). A
   *  later consumer phase lets an interprocedural slice ascend a callee's
   *  return effect into the caller continuation. Like the taint substrate
   *  edges it is an internal PDG-engine edge: deliberately EXCLUDED from
   *  `VALID_RELATION_TYPES` and the web schema so it never leaks into
   *  callgraph-style impact/relationship surfaces. Emitted only under `--pdg`;
   *  a default analyze emits zero. */
  | 'CALL_SUMMARY';

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: NodeProperties;
}

export interface GraphRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  confidence: number;
  reason: string;
  step?: number;
  /**
   * Per-signal evidence trace for edges emitted by the scope-based
   * resolution pipeline (RFC #909 Ring 2 PKG #925). Populated by
   * `emit-references.ts` when draining `ReferenceIndex` into the graph
   * so downstream query / audit tools can inspect *why* a given edge
   * was emitted with its confidence value.
   *
   * Optional and additive — every existing edge emitter ignores this
   * field, and every existing query continues to work whether or not
   * an edge carries it.
   */
  evidence?: readonly {
    readonly kind: string;
    readonly weight: number;
    readonly note?: string;
  }[];
}
