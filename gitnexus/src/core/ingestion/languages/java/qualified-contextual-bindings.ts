import type { ParsedFile, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { bindsTypeParameter } from '../../scope-resolution/scope/walkers.js';
import { javaReturnElementFacts, type JavaCaptureSideChannel } from './capture-side-channel.js';
import {
  JAVA_INHERITED_FIELD_ELEMENT,
  javaReturnElementRef,
  type ContainerProof,
  type JavaContainerProofFact,
  type JavaFieldElementRoute,
  type JavaFieldFact,
} from './declared-type-captures.js';
import { inheritedFieldResolver } from './inherited-field-types.js';
import {
  hasJavaSamePackageType,
  isJavaPackageSiblingVisibilityIncomplete,
} from './package-siblings.js';
import { inheritsJavaMemberTypeNamed, lookupJavaTypeNameClaim } from './qualified-type-bindings.js';
import { eraseJavaTypeArguments } from './type-spelling.js';

type Position = TypeRef['lookupPosition'];

/** Element bindings of a proven JDK container return type, by route. */
interface ProvenReturnElements {
  /** The return type's spelling, to match `SymbolDefinition.returnType`. */
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
 * Whether a JDK name proof captured in `file` holds where it was written:
 * nothing in the workspace gives the proving name another meaning there
 * (JLS 6.4.1, 7.5). Every proof needs that no enclosing class inherits a
 * member type of that name. A `root` (the `java` of a raw `java.*` spelling)
 * or an `on-demand` proof also needs that no type of that name is visible,
 * including a same-package sibling or a type parameter. A `single` proof's
 * file-local shadowing is the capturer's to check. Run after package sibling
 * injection; where that injection was capped, the uncapped same-package name
 * index answers instead.
 */
export function javaContainerProofHolds(
  proof: ContainerProof,
  file: string,
  position: Position,
  indexes: ScopeResolutionIndexes,
): boolean {
  if (indexes.scopeTree.getScope(proof.scope) === undefined) return false;
  if (inheritsJavaMemberTypeNamed(proof.scope, proof.name, indexes)) return false;
  if (proof.kind === 'single') return true;
  // A proof name is always written in a type (a JDK type's simple name or the
  // `java` root of its qualified one), where no variable obscures it.
  if (
    bindsTypeParameter(proof.scope, proof.name, indexes) ||
    lookupJavaTypeNameClaim(
      proof.scope,
      proof.name,
      indexes,
      proof.kind === 'root' ? position : undefined,
    ).status !== 'absent'
  )
    return false;
  // Sibling injection is capped for cost, so a large package may leave a
  // same-package type out of the lookup above. Its name is still known.
  return (
    !isJavaPackageSiblingVisibilityIncomplete(file) ||
    hasJavaSamePackageType(file, proof.name) === false
  );
}

/**
 * An inferred element type is only as certain as the JDK container identity it
 * came through. Capture proves the spelling inside the file; this confirms,
 * where the container type was written, that nothing in the workspace gives
 * the proving name another meaning (JLS 6.4.1, 7.5):
 *   - every proof: no enclosing class inherits a member type of that name;
 *   - a raw `java.*` spelling (`root`) or an on-demand import: no visible type
 *     of that name, including a same-package sibling or a type parameter.
 * Run after package sibling injection. Where that injection was capped, the
 * uncapped same-package name index answers instead. A base outside the
 * workspace has no inventory, so it is treated as contributing no member types.
 *
 * Each proof is keyed by its binding's lookup anchor. Aliases retain the
 * anchor (and TypeRef) of the inferred binding they followed, so removing a
 * refuted fact also removes every dependent alias. A contextual binding
 * without any proof is refused.
 *
 * A method's declared container return carries the same proofs, checked where
 * that return type was written; only confirmed element types are kept for
 * `javaCallResultElementType`.
 *
 * A binding whose value was looked up past a class body with supertypes also
 * carries an `InheritedFieldProof` per such body, innermost first. Where no
 * supertype declares the field, the binding stands (a placeholder without a
 * value of its own is removed). Where exactly one does, a direct element
 * binding takes that field's element instead, read and proven where the field
 * was written; anything less certain removes the binding.
 */
export function validateJavaQualifiedContextualBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const settled = new Map<TypeRef, TypeRef | null>();
  const returns = new Map<string, ProvenReturnElements>();
  const inheritedField = inheritedFieldResolver(indexes);
  const holds = (proof: ContainerProof, file: string, position: Position): boolean =>
    javaContainerProofHolds(proof, file, position, indexes);
  /** The binding a supertype's field gives in place of `ref`, by `route`. */
  const inheritedElement = (
    ref: TypeRef,
    inherited: { readonly field: JavaFieldFact; readonly filePath: string },
    route: JavaFieldElementRoute,
  ): TypeRef | null => {
    const element = inherited.field.element;
    if (element === undefined) return null;
    const position = { startLine: element.line, startCol: element.col };
    if (!element.proofs.every((proof) => holds(proof, inherited.filePath, position))) return null;
    const chosen = element.elements.find((candidate) => candidate.route === route);
    if (chosen === undefined || indexes.scopeTree.getScope(chosen.scope) === undefined) return null;
    const rawName = eraseJavaTypeArguments(chosen.spelling);
    // A qualified spelling is looked up through facts prepared only for the
    // bindings of its own file; keep the call unresolved instead.
    if (rawName.includes('.')) return null;
    return {
      rawName,
      ...(rawName === chosen.spelling ? {} : { declaredSpelling: chosen.spelling }),
      ...(ref.bindingRange === undefined ? {} : { bindingRange: ref.bindingRange }),
      declaredAtScope: chosen.scope,
      lookupPosition: position,
      ...(ref.lookupPurpose === undefined ? {} : { lookupPurpose: ref.lookupPurpose }),
      source: ref.source,
    };
  };
  const settle = (
    ref: TypeRef,
    dependsOn: readonly JavaContainerProofFact[] | undefined,
    file: string,
  ): TypeRef | null => {
    if (dependsOn === undefined) return null;
    for (const proof of dependsOn) {
      if (proof.kind !== 'unshadowed-field') continue;
      const inherited = inheritedField(proof);
      if (inherited === 'absent' || inherited === 'hidden') continue;
      // The candidate came from further out; a field that depends on the
      // inherited one only transitively has no element of its own to take.
      if (inherited === 'unknown' || proof.route === undefined) return null;
      return inheritedElement(ref, inherited, proof.route);
    }
    if (ref.rawName === JAVA_INHERITED_FIELD_ELEMENT) return null;
    return dependsOn.every(
      (proof) => proof.kind === 'unshadowed-field' || holds(proof, file, ref.lookupPosition),
    )
      ? ref
      : null;
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
        let next = settled.get(ref);
        if (next === undefined) settled.set(ref, (next = settle(ref, dependsOn, parsed.filePath)));
        const bindings = scope.typeBindings as Map<string, TypeRef>;
        if (next === null) bindings.delete(name);
        else if (next !== ref) bindings.set(name, next);
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
