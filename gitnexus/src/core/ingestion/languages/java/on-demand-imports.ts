import {
  buildPositionIndex,
  lookupLexicalName,
  type BindingRef,
  type ParsedFile,
  type Scope,
  type ScopeId,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike, lookupBindingsAt } from '../../scope-resolution/scope/walkers.js';
import { javaMergeBindings } from './merge-bindings.js';
import { getJavaImportUses, type JavaCaptureSideChannel } from './capture-side-channel.js';
import { getJavaPackageFact } from './package-facts.js';
import { isJvmSourceVisible } from '../jvm/source-visibility.js';

interface PackageBindings {
  readonly names: ReadonlyMap<string, readonly BindingRef[]>;
  readonly uncertain: ReadonlySet<string>;
}
interface PackageLookup {
  readonly scopes: ReadonlyMap<string, readonly { id: ScopeId; file: string }[]>;
  readonly bindings: Map<string, PackageBindings>;
}
// Share declarations across importers. This is O(workspace declarations), not
// importer × package size; each target scope is decoded at most once.
const packages = new WeakMap<ScopeResolutionIndexes, PackageLookup>();

function packageLookup(indexes: ScopeResolutionIndexes): PackageLookup {
  let lookup = packages.get(indexes);
  if (lookup === undefined) {
    const scopes = new Map<string, { id: ScopeId; file: string }[]>();
    for (const [file, id] of indexes.moduleScopes.byFilePath) {
      const fact = getJavaPackageFact(file);
      if (fact?.status !== 'known') continue;
      const bucket = scopes.get(fact.packageName) ?? [];
      bucket.push({ id, file });
      scopes.set(fact.packageName, bucket);
    }
    lookup = { scopes, bindings: new Map() };
    packages.set(indexes, lookup);
  }
  return lookup;
}

function packageBindings(
  indexes: ScopeResolutionIndexes,
  lookup: PackageLookup,
  name: string,
): PackageBindings {
  let result = lookup.bindings.get(name);
  if (result !== undefined) return result;
  const names = new Map<string, BindingRef[]>();
  const uncertain = new Set<string>();
  for (const { id, file } of lookup.scopes.get(name) ?? []) {
    const scope = indexes.scopeTree.getScope(id);
    if (scope === undefined || getJavaImportUses(file)?.complete !== true) {
      uncertain.add(file);
      continue;
    }
    for (const [spelling, bindings] of scope.bindings) {
      for (const binding of bindings) {
        // Package on-demand imports bind top-level types, never hoisted
        // methods, fields or nested types (JLS 7.5.2).
        if (!isType(binding) || binding.def.ownerId !== undefined) continue;
        const bucket = names.get(spelling) ?? [];
        bucket.push({ def: binding.def, origin: 'wildcard' });
        names.set(spelling, bucket);
      }
    }
  }
  result = { names, uncertain };
  lookup.bindings.set(name, result);
  return result;
}

/** JLS 6.5.5.1 / 7.5.2: bind AST simple names through lexical scopes, explicit
 * imports and same-package types before package wildcards. Preserve ambiguity;
 * never fall back to a workspace-wide spelling match. Static/member-type
 * wildcards retain their concrete owner dependency: this optimization removes
 * the package cross-product without assuming a complete inherited static
 * member inventory (JLS 7.5.4).
 * https://docs.oracle.com/javase/specs/jls/se25/html/jls-6.html#jls-6.5.5.1
 * https://docs.oracle.com/javase/specs/jls/se25/html/jls-7.html#jls-7.5.2 */
export function javaOnDemandImportTargets(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
): ReadonlySet<string> | undefined {
  const facts = (parsed.captureSideChannel as JavaCaptureSideChannel | undefined)?.importUses;
  const packageFact = getJavaPackageFact(parsed.filePath);
  if (
    facts?.version !== 1 ||
    !facts.complete ||
    !Array.isArray(facts.uses) ||
    packageFact?.status !== 'known'
  )
    return undefined;
  const lookup = packageLookup(indexes);
  const targets = new Set<string>();
  const visiblePackages: PackageBindings[] = [];
  const explicitTypes = new Set<string>();
  for (const imported of parsed.parsedImports) {
    if (imported.kind === 'named' && imported.targetIncludesImportedName)
      explicitTypes.add(imported.localName);
    if (imported.kind !== 'wildcard') continue;
    const packageName = imported.targetRaw?.endsWith('.*')
      ? imported.targetRaw.slice(0, -2)
      : undefined;
    if (packageName !== undefined && lookup.scopes.has(packageName)) {
      const bindings = packageBindings(indexes, lookup, packageName);
      visiblePackages.push(bindings);
      for (const file of bindings.uncertain) targets.add(file);
    } else {
      for (const edge of indexes.imports.get(parsed.moduleScope) ?? []) {
        if (
          edge.kind === 'wildcard-expanded' &&
          edge.targetFile !== null &&
          (imported.atRange === undefined ||
            (edge.atRange?.startLine === imported.atRange.startLine &&
              edge.atRange?.startCol === imported.atRange.startCol))
        )
          targets.add(edge.targetFile);
      }
    }
  }
  if (visiblePackages.length === 0) return targets;
  // Unlike receiver inference's bounded sibling injection, lexical package
  // visibility is complete even when the package has hundreds of files.
  const siblings = packageBindings(indexes, lookup, packageFact.packageName);
  const positions = buildPositionIndex(parsed.scopes);
  const typeScopes = new Map<ScopeId, Scope>();
  const typeLookup = {
    getScope: (id: ScopeId): Scope | undefined => {
      let view = typeScopes.get(id);
      if (view === undefined) {
        const scope = indexes.scopeTree.getScope(id);
        if (scope === undefined) return undefined;
        // Java separates type and expression namespaces (JLS 6.5.2/6.5.5).
        // `User User` uses the type. Expression-name shadowing was already
        // bound in exact AST scopes; hoisted receiver hints must not escape them.
        view = {
          ...scope,
          typeBindings: new Map(),
          lexicalNames: new Set(),
          ownsReceivers: new Set(),
          imports: [],
        };
        typeScopes.set(id, view);
      }
      return view;
    },
  };
  for (const use of facts.uses) {
    if (use.purpose === 'method' || explicitTypes.has(use.name)) continue;
    const scopeId = positions.atPosition(parsed.filePath, use.range.startLine, use.range.startCol);
    if (scopeId === undefined) return undefined;
    const claim = lookupLexicalName(
      scopeId,
      use.name,
      {
        scopes: typeLookup,
        bindingsAt: (scope, name) => {
          const local = [
            ...(scope.bindings.get(name) ?? []),
            ...lookupBindingsAt(scope.id, name, indexes),
          ].filter(isType);
          const samePackage =
            scope.id === parsed.moduleScope
              ? (siblings.names.get(name) ?? [])
                  .filter((binding) => isJvmSourceVisible(parsed.filePath, binding.def.filePath))
                  .map((binding): BindingRef => ({ def: binding.def, origin: 'namespace' }))
              : [];
          const wildcard =
            scope.id === parsed.moduleScope
              ? visiblePackages.flatMap((group) => group.names.get(name) ?? [])
              : [];
          return javaMergeBindings([...local, ...samePackage, ...wildcard]);
        },
      },
      { position: use.range, purpose: 'type' },
    );
    for (const binding of claim.bindings)
      if (binding.origin === 'wildcard') targets.add(binding.def.filePath);
  }
  return targets;
}

function isType(binding: BindingRef): boolean {
  return isClassLike(binding.def.type) || binding.def.type === 'Annotation';
}
