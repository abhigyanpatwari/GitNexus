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
  | 'Tool';

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
  | 'FETCHES'
  | 'HANDLES_TOOL'
  | 'ENTRY_POINT_OF'
  | 'WRAPS'
  | 'QUERIES'
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
  | 'EMITS_EVENT';

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
