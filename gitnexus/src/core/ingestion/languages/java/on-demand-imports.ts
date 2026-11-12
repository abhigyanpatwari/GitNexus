import type { BindingRef, ParsedFile, ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { getJavaImportUses, type JavaCaptureSideChannel } from './capture-side-channel.js';
import type { JavaImportUses } from './import-use-facts.js';
import { getJavaPackageFact } from './package-facts.js';

interface PackageTypes {
  /** Top-level type name -> the files of the package that declare it. */
  readonly names: ReadonlyMap<string, readonly string[]>;
  /** Files whose declared names cannot be trusted; always retained. */
  readonly uncertain: ReadonlySet<string>;
}
interface PackageLookup {
  readonly scopes: ReadonlyMap<string, readonly { id: ScopeId; file: string }[]>;
  readonly types: Map<string, PackageTypes>;
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
    lookup = { scopes, types: new Map() };
    packages.set(indexes, lookup);
  }
  return lookup;
}

function packageTypes(
  indexes: ScopeResolutionIndexes,
  lookup: PackageLookup,
  name: string,
): PackageTypes {
  let result = lookup.types.get(name);
  if (result !== undefined) return result;
  const names = new Map<string, string[]>();
  const uncertain = new Set<string>();
  for (const { id, file } of lookup.scopes.get(name) ?? []) {
    // A point lookup: it still answers after the scope tree is sealed to disk.
    const scope = indexes.scopeTree.getScope(id);
    if (scope === undefined || !usableFacts(getJavaImportUses(file))) {
      uncertain.add(file);
      continue;
    }
    for (const [spelling, bindings] of scope.bindings) {
      for (const binding of bindings) {
        // Package on-demand imports bind top-level types, never hoisted
        // methods, fields or nested types (JLS 7.5.2).
        if (!isType(binding) || binding.def.ownerId !== undefined) continue;
        const files = names.get(spelling) ?? [];
        files.push(binding.def.filePath);
        names.set(spelling, files);
      }
    }
  }
  result = { names, uncertain };
  lookup.types.set(name, result);
  return result;
}

/** Facts survive a cache round trip as plain JSON; trust nothing about them. */
function usableFacts(facts: JavaImportUses | undefined): facts is JavaImportUses {
  return (
    facts?.version === 2 &&
    facts.complete === true &&
    Array.isArray(facts.names) &&
    facts.names.every((name) => typeof name === 'string')
  );
}

function directoryOf(file: string): string {
  const path = file.replace(/\\/g, '/');
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** JLS 6.4.1 / 7.5.2: a name the file's own declarations do not bind is
 * supplied by a single-type import, then a type of the file's package, then a
 * package on-demand import. The capture resolved everything declared in the
 * file; this resolves what is left against other files. Ambiguous wildcard
 * candidates are all retained; there is never a workspace-wide spelling match.
 * Static/member-type wildcards retain their concrete owner dependency: this
 * optimization removes the package cross-product without assuming a complete
 * inherited static member inventory (JLS 7.5.4).
 *
 * Nothing here reads `parsed.scopes`: the emit phase may have released them.
 * https://docs.oracle.com/javase/specs/jls/se25/html/jls-6.html#jls-6.4.1
 * https://docs.oracle.com/javase/specs/jls/se25/html/jls-7.html#jls-7.5.2 */
export function javaOnDemandImportTargets(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
): ReadonlySet<string> | undefined {
  const facts = (parsed.captureSideChannel as JavaCaptureSideChannel | undefined)?.importUses;
  const packageFact = getJavaPackageFact(parsed.filePath);
  if (!usableFacts(facts) || packageFact?.status !== 'known') return undefined;
  const lookup = packageLookup(indexes);
  const targets = new Set<string>();
  const visiblePackages: PackageTypes[] = [];
  const explicitTypes = new Set<string>();
  for (const imported of parsed.parsedImports) {
    if (imported.kind === 'named' && imported.targetIncludesImportedName)
      explicitTypes.add(imported.localName);
    if (imported.kind !== 'wildcard') continue;
    const packageName = imported.targetRaw?.endsWith('.*')
      ? imported.targetRaw.slice(0, -2)
      : undefined;
    if (packageName !== undefined && lookup.scopes.has(packageName)) {
      const types = packageTypes(indexes, lookup, packageName);
      visiblePackages.push(types);
      for (const file of types.uncertain) targets.add(file);
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
  // Unlike receiver inference's bounded sibling injection, this sees the whole
  // package even when it has hundreds of files.
  const siblings = packageTypes(indexes, lookup, packageFact.packageName);
  const directory = directoryOf(parsed.filePath);
  for (const name of facts.names) {
    if (explicitTypes.has(name)) continue;
    // A declared package name does not prove two files are compiled together:
    // another build module, a test source set, or a sample directory can
    // declare the same package. Only a sibling in the importer's own directory
    // is certain to shadow the on-demand import; any other keeps the edge.
    if (siblings.names.get(name)?.some((file) => directoryOf(file) === directory)) continue;
    for (const types of visiblePackages)
      for (const file of types.names.get(name) ?? []) targets.add(file);
  }
  return targets;
}

function isType(binding: BindingRef): boolean {
  return isClassLike(binding.def.type) || binding.def.type === 'Annotation';
}
