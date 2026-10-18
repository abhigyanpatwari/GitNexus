import type {
  BindingRef,
  ReferenceSite,
  ResolutionEvidence,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';

/** The declaration named by a source token, independently of graph-edge targets.
 * `resolved` identifies a declaration. An ambiguous but complete candidate set
 * can identify one provider-proven rename family. Confidence, runtime dispatch
 * and a globally unique spelling never establish either proof. */
export interface SourceBindingResolution {
  readonly status: 'resolved' | 'blocked' | 'ambiguous' | 'unresolved';
  readonly targetDefIds: readonly string[];
  /** Every possible written binding is present; never set for fallback guesses. */
  readonly candidatesComplete?: true;
  readonly basis: string;
  readonly evidence?: readonly ResolutionEvidence[];
  readonly bindingKind?: 'direct' | 'import-alias';
  readonly importAlias?: {
    readonly localName: string;
    readonly importedName: string;
    readonly targetFile: string | null;
    readonly scopeId: ScopeId;
  };
}

export type SourceBindingRecorder = (
  site: ReferenceSite,
  resolution: SourceBindingResolution,
) => void;

/** Keep the selected binding's provenance; an explicit alias may have the
 * same spelling as its export and still owns a distinct source name. */
export function sourceBindingForDefinition(
  definition: SymbolDefinition,
  basis: string,
  bindings?: readonly BindingRef[],
  scopeId?: ScopeId,
): SourceBindingResolution {
  const binding = bindings?.find((candidate) => candidate.def.nodeId === definition.nodeId);
  const via = binding?.via;
  const alias = via?.kind === 'alias' && scopeId !== undefined;
  return {
    status: 'resolved',
    targetDefIds: [definition.nodeId],
    basis,
    bindingKind: alias ? 'import-alias' : 'direct',
    ...(alias
      ? {
          importAlias: {
            localName: via.localName,
            importedName: via.targetExportedName,
            targetFile: via.targetFile,
            scopeId,
          },
        }
      : {}),
  };
}
