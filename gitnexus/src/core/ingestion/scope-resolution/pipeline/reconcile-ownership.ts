/**
 * Reconcile scope-resolution's ownership view into the SemanticModel.
 *
 * For migrated languages (Python in particular) the legacy `parse` phase
 * emits class-body callables without `ownerId` because
 * `parsing-processor`'s `resolveEnclosingOwner` is language-dependent and
 * not every extractor carries the enclosing-class info at parse time.
 * Scope-resolution later calls `provider.populateOwners(parsed)`, which
 * stamps the correct `ownerId` onto `parsed.localDefs[i]`. This pass
 * mirrors those corrections into `model.methods` and `model.fields` so
 * downstream passes can consult `SemanticModel` as the single
 * authoritative owner-keyed index — no parallel scope-resolution
 * registry is needed.
 *
 * ## Single-source-of-truth invariant (I9)
 *
 * After this pass runs, every `def in parsed.localDefs` with a non-
 * undefined `ownerId` is reachable via either:
 *   - `model.methods.lookupAllByOwner(ownerId, simpleName)` — if the
 *     def is a Method / Function / Constructor, OR
 *   - `model.fields.lookupFieldByOwner(ownerId, simpleName)` — if the
 *     def is a Property / Variable.
 *
 * This invariant is the foundation of Contract Invariant I9
 * (`contract/scope-resolver.ts`): scope-resolution passes MUST read
 * symbol-keyed lookups exclusively from `SemanticModel`.
 *
 * ## Idempotency
 *
 * The pass skips registration when `(ownerId, simpleName)` already
 * contains a def with matching `nodeId`. Safe to call multiple times
 * or after a language whose legacy extractor does populate `ownerId`
 * (C#) — no duplicates are introduced.
 *
 * ## Transitional shim
 *
 * This reconciliation pass is an explicit shim. The architectural end
 * state is for the legacy extractor to emit the correct `ownerId` for
 * every language at parse time, removing the need for a second pass.
 * See ARCHITECTURE.md § "Semantic-model source of truth" for the
 * follow-up plan.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { MutableSemanticModel, SemanticModel } from '../../model/semantic-model.js';
import { simpleQualifiedName } from '../graph-bridge/ids.js';

export interface ReconcileStats {
  /** Method/Function/Constructor defs registered into MethodRegistry. */
  readonly methodsRegistered: number;
  /** Property/Variable defs registered into FieldRegistry. */
  readonly fieldsRegistered: number;
  /** Defs already present (idempotent skip). */
  readonly skippedAlreadyPresent: number;
}

export function reconcileOwnership(
  parsedFiles: readonly ParsedFile[],
  model: MutableSemanticModel,
): ReconcileStats {
  let methodsRegistered = 0;
  let fieldsRegistered = 0;
  let skippedAlreadyPresent = 0;

  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      const ownerId = (def as { ownerId?: string }).ownerId;
      if (ownerId === undefined) continue;
      const simple = simpleQualifiedName(def);
      if (simple === undefined) continue;

      if (def.type === 'Method' || def.type === 'Function' || def.type === 'Constructor') {
        const existing = model.methods.lookupAllByOwner(ownerId, simple);
        if (existing.some((e) => e.nodeId === def.nodeId)) {
          skippedAlreadyPresent++;
          continue;
        }
        model.methods.register(ownerId, simple, def);
        methodsRegistered++;
      } else if (def.type === 'Property' || def.type === 'Variable') {
        const existing = model.fields.lookupFieldByOwner(ownerId, simple);
        if (existing !== undefined && existing.nodeId === def.nodeId) {
          skippedAlreadyPresent++;
          continue;
        }
        model.fields.register(ownerId, simple, def);
        fieldsRegistered++;
      }
    }
  }

  return { methodsRegistered, fieldsRegistered, skippedAlreadyPresent };
}

/**
 * Debug-mode parity validator. Runs only when
 * `VALIDATE_SEMANTIC_MODEL !== '0'` AND `NODE_ENV !== 'production'`.
 *
 * Iterates every def in `parsedFiles[i].localDefs` with an `ownerId`
 * and asserts it is reachable via `model.methods.lookupAllByOwner` or
 * `model.fields.lookupFieldByOwner`. On mismatch: emits a warning via
 * `onWarn` — never throws, mirroring the pipeline's soft-fail posture.
 *
 * This is the enforcement of Contract Invariant I9 at runtime. In
 * production it is a no-op; in development it surfaces drift between
 * `parsed.localDefs` and `SemanticModel` that would otherwise silently
 * produce wrong edges.
 */
export function validateOwnershipParity(
  parsedFiles: readonly ParsedFile[],
  model: SemanticModel,
  onWarn: (message: string) => void,
): number {
  if (process.env.NODE_ENV === 'production') return 0;
  if (process.env.VALIDATE_SEMANTIC_MODEL === '0') return 0;

  let mismatches = 0;
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      const ownerId = (def as { ownerId?: string }).ownerId;
      if (ownerId === undefined) continue;
      const simple = simpleQualifiedName(def);
      if (simple === undefined) continue;

      if (def.type === 'Method' || def.type === 'Function' || def.type === 'Constructor') {
        const found = model.methods.lookupAllByOwner(ownerId, simple);
        if (!found.some((d) => d.nodeId === def.nodeId)) {
          onWarn(
            `semantic-model parity: ${def.type} ${def.nodeId} (${parsed.filePath}) ` +
              `owned by ${ownerId} as "${simple}" not in MethodRegistry`,
          );
          mismatches++;
        }
      } else if (def.type === 'Property' || def.type === 'Variable') {
        const found = model.fields.lookupFieldByOwner(ownerId, simple);
        if (found === undefined || found.nodeId !== def.nodeId) {
          onWarn(
            `semantic-model parity: ${def.type} ${def.nodeId} (${parsed.filePath}) ` +
              `owned by ${ownerId} as "${simple}" not in FieldRegistry`,
          );
          mismatches++;
        }
      }
    }
  }
  return mismatches;
}
