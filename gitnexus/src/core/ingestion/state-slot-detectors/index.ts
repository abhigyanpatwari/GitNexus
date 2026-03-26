/**
 * State slot detection orchestrator.
 *
 * Runs all registered detectors against file content and returns
 * merged ExtractedStateSlot results.
 */

import type { ExtractedStateSlot } from './types.js';
import { detectReactQuerySlots } from './react-query.js';
import { detectSwrSlots } from './swr.js';

export type { ExtractedStateSlot, SlotKind, ShapeConfidence, ExtractedStateSlotProducer, ExtractedStateSlotConsumer } from './types.js';

type Detector = (code: string, filePath: string) => ExtractedStateSlot[];

const DETECTORS: Detector[] = [
  detectReactQuerySlots,
  detectSwrSlots,
  // Phase 3: detectReactContextSlots, detectReduxSlots, detectZustandSlots
  // Phase 4: detectTRPCSlots, detectGraphQLSlots
];

/**
 * Run all state slot detectors on a file and return merged results.
 */
export function detectStateSlots(code: string, filePath: string): ExtractedStateSlot[] {
  const results: ExtractedStateSlot[] = [];
  for (const detector of DETECTORS) {
    results.push(...detector(code, filePath));
  }
  return results;
}
