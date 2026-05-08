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
  // Spring Boot / Enterprise Java node types
  | 'Bean'
  | 'ConfigProperty'
  | 'KafkaTopic'
  | 'KafkaConsumer'
  | 'KafkaProducer'
  // Plugin-extensible node types
  | 'KafkaConfig'
  | 'KafkaTopics'
  | 'JpaEntity'
  | 'JpaRepository'
  | 'JpaField'
  | 'MyBatisMapper'
  | 'MyBatisXmlMapper'
  | 'MyBatisSql'
  | 'MyBatisMethod'
  // Markdown node types
  | 'MarkdownDoc'
  | 'MarkdownHeading'
  | 'CodeBlock'
  | 'Link'
  | 'Image'
  | 'Todo'
  | 'Table'
  | 'Blockquote'
  | 'List';

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
  parameterTypes?: string[];
  throwsTypes?: string[];
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
  isAsyncExecution?: boolean;
  annotations?: string[];
  // Route/response
  responseKeys?: string[];
  errorKeys?: string[];
  middleware?: string[];
  // Spring Boot / Enterprise Java properties
  beanName?: string;
  beanType?:
    | 'component'
    | 'service'
    | 'repository'
    | 'controller'
    | 'restController'
    | 'configuration'
    | 'beanMethod';
  beanScope?: 'singleton' | 'prototype' | 'request' | 'session' | 'application' | 'websocket';
  isPrimary?: boolean;
  isLazy?: boolean;
  qualifier?: string;
  conditionalOn?: string[];
  injectionType?: 'constructor' | 'field' | 'setter' | 'method';
  // Transaction properties
  transactional?: {
    propagation?: string;
    isolation?: string;
    rollbackFor?: string[];
    noRollbackFor?: string[];
    readOnly?: boolean;
  };
  // AOP properties
  adviceType?: 'before' | 'after' | 'around' | 'afterReturning' | 'afterThrowing';
  pointcutExpression?: string;
  // Cache properties
  cache?: {
    operation?: 'cacheable' | 'cacheEvict' | 'cachePut';
    cacheNames?: string[];
    key?: string;
    condition?: string;
  };
  // Scheduled properties
  scheduled?: {
    cron?: string;
    fixedRate?: number;
    fixedDelay?: number;
    initialDelay?: number;
  };
  // Security properties
  security?: {
    type?: 'preAuthorize' | 'secured' | 'rolesAllowed' | 'filterChain';
    expression?: string;
    roles?: string[];
  };
  // Kafka properties
  kafkaTopic?: string;
  kafkaGroupId?: string;
  kafkaBootstrapServers?: string;
  // Config property
  configKey?: string;
  configType?: 'yaml' | 'properties';
  defaultValue?: string;
  prefix?: string;
  // Generic type info
  typeParameters?: string[];
  typeParameterBounds?: string[][];
  genericArgs?: string[];
  entityType?: string;
  repositoryType?: 'jpa' | 'mongo' | 'redis' | 'elasticsearch';
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
  // Spring Boot / Enterprise Java relationships
  | 'INJECTS_INTO'
  | 'BINDS_TO'
  | 'MANAGES'
  | 'ADVISES'
  | 'TRANSACTIONS'
  | 'SECURES'
  | 'PUBLISHES'
  | 'SUBSCRIBES_TO'
  | 'CONSUMES_FROM'
  | 'PRODUCES_TO'
  | 'HAS_BEAN'
  // Plugin-extensible relationship types
  | 'HAS_CONFIG'
  | 'HAS_SQL'
  // Markdown relationship types
  | 'HAS_HEADING'
  | 'HAS_CODE_BLOCK'
  | 'LINKS_TO'
  | 'HAS_IMAGE'
  | 'HAS_TODO'
  | 'HAS_TABLE'
  | 'HAS_BLOCKQUOTE'
  | 'HAS_LIST'
  | 'HAS_SECTION';

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
  properties?: {
    injectionType?: 'constructor' | 'field' | 'setter' | 'method';
    qualifier?: string;
    isRequired?: boolean;
    bindingType?: 'configurationProperties' | 'valueInjection';
    prefix?: string;
    adviceType?: 'before' | 'after' | 'around' | 'afterReturning' | 'afterThrowing';
    pointcutExpression?: string;
    propagation?: string;
    isolation?: string;
    rollbackFor?: string[];
    readOnly?: boolean;
    securityType?: 'preAuthorize' | 'secured' | 'rolesAllowed' | 'filterChain';
    expression?: string;
    roles?: string[];
    eventType?: string;
    isAsync?: boolean;
    listenerType?:
      | 'eventListener'
      | 'transactionalEventListener'
      | 'kafkaListener'
      | 'rabbitListener'
      | 'jmsListener';
    phase?: string;
    order?: number;
    destination?: string;
    group?: string;
    repositoryType?: 'jpa' | 'mongo' | 'redis' | 'elasticsearch';
  };
  evidence?: readonly {
    readonly kind: string;
    readonly weight: number;
    readonly note?: string;
  }[];
}

/**
 * Create a GraphNode with auto-generated id.
 */
export function createNode(label: NodeLabel, properties: NodeProperties): GraphNode {
  const id = `${label.toLowerCase()}:${properties.name || 'unknown'}@${properties.filePath || 'unknown'}`;
  return { id, label, properties };
}

/**
 * Create a GraphRelationship with auto-generated id.
 */
export function createEdge(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  extra?: {
    confidence?: number;
    reason?: string;
    step?: number;
    properties?: Record<string, unknown>;
  },
): GraphRelationship {
  const id = `${sourceId}-${type}-${targetId}`;
  return {
    id,
    sourceId,
    targetId,
    type,
    confidence: extra?.confidence ?? 1.0,
    reason: extra?.reason ?? '',
    step: extra?.step,
    properties: extra?.properties as GraphRelationship['properties'],
  };
}
