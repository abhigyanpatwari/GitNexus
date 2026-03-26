/**
 * Shared types for state slot detection across frameworks.
 */

export type SlotKind = 'react-query' | 'swr' | 'react-context' | 'redux' | 'zustand' | 'trpc' | 'graphql' | 'custom-hook';

export type ShapeConfidence = 'type-checked' | 'ast-literal' | 'heuristic';

export interface ExtractedStateSlotProducer {
  /** Function/method name that produces data into this slot */
  functionName: string;
  /** File where the producer lives */
  filePath: string;
  /** Line number of the producing call */
  lineNumber: number;
  /** Top-level keys this producer writes */
  keys: string[];
  /** Confidence tier */
  confidence: ShapeConfidence;
  /** Raw TS type annotation if available (e.g. 'VendorPattern[]') */
  sourceType?: string;
}

export interface ExtractedStateSlotConsumer {
  /** Function/method name that consumes data from this slot */
  functionName: string;
  /** File where the consumer lives */
  filePath: string;
  /** Line number of the consuming call */
  lineNumber: number;
  /** Properties this consumer accesses */
  accessedKeys: string[];
  /** Confidence tier */
  confidence: ShapeConfidence;
}

export interface ExtractedStateSlot {
  /** Human-readable identifier (e.g. "['vendor-patterns', slug]") */
  name: string;
  /** Framework that manages this state */
  slotKind: SlotKind;
  /** Literal or pattern of the cache/state key */
  cacheKey: string;
  /** File where the slot is first defined/configured */
  filePath: string;
  /** Line number of the slot definition */
  lineNumber: number;
  /** Functions that write data into this slot */
  producers: ExtractedStateSlotProducer[];
  /** Functions that read data from this slot */
  consumers: ExtractedStateSlotConsumer[];
}
