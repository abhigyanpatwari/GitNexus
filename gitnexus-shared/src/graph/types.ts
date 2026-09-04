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
  /**
   * A message-broker destination — a Kafka topic, a Rabbit exchange/routing
   * key, a JMS queue, a Spring Cloud Stream binding. The framework overlay for
   * ASYNCHRONOUS entry/exit points, symmetric to `Route` for HTTP.
   *
   * Identity is `(broker, resolved ADDRESS)`, so a publisher and a consumer of
   * the same address on the same broker land on one node and the connection is
   * a single hop — while a Kafka topic and a Rabbit queue that share a name
   * stay two nodes, the same way `GET /x` and `POST /x` are two Routes. A
   * destination whose address could NOT be resolved is keyed by its source
   * location instead and carries no `address` property at all. See
   * `pipeline-phases/spring-destinations.ts` for why an unresolved spelling may
   * not key a node, and `ingestion/destination-key.ts` for why the broker may.
   */
  | 'Destination'
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
  /** Route runtime evidence is authoritative only when this is exactly true. */
  runtimeConfirmed?: boolean;
  /** Provenance of runtime evidence; presence alone does not imply confirmation. */
  runtimeSource?: string;
  /** Runtime result such as runtime-confirmed or handler-conflict. */
  runtimeStatus?: string;
  // Destination (async messaging overlay). See the `Destination` label above.
  /** The RESOLVED broker address. Together with `broker` it is the key a
   *  cross-repository pass joins on. Present only when the address resolved:
   *  absent is the load-bearing state, because an absent property cannot match
   *  another absent property. */
  address?: string;
  /** Broker family the syntax attests to (`kafka`, `rabbit`, `jms`, …). Part
   *  of the node's identity alongside `address`, not a label on it. */
  broker?: string;
  /** How the address was arrived at (`literal`, `constant`) when it resolved,
   *  or the named reason it did not. */
  resolution?: string;
  /** Configuration key named by an unresolvable `${…}` placeholder. The key
   *  only — configuration VALUES are deliberately absent from this graph. */
  configKey?: string;
  /** The `${key:default}` default text. Not an address: configuration can
   *  override it and the graph cannot see whether it did. */
  configDefault?: string;
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
  /** Outbound async messaging. Source = the callable that performs the publish
   *  (or its File); target = the `Destination` it publishes to. Emitted by
   *  `pipeline-phases/spring-destinations.ts` from Spring messaging-template
   *  calls (`kafkaTemplate.send(...)`, `rabbitTemplate.convertAndSend(...)`).
   *  One edge per address: a publish that names two destinations yields two
   *  edges, and `reason` records which argument each came from. */
  | 'PUBLISHES_TO'
  /** Inbound async messaging — the mirror of `PUBLISHES_TO`. Source = the
   *  annotated handler callable (or its File); target = the `Destination` it
   *  subscribes to. Emitted from `@KafkaListener` / `@RabbitListener` /
   *  `@JmsListener` and their siblings. Together the two types make
   *  "who else reads what this service writes" a two-hop traversal. */
  | 'CONSUMES_FROM'
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
   *  Source = the consumer Class, or a factory Method for its parameters.
   *  Target = a concrete provider Class or synthetic provider CodeElement.
   *  Framework specifics live in the `reason` payload (e.g.
   *  `Spring DI: @Autowired List<T>`), not in this type contract.
   *  Lets Cypher queries trace which beans the container injects into a given
   *  consumer, complementing the structural `IMPLEMENTS` heritage edges. */
  | 'INJECTS'
  /** Spring activation constraint. Source = a conditional Bean/configuration
   *  Class or factory Method; target = the referenced configuration Property
   *  when statically identifiable, otherwise an Annotation evidence node.
   *  The reason records the annotation and explicitly marks activation as
   *  unknown because runtime environment/classpath state may override source
   *  configuration. */
  | 'CONDITIONAL_ON'
  /** Metadata declaration/discovery relationship. Source = a metadata File;
   *  target = the declared candidate node. This deliberately does not claim
   *  that the target is active or registered at runtime. Framework-specific
   *  semantics belong in `reason` so the relationship can be reused by other
   *  metadata-driven systems. */
  | 'DECLARES'
  /** Framework advice relationship. Source = the class-like/Method whose behavior
   *  is intercepted; target = either the concrete advice Method or a synthetic
   *  CodeElement describing a declarative interceptor (transaction, cache, or
   *  method security). Runtime activation remains explicitly unknown in the
   *  relationship reason; this edge records statically visible advice only. */
  | 'ADVISED_BY'
  /** Vue component event system: a handler function in a parent component is
   *  bound to an event emitted by a child component (`@event="handlerFn"`).
   *  Source = handler Function/Method node in the parent.
   *  Target = the child component's File node.
   *  `reason` encodes the event name: `vue-event: @<eventName>`.
   *  Complements `EMITS_EVENT`; together they enable Cypher queries that
   *  trace which handlers receive which component's emitted events. */
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
  /**
   * When `true`, the call site this edge was resolved from sits in a
   * branch that is provably unreachable from the indexed source at
   * compile time — e.g. a Zig `if (CONST_FALSE)` body, or the `else` of
   * `if (CONST_TRUE)`, where the condition folds to a comptime-known
   * boolean.
   *
   * This does NOT change what a `CALLS` edge means. `CALLS` still means
   * "there is a resolved call site from A to B"; it has never meant "B is
   * reachable from A", and this flag does not make it mean that.
   * `staticGated` is additional, statically provable path-feasibility
   * metadata on the edge: an opt-in
   * analysis layer that a consumer may read (for example to rank or
   * filter callers in an impact view) and that no core pass acts on.
   * The edge is emitted, persisted, traversed and counted exactly as it
   * was before the flag existed.
   *
   * Scope: only conditions that fold from constants in the source.
   * Anything the index cannot know (build mode, target, environment) is
   * never marked; the index has no production build configuration and
   * does not claim to.
   *
   * Optional and additive: edges from languages that don't compute
   * static gating leave this `undefined`, which readers treat
   * identically to `false` (live). Currently set only by the Zig
   * scope-capture emitter.
   */
  staticGated?: boolean;
}
