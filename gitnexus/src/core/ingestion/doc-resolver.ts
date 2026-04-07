/**
 * Document Resolver Engine (Phase 3)
 * 
 * Maps unresolved Pseudocode calls (from Markdown parsing) to their true
 * Implementations in Real Code using the Global SymbolTable.
 * Connects Design space and Code space via the 'IMPLEMENTS' edge.
 */

import { generateId } from '../../lib/utils.js';
import { KnowledgeGraph } from '../graph/types.js';
import type { ResolutionContext } from './resolution-context.js';
import type { PendingResolution } from './markdown-processor.js';

export const resolveDocImplementations = (
  graph: KnowledgeGraph,
  ctx: ResolutionContext,
  pendingResolutions: PendingResolution[]
): number => {
  let resolvedCount = 0;

  for (const pending of pendingResolutions) {
    // Attempt mapping via the lazy callable index (Function/Method/Constructor)
    const candidates = ctx.symbols.lookupFuzzyCallable(pending.name);
    
    if (candidates.length > 0) {
      // Scale confidence if ambiguous mappings exist (name sharing across domains)
      const baseConfidence = candidates.length === 1 ? 0.95 : 0.85;
      
      for (const candidate of candidates) {
         graph.addRelationship({
            id: generateId('IMPLEMENTS', `${pending.source}->${candidate.nodeId}`),
            type: 'IMPLEMENTS',
            sourceId: pending.source,
            targetId: candidate.nodeId,
            confidence: baseConfidence,
            reason: 'pseudocode-to-real-code',
            step: pending.step
         });
         resolvedCount++;
      }
    }
  }
  
  return resolvedCount;
};
