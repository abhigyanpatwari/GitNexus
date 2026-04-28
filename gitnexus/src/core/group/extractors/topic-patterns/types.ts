/**
 * Shared types for the topic-extractor language plugins.
 *
 * Each plugin lives in its own file (java.ts, go.ts, ...) and owns the
 * tree-sitter grammar import + query sources. The top-level
 * `topic-extractor.ts` orchestrator only knows about this type module and
 * the plugin registry (`./index.ts`). It MUST NOT import any grammar or
 * query text directly — that's the whole point of the split.
 */

export type Broker = 'kafka' | 'rabbitmq' | 'nats';

/**
 * Per-pattern payload every topic plugin attaches to its query. Whatever
 * the pattern matches, the orchestrator receives this object verbatim
 * and uses it to build an `ExtractedContract`.
 *
 * Plugins produce one `TopicMeta` per pattern (not per match) because a
 * single query uniquely identifies its broker/role/confidence triple.
 */
export interface TopicMeta {
  role: 'provider' | 'consumer';
  broker: Broker;
  confidence: number;
  /** Short human-readable label of the API being detected. */
  symbolName: string;
}
