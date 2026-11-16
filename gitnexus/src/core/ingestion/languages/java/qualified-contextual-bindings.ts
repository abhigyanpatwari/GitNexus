import { makeScopeId, type ParsedFile, type SymbolDefinition, type TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { bindsTypeParameter, isClassLike } from '../../scope-resolution/scope/walkers.js';
import {
  javaReturnElementFacts,
  javaTypeFieldFacts,
  type JavaCaptureSideChannel,
} from './capture-side-channel.js';
import {
  JAVA_INHERITED_FIELD_ELEMENT,
  javaReturnElementRef,
  type ContainerProof,
  type InheritedFieldProof,
  type JavaContainerProofFact,
  type JavaFieldElementRoute,
  type JavaFieldFact,
  type JavaTypeFieldsFact,
} from './declared-type-captures.js';
import { getJavaPackageFact } from './package-facts.js';
import {
  hasJavaSamePackageType,
  isJavaPackageSiblingVisibilityIncomplete,
} from './package-siblings.js';
import { inheritsJavaMemberTypeNamed, lookupJavaTypeNameClaim } from './qualified-type-bindings.js';
import { eraseJavaTypeArguments } from './type-spelling.js';

type Position = TypeRef['lookupPosition'];

/** The field a subclass inherits under a name, or why there is none to use. */
type InheritedField =
  | 'absent'
  | 'unknown'
  | { readonly field: JavaFieldFact; readonly filePath: string };

const NO_FIELDS: JavaTypeFieldsFact = Object.freeze({
  range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
  bases: [],
  fields: [],
});

const simpleNameOf = (def: SymbolDefinition): string => {
  const spelling = def.qualifiedName ?? def.nodeId;
  return spelling.slice(Math.max(spelling.lastIndexOf('.'), spelling.lastIndexOf(':')) + 1);
};

/**
 * Which field a class inherits under `name` (JLS 8.3), from the workspace
 * inventory: the class's MRO and each supertype's own field declarations.
 * `unknown` when a written supertype anywhere on the chain is not a workspace
 * type (its members are not inventoried), when a type's fields were not
 * captured, or when the answer depends on hiding order or package chains.
 */
function inheritedFieldResolver(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): (proof: InheritedFieldProof) => InheritedField {
  let types:
    | Map<string, { readonly filePath: string; readonly fact: JavaTypeFieldsFact }>
    | undefined;
  const memo = new Map<string, InheritedField>();
  const mroNames = new Map<string, ReadonlySet<string>>();
  const packageOf = (filePath: string): string | undefined => {
    const fact = getJavaPackageFact(filePath);
    return fact?.status === 'known' ? fact.packageName : undefined;
  };
  const index = () => {
    types = new Map();
    for (const parsed of parsedFiles) {
      const facts = javaTypeFieldFacts(parsed);
      // A file without captured facts leaves its types out: they stay unknown.
      if (facts === undefined) continue;
      const byScope = new Map(
        facts.map((fact) => [
          makeScopeId({ filePath: parsed.filePath, range: fact.range, kind: 'Class' }),
          fact,
        ]),
      );
      for (const scope of parsed.scopes) {
        if (scope.kind !== 'Class') continue;
        const def = scope.ownedDefs.find((owned) => isClassLike(owned.type));
        if (def !== undefined)
          types.set(def.nodeId, {
            filePath: parsed.filePath,
            fact: byScope.get(scope.id) ?? NO_FIELDS,
          });
      }
    }
    return types;
  };
  const resolve = (proof: InheritedFieldProof): InheritedField => {
    const scope = indexes.scopeTree.getScope(proof.scope);
    const heir =
      scope?.kind === 'Class' ? scope.ownedDefs.find((def) => isClassLike(def.type)) : undefined;
    if (heir === undefined) return 'unknown';
    const inventory = types ?? index();
    const ancestors = indexes.methodDispatch.mroFor(heir.nodeId);
    for (const id of [heir.nodeId, ...ancestors]) {
      const type = inventory.get(id);
      if (type === undefined) return 'unknown';
      if (type.fact.bases.length === 0) continue;
      let names = mroNames.get(id);
      if (names === undefined) {
        names = new Set(
          indexes.methodDispatch.mroFor(id).flatMap((ancestor) => {
            const def = indexes.defs.get(ancestor);
            return def === undefined ? [] : [simpleNameOf(def)];
          }),
        );
        mroNames.set(id, names);
      }
      // A supertype outside the workspace may declare any field.
      if (!type.fact.bases.every((base) => names.has(base))) return 'unknown';
    }
    const heirPackage = packageOf(heir.filePath);
    const inherited: { readonly field: JavaFieldFact; readonly filePath: string }[] = [];
    let hidden = false;
    for (const id of ancestors) {
      const type = inventory.get(id)!;
      for (const field of type.fact.fields) {
        if (field.name !== proof.name) continue;
        if (field.access === 'private') {
          hidden = true;
          continue;
        }
        if (field.access === 'package') {
          const own = packageOf(type.filePath);
          if (own === undefined || heirPackage === undefined) return 'unknown';
          if (own !== heirPackage) {
            hidden = true;
            continue;
          }
          // Inherited only if no supertype between is in another package.
          if (
            ancestors.some((ancestorId) => {
              const ancestor = inventory.get(ancestorId);
              return ancestor === undefined || packageOf(ancestor.filePath) !== own;
            })
          )
            return 'unknown';
        }
        inherited.push({ field, filePath: type.filePath });
      }
    }
    // Only inaccessible declarations: the name means what encloses the class.
    if (inherited.length === 0) return 'absent';
    // Hiding order decides between several; the MRO does not record it.
    return inherited.length === 1 && !hidden ? inherited[0]! : 'unknown';
  };
  return (proof) => {
    const key = `${proof.scope}\0${proof.name}`;
    let result = memo.get(key);
    if (result === undefined) memo.set(key, (result = resolve(proof)));
    return result;
  };
}

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
  const inheritedField = inheritedFieldResolver(parsedFiles, indexes);
  const holds = (proof: ContainerProof, file: string, position: Position): boolean => {
    if (indexes.scopeTree.getScope(proof.scope) === undefined) return false;
    if (inheritsJavaMemberTypeNamed(proof.scope, proof.name, indexes)) return false;
    if (proof.kind === 'single') return true;
    // A proof name is always written in a type (a JDK container's simple name
    // or the `java` root of its qualified one), where no variable obscures it.
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
  };
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
      if (inherited === 'absent') continue;
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
