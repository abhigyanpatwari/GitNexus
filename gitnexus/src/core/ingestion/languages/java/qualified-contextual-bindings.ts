import type { ParsedFile, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  bindsTypeParameter,
  isClassLike,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import { javaReturnElementFacts, type JavaCaptureSideChannel } from './capture-side-channel.js';
import {
  javaReturnElementRef,
  type ContainerProof,
  type JavaContainerProofFact,
} from './declared-type-captures.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';

type Position = TypeRef['lookupPosition'];

/** Element bindings of a proven JDK container return type, by route. */
interface ProvenReturnElements {
  /** The return type as written, to match `SymbolDefinition.returnType`. */
  readonly written: string;
  readonly routes: ReadonlyMap<string, TypeRef>;
}

const provenReturnElements = new WeakMap<
  ScopeResolutionIndexes,
  ReadonlyMap<string, ProvenReturnElements>
>();

const returnElementKey = (filePath: string, line: number, col: number): string =>
  `${filePath}:${line}:${col}`;

/**
 * An inferred element type is only as certain as the JDK container identity it
 * came through. Capture proves the spelling inside the file; this confirms,
 * where the container type was written, that nothing in the workspace gives
 * the proving name another meaning (JLS 6.4.1, 7.5):
 *   - every proof: no enclosing class inherits a member type of that name;
 *   - a raw `java.*` spelling (`root`) or an on-demand import: no visible type
 *     of that name, including a same-package sibling or a type parameter.
 * Run after package sibling injection. A base outside the workspace has no
 * inventory, so it is treated as contributing no member types.
 *
 * Each proof is keyed by its binding's lookup anchor. Aliases retain the
 * anchor (and TypeRef) of the inferred binding they followed, so removing a
 * refuted fact also removes every dependent alias. A contextual binding
 * without any proof is refused.
 *
 * A method's declared container return carries the same proofs, checked where
 * that return type was written; only confirmed element types are kept for
 * `javaCallResultElementType`.
 */
export function validateJavaQualifiedContextualBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const validity = new Map<TypeRef, boolean>();
  const returns = new Map<string, ProvenReturnElements>();
  let memberTypes: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  const inheritsMemberType = (scopeId: ScopeId, name: string): boolean => {
    memberTypes ??= memberTypeNamesByOwner(indexes);
    const seen = new Set<ScopeId>();
    for (
      let scope = indexes.scopeTree.getScope(scopeId);
      scope !== undefined && !seen.has(scope.id);
      scope = scope.parent === null ? undefined : indexes.scopeTree.getScope(scope.parent)
    ) {
      seen.add(scope.id);
      if (scope.kind !== 'Class') continue;
      const owner = scope.ownedDefs.find((def) => isClassLike(def.type));
      if (owner === undefined) continue;
      for (const ancestor of indexes.methodDispatch.mroFor(owner.nodeId))
        if (memberTypes.get(ancestor)?.has(name) === true) return true;
    }
    return false;
  };
  const holds = (proof: ContainerProof, file: string, position: Position): boolean => {
    if (indexes.scopeTree.getScope(proof.scope) === undefined) return false;
    if (inheritsMemberType(proof.scope, proof.name)) return false;
    if (proof.kind === 'single') return true;
    return (
      !isJavaPackageSiblingVisibilityIncomplete(file) &&
      !bindsTypeParameter(proof.scope, proof.name, indexes) &&
      lookupNameClaim(proof.scope, proof.name, indexes, {
        purpose: 'type',
        ...(proof.kind === 'root' ? { position } : {}),
      }).status === 'absent'
    );
  };
  for (const parsed of parsedFiles) {
    const byAnchor = new Map<string, JavaContainerProofFact[]>();
    const channel = parsed.captureSideChannel as JavaCaptureSideChannel | undefined;
    for (const proof of Array.isArray(channel?.containerProofs) ? channel.containerProofs : []) {
      const key = `${proof.line}:${proof.col}`;
      const bucket = byAnchor.get(key) ?? [];
      bucket.push(proof);
      byAnchor.set(key, bucket);
    }
    for (const scope of parsed.scopes) {
      for (const [name, ref] of scope.typeBindings) {
        const position = ref.lookupPosition;
        const dependsOn =
          position === undefined
            ? undefined
            : byAnchor.get(`${position.startLine}:${position.startCol}`);
        if (dependsOn === undefined && ref.source !== 'receiver-propagated') continue;
        let valid = validity.get(ref);
        if (valid === undefined) {
          valid =
            dependsOn !== undefined &&
            dependsOn.every((proof) => holds(proof, parsed.filePath, ref.lookupPosition));
          validity.set(ref, valid);
        }
        if (!valid) (scope.typeBindings as Map<string, TypeRef>).delete(name);
      }
    }
    for (const fact of javaReturnElementFacts(parsed)) {
      const position = { startLine: fact.line, startCol: fact.col };
      if (!fact.proofs.every((proof) => holds(proof, parsed.filePath, position))) continue;
      const routes = new Map<string, TypeRef>();
      for (const element of fact.elements)
        if (indexes.scopeTree.getScope(element.scope) !== undefined)
          routes.set(element.route, javaReturnElementRef(fact, element));
      returns.set(returnElementKey(parsed.filePath, fact.methodLine, fact.methodCol), {
        written: fact.written,
        routes,
      });
    }
  }
  provenReturnElements.set(indexes, returns);
}

/**
 * The element a `var` loop variable takes from the exactly selected method's
 * result: the confirmed element of that method's own declared JDK container
 * return type (see `validateJavaQualifiedContextualBindings`). Anything else,
 * including a refuted container proof, leaves the variable unbound.
 */
export function javaCallResultElementType(
  callee: SymbolDefinition,
  _returned: TypeRef,
  route: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  const at = callee.declarationRange;
  if (callee.type !== 'Method' || callee.isSynthetic === true || at === undefined) return undefined;
  const proven = provenReturnElements
    .get(scopes)
    ?.get(returnElementKey(callee.filePath, at.startLine, at.startCol));
  return proven !== undefined && proven.written === callee.returnType
    ? proven.routes.get(route)
    : undefined;
}

/** Simple names of the member types each workspace class declares. */
function memberTypeNamesByOwner(
  indexes: ScopeResolutionIndexes,
): ReadonlyMap<string, ReadonlySet<string>> {
  const names = new Map<string, Set<string>>();
  for (const def of indexes.defs.byId.values()) {
    if (def.ownerId === undefined || !(isClassLike(def.type) || def.type === 'Annotation'))
      continue;
    const spelling = def.qualifiedName ?? def.nodeId;
    const owned = names.get(def.ownerId) ?? new Set<string>();
    owned.add(spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1));
    names.set(def.ownerId, owned);
  }
  return names;
}
