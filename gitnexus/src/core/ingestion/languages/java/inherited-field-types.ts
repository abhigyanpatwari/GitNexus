import {
  makeScopeId,
  type ParsedFile,
  type Scope,
  type ScopeId,
  type TypeRef,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { javaTypeFieldFacts } from './capture-side-channel.js';
import type { InheritedFieldProof, JavaFieldFact } from './declared-type-captures.js';
import { getJavaPackageFact } from './package-facts.js';

interface ClassFields {
  readonly scope: Scope;
  readonly packageName: string | undefined;
  readonly fields: readonly JavaFieldFact[];
  readonly captured: boolean;
}

interface FieldDeclaration {
  readonly field: JavaFieldFact;
  readonly scopeId: ScopeId;
  readonly packageName: string | undefined;
}

interface Members {
  readonly fields: ReadonlyMap<string, readonly FieldDeclaration[]>;
  readonly complete: boolean;
}

export interface DirectParents {
  readonly ids: readonly string[];
  readonly complete: boolean;
}

const UNKNOWN_MEMBERS: Members = { fields: new Map(), complete: false };
const membersByIndexes = new WeakMap<ScopeResolutionIndexes, ReadonlyMap<ScopeId, Members>>();

type InheritedField =
  | 'absent'
  | 'hidden'
  | 'unknown'
  | { readonly field: JavaFieldFact; readonly filePath: string; readonly scope: Scope };

/** Look up a captured field at the declaration that supplied its type. */
export function inheritedFieldResolver(
  indexes: ScopeResolutionIndexes,
): (proof: InheritedFieldProof) => InheritedField {
  const members = membersByIndexes.get(indexes);
  return ({ scope, name }) => {
    const owner = members?.get(scope);
    if (!owner?.complete) return 'unknown';
    const candidates = owner.fields.get(name);
    if (candidates === undefined) return 'absent';
    if (candidates.length === 0) return 'hidden';
    if (candidates.length !== 1) return 'unknown';
    const candidate = candidates[0]!;
    const declared = indexes.scopeTree.getScope(candidate.scopeId);
    return declared === undefined
      ? 'unknown'
      : { field: candidate.field, filePath: declared.filePath, scope: declared };
  };
}

/** JLS 8.3: a declaration hides fields arriving on the same inheritance path.
 * Each direct supertype independently contributes its accessible fields.
 * One declaration reached twice through a diamond is still one field. */
export function populateJavaInheritedFieldTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  directParents: (id: string) => DirectParents,
): void {
  const classes = new Map<string, ClassFields>();
  for (const parsed of parsedFiles) {
    const pkg = getJavaPackageFact(parsed.filePath);
    const packageName = pkg?.status === 'known' ? pkg.packageName : undefined;
    const facts = javaTypeFieldFacts(parsed);
    const fieldsByScope = new Map(
      facts?.map((fact) => [
        makeScopeId({ filePath: parsed.filePath, range: fact.range, kind: 'Class' }),
        fact.fields,
      ]),
    );
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const def = scope.ownedDefs.find((owned) => isClassLike(owned.type));
      if (def === undefined) continue;
      // Older captures supply field types but no access or element facts.
      const fields =
        facts === undefined
          ? [...scope.typeBindings]
              .filter(([, ref]) => ref.source !== 'self')
              .map(([name]) => ({ name, access: 'inherited' as const }))
          : (fieldsByScope.get(scope.id) ?? []);
      classes.set(def.nodeId, { scope, packageName, fields, captured: facts !== undefined });
    }
  }

  const members = new Map<ScopeId, Members>();
  const collectMembers = (owner: ClassFields, parents: DirectParents): Members => {
    let complete = owner.captured && owner.packageName !== undefined && parents.complete;
    const fields = new Map<string, FieldDeclaration[]>();
    for (const parentId of parents.ids) {
      const parentScope = classes.get(parentId)?.scope.id;
      const parent =
        parentScope === undefined ? UNKNOWN_MEMBERS : (members.get(parentScope) ?? UNKNOWN_MEMBERS);
      complete &&= parent.complete;
      for (const [name, declarations] of parent.fields) {
        let inherited = fields.get(name);
        if (inherited === undefined) fields.set(name, (inherited = []));
        for (const declaration of declarations) {
          if (declaration.field.access === 'private') continue;
          if (
            declaration.field.access === 'package' &&
            (owner.packageName === undefined || declaration.packageName !== owner.packageName)
          )
            continue;
          if (!inherited.includes(declaration)) inherited.push(declaration);
        }
      }
    }
    for (const field of owner.fields)
      fields.set(field.name, [{ field, scopeId: owner.scope.id, packageName: owner.packageName }]);
    return { fields, complete };
  };

  // Visit parents first, including on classpaths deep enough to exhaust the
  // JavaScript stack. A back edge reads the incomplete entry for its cycle.
  for (const [id, owner] of classes) {
    if (members.has(owner.scope.id)) continue;
    const pending: { id: string; parents?: DirectParents }[] = [{ id }];
    while (pending.length > 0) {
      const visit = pending.pop()!;
      const type = classes.get(visit.id);
      if (type === undefined) continue;
      if (visit.parents !== undefined) {
        members.set(type.scope.id, collectMembers(type, visit.parents));
      } else if (!members.has(type.scope.id)) {
        members.set(type.scope.id, UNKNOWN_MEMBERS);
        const parents = directParents(visit.id);
        pending.push({ id: visit.id, parents });
        for (const parent of parents.ids) pending.push({ id: parent });
      }
    }
  }
  for (const heir of classes.values()) {
    const visible = members.get(heir.scope.id);
    if (visible === undefined || heir.packageName === undefined) continue;
    const bindings = heir.scope.typeBindings as Map<string, TypeRef>;
    for (const [name, candidates] of visible.fields) {
      if (bindings.has(name) || candidates.length === 0) continue;
      if (candidates.length > 1) {
        // An ambiguous field claims the name even in a nested class. Keep
        // lookup from taking an unrelated enclosing field with that name.
        bindings.set(name, {
          rawName: '#ambiguous-java-field',
          declaredAtScope: heir.scope.id,
          source: 'annotation',
        });
        continue;
      }
      const declaration = candidates[0]!;
      const scope = indexes.scopeTree.getScope(declaration.scopeId);
      const ref = scope?.typeBindings.get(name);
      if (ref !== undefined && ref.source !== 'self') bindings.set(name, ref);
    }
  }
  membersByIndexes.set(indexes, members);
}
