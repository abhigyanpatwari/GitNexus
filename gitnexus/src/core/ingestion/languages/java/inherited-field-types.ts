import { makeScopeId, type ParsedFile, type Scope, type TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { javaTypeFieldFacts } from './capture-side-channel.js';
import type { JavaFieldFact } from './declared-type-captures.js';
import { getJavaPackageFact } from './package-facts.js';

interface ClassFields {
  readonly scope: Scope;
  readonly filePath: string;
  readonly packageName: string | undefined;
  /** Every field the type declares, private ones included: a declaration
   *  decides its name for the type and its subtypes even when it is not
   *  inherited (JLS 8.3). */
  readonly fields: readonly Pick<JavaFieldFact, 'name' | 'access'>[];
}

/**
 * Bind, in a Java class's own scope, the declared types of the fields it
 * inherits from a supertype in another file of its own package, so a bare
 * field read in its body (`inner.save()`, an implicit `this.inner`) is typed
 * the way the class's own fields are.
 *
 * JLS 8.2/8.3: a class inherits the non-private fields of its superclass and
 * superinterfaces; a package-access field only while every class on the way
 * is in its package. A field the class declares hides every inherited one of
 * that name, and a nearer supertype's declaration hides a farther one. So the
 * walk goes nearest first through the class's MRO, and the first declaration
 * of a name decides it, whether or not that declaration is inherited.
 *
 * Only same-package supertypes in another file are bound here: a supertype in
 * another package reaches its subclasses through the import that names it, and
 * that existing route is left as it is. Bindings never replace a type the
 * class scope already holds, and they keep the supertype's own `TypeRef`, so
 * the field type is still resolved where the field was declared.
 *
 * Work is the sum over classes of their supertypes' fields: linear in the
 * workspace's inheritance, not in the size of any package.
 */
export function populateJavaInheritedFieldTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const classes = new Map<string, ClassFields>();
  for (const parsed of parsedFiles) {
    const fact = getJavaPackageFact(parsed.filePath);
    const packageName = fact?.status === 'known' ? fact.packageName : undefined;
    const facts = javaTypeFieldFacts(parsed);
    const factsByScope =
      facts === undefined
        ? undefined
        : new Map(
            facts.map((typeFact) => [
              makeScopeId({ filePath: parsed.filePath, range: typeFact.range, kind: 'Class' }),
              typeFact.fields,
            ]),
          );
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const def = scope.ownedDefs.find((owned) => isClassLike(owned.type));
      if (def === undefined) continue;
      // Without the field inventory, every typed field is taken as
      // inheritable: the declarations are known, their modifiers are not.
      const fields =
        factsByScope === undefined
          ? [...scope.typeBindings]
              .filter(([, ref]) => ref.source !== 'self')
              .map(([name]) => ({ name, access: 'inherited' as const }))
          : (factsByScope.get(scope.id) ?? []);
      classes.set(def.nodeId, { scope, filePath: parsed.filePath, packageName, fields });
    }
  }

  for (const [heirId, heir] of classes) {
    if (heir.packageName === undefined) continue;
    const ancestors = indexes.methodDispatch.mroFor(heirId);
    if (ancestors.length === 0) continue;
    const decided = new Set<string>(heir.fields.map((field) => field.name));
    let samePackageChain = true;
    let typeBindings: Map<string, TypeRef> | undefined;
    for (const ancestorId of ancestors) {
      const ancestor = classes.get(ancestorId);
      if (ancestor === undefined) {
        samePackageChain = false;
        continue;
      }
      const supplies =
        ancestor.packageName === heir.packageName && ancestor.filePath !== heir.filePath;
      for (const field of ancestor.fields) {
        if (decided.has(field.name)) continue;
        decided.add(field.name);
        if (!supplies || field.access === 'private') continue;
        if (field.access === 'package' && !samePackageChain) continue;
        const ref = ancestor.scope.typeBindings.get(field.name);
        if (ref === undefined || ref.source === 'self') continue;
        typeBindings ??= heir.scope.typeBindings as Map<string, TypeRef>;
        if (!typeBindings.has(field.name)) typeBindings.set(field.name, ref);
      }
      if (ancestor.packageName !== heir.packageName) samePackageChain = false;
    }
  }
}
