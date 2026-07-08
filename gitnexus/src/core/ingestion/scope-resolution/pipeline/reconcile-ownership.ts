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
 *   - `model.fields.lookupAllByOwner(ownerId, simpleName)` — if the
 *     def is a Property / Variable / Const / Static.
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

const NESTED_TYPE_KINDS = new Set<string>([
  'Class',
  'Interface',
  'Enum',
  'Struct',
  'Union',
  'Trait',
  'TypeAlias',
  'Typedef',
  'Record',
  'Delegate',
  'Annotation',
  'Template',
  'Namespace',
]);

export interface ReconcileStats {
  /** Method/Function/Constructor defs registered into MethodRegistry. */
  readonly methodsRegistered: number;
  /** Property/Variable defs registered into FieldRegistry. */
  readonly fieldsRegistered: number;
  /** Class-like nested type defs registered into TypeRegistry by owner. */
  readonly nestedTypesRegistered: number;
  /** Defs already present (idempotent skip). */
  readonly skippedAlreadyPresent: number;
}

export function reconcileOwnership(
  parsedFiles: readonly ParsedFile[],
  model: MutableSemanticModel,
): ReconcileStats {
  let methodsRegistered = 0;
  let fieldsRegistered = 0;
  let nestedTypesRegistered = 0;
  let skippedAlreadyPresent = 0;

  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      const ownerId = (def as { ownerId?: string }).ownerId;
      const simple = simpleQualifiedName(def);
      if (simple === undefined) continue;

      if (def.type === 'Method' || def.type === 'Function' || def.type === 'Constructor') {
        if (ownerId === undefined) {
          if (def.isDeleted !== true) continue;
          const existingDef = model.symbols
            .lookupExactAll(def.filePath, simple)
            .find((candidate) => callableSignatureMatches(candidate, def));
          if (existingDef !== undefined) {
            existingDef.isDeleted = true;
            skippedAlreadyPresent++;
            continue;
          }
          model.symbols.add(def.filePath, simple, def.nodeId, def.type, {
            parameterCount: def.parameterCount,
            requiredParameterCount: def.requiredParameterCount,
            parameterTypes: def.parameterTypes,
            parameterTypeClasses: def.parameterTypeClasses,
            returnType: def.returnType,
            qualifiedName: def.qualifiedName,
            isDeleted: true,
          });
          continue;
        }
        const existing = model.methods.lookupAllByOwner(ownerId, simple);
        const existingDef = existing.find(
          (candidate) =>
            candidate.nodeId === def.nodeId ||
            (def.isDeleted === true && callableSignatureMatches(candidate, def)),
        );
        if (existingDef !== undefined) {
          if (def.isDeleted === true) {
            existingDef.isDeleted = true;
          }
          skippedAlreadyPresent++;
          continue;
        }
        model.methods.register(ownerId, simple, def);
        methodsRegistered++;
      } else if (
        def.type === 'Property' ||
        def.type === 'Variable' ||
        def.type === 'Const' ||
        def.type === 'Static'
      ) {
        const existing = model.fields.lookupAllByOwner(ownerId, simple);
        if (existing.some((e) => e.nodeId === def.nodeId)) {
          skippedAlreadyPresent++;
          continue;
        }
        model.fields.register(ownerId, simple, def);
        fieldsRegistered++;
      } else if (NESTED_TYPE_KINDS.has(def.type)) {
        const existing = model.types.lookupAllByOwner(ownerId, simple);
        if (existing.some((e) => e.nodeId === def.nodeId)) {
          skippedAlreadyPresent++;
          continue;
        }
        model.types.registerByOwner(ownerId, simple, def);
        nestedTypesRegistered++;
      }
    }
  }

  return { methodsRegistered, fieldsRegistered, nestedTypesRegistered, skippedAlreadyPresent };
}

function callableSignatureMatches(
  left: ParsedFile['localDefs'][number],
  right: ParsedFile['localDefs'][number],
): boolean {
  if (left.filePath !== right.filePath) return false;
  if (left.parameterCount !== right.parameterCount) return false;
  if (left.requiredParameterCount !== right.requiredParameterCount) return false;
  const leftTypes = left.parameterTypes;
  const rightTypes = right.parameterTypes;
  if (leftTypes === undefined || rightTypes === undefined) {
    return leftTypes === rightTypes;
  }
  return (
    leftTypes.length === rightTypes.length &&
    leftTypes.every((parameterType, index) => parameterType === rightTypes[index])
  );
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
      } else if (
        def.type === 'Property' ||
        def.type === 'Variable' ||
        def.type === 'Const' ||
        def.type === 'Static'
      ) {
        const found = model.fields.lookupAllByOwner(ownerId, simple);
        if (!found.some((d) => d.nodeId === def.nodeId)) {
          onWarn(
            `semantic-model parity: ${def.type} ${def.nodeId} (${parsed.filePath}) ` +
              `owned by ${ownerId} as "${simple}" not in FieldRegistry`,
          );
          mismatches++;
        }
      } else if (NESTED_TYPE_KINDS.has(def.type)) {
        const found = model.types.lookupAllByOwner(ownerId, simple);
        if (!found.some((d) => d.nodeId === def.nodeId)) {
          onWarn(
            `semantic-model parity: ${def.type} ${def.nodeId} (${parsed.filePath}) ` +
              `owned by ${ownerId} as "${simple}" not in TypeRegistry owner index`,
          );
          mismatches++;
        }
      }
    }
  }
  return mismatches;
}
