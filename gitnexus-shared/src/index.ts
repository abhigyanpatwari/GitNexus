// Graph types
export type {
  NodeLabel,
  NodeProperties,
  RelationshipType,
  GraphNode,
  GraphRelationship,
} from './graph/types.js';

// Schema constants
export {
  NODE_TABLES,
  REL_TABLE_NAME,
  REL_TYPES,
  EMBEDDING_TABLE_NAME,
} from './lbug/schema-constants.js';
export type { NodeTableName, RelType } from './lbug/schema-constants.js';

// Language support
export { SupportedLanguages } from './languages.js';
export { getLanguageFromFilename, getSyntaxLanguageFromFilename } from './language-detection.js';
export type { MroStrategy } from './mro-strategy.js';

// Pipeline progress
export type { PipelinePhase, PipelineProgress } from './pipeline.js';
