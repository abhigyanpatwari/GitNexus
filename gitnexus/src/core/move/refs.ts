// gitnexus/src/core/move/refs.ts
import type { RelationshipType } from 'gitnexus-shared';

/** A deferred cross-package reference resolved after every package is mapped. */
export type PendingRefKind = 'resource' | 'type' | 'friend' | 'lambda-host';

/**
 * A reference emitted in Pass-A whose target node is only known once the full
 * cross-package index exists. `knownNodeId` is the node we already have; for
 * every kind except `lambda-host` it is the edge SOURCE and `target` resolves to
 * the edge target. For `lambda-host` the resolved host is the source and
 * `knownNodeId` (the lambda function) is the target.
 */
export interface PendingRef {
  kind: PendingRefKind;
  knownNodeId: string;
  target: string;
  moduleQualified: string;
  edgeType: RelationshipType;
  reason: string;
}

/** A `PendingRef` that could not be resolved or externalized. */
export interface DroppedRef {
  kind: PendingRefKind;
  sourceId: string;
  target: string;
}
