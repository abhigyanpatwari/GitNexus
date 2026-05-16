/**
 * PHP same-namespace cross-file visibility.
 *
 * In PHP, every class declared in `namespace Foo\Bar` is visible to all
 * other files in the same namespace WITHOUT an explicit `use` statement.
 * Without this pass, `Service.php` (namespace `App\Services`) can't see
 * `User` declared in `Models.php` (namespace `App\Models`) unless
 * `UserService.php` has an explicit `use App\Models\User` statement.
 *
 * More importantly, A.php (namespace `App\Models`) can return `Greeting`
 * (same namespace `App\Models`) without importing it, and the compound-
 * receiver resolver needs to find `Greeting` as a class binding in the
 * scope chain.
 *
 * Implementation mirrors C#'s `namespace-siblings.ts`:
 *   1. Extract the declared namespace from each PHP file's source.
 *   2. Group class-like defs by namespace.
 *   3. Inject sibling class defs into each file's Module scope's
 *      `bindingAugmentations` with `origin: 'namespace'`.
 *   4. Also mirror return-type bindings from same-namespace siblings
 *      so cross-file chain-follow finds return types without explicit imports.
 *
 * Uses the PHP tree-sitter parser (via the lazy singleton in `query.ts`)
 * to extract namespace declarations — same AST that `extractParsedFile`
 * already parsed, reused via `treeCache` to avoid double-parsing.
 */

import type { BindingRef, ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getPhpParser } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

// ─── PHP file structure extraction ──────────────────────────────────────────

interface PhpFileStructure {
  /** The declared namespace (backslash-separated), or '' for global namespace. */
  readonly namespace: string;
}

type PhpTree = ReturnType<ReturnType<typeof getPhpParser>['parse']>;

/**
 * Extract the declared namespace from a PHP file's source.
 * Uses the cached AST tree when available to avoid re-parsing.
 */
function extractPhpFileStructure(content: string, cachedTree: unknown): PhpFileStructure {
  const tree =
    (cachedTree as PhpTree | undefined) ??
    parseSourceSafe(getPhpParser(), content, undefined, {
      bufferSize: getTreeSitterBufferSize(content),
    });

  // Walk top-level nodes looking for namespace_definition.
  // PHP files have at most one namespace declaration (PSR-4 convention).
  // `namespace_definition` has a `name:` field of type `namespace_name`.
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child === null) continue;
    if (child.type === 'namespace_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode !== null) {
        return { namespace: nameNode.text };
      }
    }
  }

  return { namespace: '' };
}

// ─── Augmentation bucket helper ─────────────────────────────────────────────

function getAugmentationBucket(
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  scopeId: ScopeId,
  name: string,
): BindingRef[] {
  let scopeBindings = augmentations.get(scopeId);
  if (scopeBindings === undefined) {
    scopeBindings = new Map<string, BindingRef[]>();
    augmentations.set(scopeId, scopeBindings);
  }
  let bucket = scopeBindings.get(name);
  if (bucket === undefined) {
    bucket = [];
    scopeBindings.set(name, bucket);
  }
  return bucket;
}

function isClassLikeDef(def: SymbolDefinition): boolean {
  return (
    def.type === 'Class' ||
    def.type === 'Interface' ||
    def.type === 'Struct' ||
    def.type === 'Enum' ||
    def.type === 'Trait'
  );
}

// ─── Public entry point ──────────────────────────────────────────────────────

export interface PhpSiblingInputs {
  readonly fileContents: ReadonlyMap<string, string>;
  readonly treeCache?: { get(filePath: string): unknown };
}

/**
 * Side-channel cache populated by `populatePhpNamespaceSiblings` so that
 * later visibility-check hooks (e.g., `isCallableVisibleFromCaller`) can
 * look up a file's PHP namespace without re-parsing. Cleared at the start
 * of every populate run so stale entries don't leak across resolutions.
 */
const namespaceByFilePath = new Map<string, string>();

/**
 * Read the cached PHP namespace for a given filePath. Returns `''` (global)
 * when the file has no namespace_definition or hasn't been processed yet.
 * Callers should only consult this AFTER either `populatePhpClassQualifiedNames`
 * or `populatePhpNamespaceSiblings` has run for the current resolution.
 */
export function getPhpNamespaceForFile(filePath: string): string {
  return namespaceByFilePath.get(filePath) ?? '';
}

/**
 * Inject same-namespace class defs and return-type bindings into each
 * PHP file's Module scope's `bindingAugmentations`. This makes classes
 * in the same PHP namespace visible to each other without explicit `use`
 * statements, mirroring PHP's actual runtime behavior.
 *
 * Uses `origin: 'namespace'` so `phpMergeBindings` tiers it below
 * explicit `use` imports (`origin: 'import'`) and local declarations.
 */
export function populatePhpNamespaceSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  inputs: PhpSiblingInputs,
): void {
  // Step 1: extract namespace structure for each file. Also seed the
  // side-channel cache used by visibility-check hooks downstream.
  namespaceByFilePath.clear();
  const structureByFile = new Map<string, PhpFileStructure>();
  for (const parsed of parsedFiles) {
    const content = inputs.fileContents.get(parsed.filePath);
    if (content === undefined) continue;
    const cachedTree = inputs.treeCache?.get(parsed.filePath);
    const struct = extractPhpFileStructure(content, cachedTree);
    structureByFile.set(parsed.filePath, struct);
    namespaceByFilePath.set(parsed.filePath, struct.namespace);
  }

  // Step 2: group class-like defs and module scopes by namespace.
  interface NamespaceBucket {
    readonly scopes: { filePath: string; scopeId: ScopeId; scope: Scope }[];
    readonly classDefs: SymbolDefinition[];
  }
  const buckets = new Map<string, NamespaceBucket>();
  const getBucket = (ns: string): NamespaceBucket => {
    let b = buckets.get(ns);
    if (b === undefined) {
      b = { scopes: [], classDefs: [] };
      buckets.set(ns, b);
    }
    return b;
  };

  for (const parsed of parsedFiles) {
    const struct = structureByFile.get(parsed.filePath);
    if (struct === undefined) continue;
    const ns = struct.namespace;
    const bucket = getBucket(ns);

    // Register the file's module scope in the bucket.
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope !== undefined) {
      bucket.scopes.push({
        filePath: parsed.filePath,
        scopeId: moduleScope.id,
        scope: moduleScope,
      });
    }

    // Collect class-like defs declared at the top-level of this file
    // (defs in Class or Module scopes, excluding nested inner classes).
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      // Only top-level class scopes (parent is Module or Namespace scope).
      if (scope.parent === null) continue;
      const parentScope = parsed.scopes.find((s) => s.id === scope.parent);
      if (
        parentScope === undefined ||
        (parentScope.kind !== 'Module' && parentScope.kind !== 'Namespace')
      ) {
        continue;
      }
      for (const def of scope.ownedDefs) {
        if (isClassLikeDef(def)) {
          bucket.classDefs.push(def);
          break; // one class-like per scope
        }
      }
    }
  }

  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  // Step 3: For each namespace bucket, inject sibling class bindings
  // into every file's Module scope (that is NOT the declaring file).
  for (const [, bucket] of buckets) {
    // Build name → def map (simple name of qualifiedName).
    const defsByName = new Map<string, SymbolDefinition[]>();
    for (const def of bucket.classDefs) {
      const q = def.qualifiedName ?? '';
      const simpleName = q.includes('.')
        ? q.slice(q.lastIndexOf('.') + 1)
        : q.includes('\\')
          ? q.slice(q.lastIndexOf('\\') + 1)
          : q;
      if (simpleName === '') continue;
      const arr = defsByName.get(simpleName) ?? [];
      arr.push(def);
      defsByName.set(simpleName, arr);
    }

    for (const { filePath, scopeId, scope } of bucket.scopes) {
      for (const [name, defs] of defsByName) {
        // Skip if already locally declared (origin: 'local' wins).
        const local = scope.bindings.get(name);
        if (local !== undefined && local.some((b) => b.origin === 'local')) continue;

        for (const def of defs) {
          if (def.filePath === filePath) continue; // don't self-inject
          const arr = getAugmentationBucket(augmentations, scopeId, name);
          if (arr.some((b) => b.def.nodeId === def.nodeId)) continue;
          arr.push({ def, origin: 'namespace' });
        }
      }
    }
  }

  // Step 3b: Inject fully-qualified-name bindings into every PHP file's
  // Module scope. PHP `\App\Models\User` (leading-backslash FQN) and
  // `App\Models\User` (already-qualified relative) on a parameter or
  // typed receiver must resolve to the exact namespace-qualified class
  // regardless of which simple-name `User` the caller's `use` imports
  // shadowed. The shared `findClassBindingInScope` scope-chain walk
  // consumes these augmentations via `lookupBindingsAt`, so adding the
  // qualified key on every file's module scope routes FQN-receivers to
  // the right def. Codex PR #1497 review, finding 1.
  //
  // Cost: O(PHP files × class-like defs in the workspace) augmentation
  // entries. Bounded and acceptable in practice — typical PHP projects
  // have hundreds of files and classes, not tens of thousands.
  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;
    const moduleScopeId = moduleScope.id;

    for (const [ns, bucket] of buckets) {
      if (ns === '') continue; // global-namespace classes have no qualified form to register
      for (const def of bucket.classDefs) {
        const q = def.qualifiedName ?? '';
        const simpleName = q.includes('\\') ? q.slice(q.lastIndexOf('\\') + 1) : q;
        if (simpleName === '') continue;
        const fqn = `${ns}\\${simpleName}`;
        const arr = getAugmentationBucket(augmentations, moduleScopeId, fqn);
        if (arr.some((b) => b.def.nodeId === def.nodeId)) continue;
        arr.push({ def, origin: 'namespace' });
      }
    }
  }

  // Step 4: Mirror return-type bindings from same-namespace sibling files.
  // This enables chain-follow like `$c->greet()->save()` where `greet()`
  // returns `Greeting` (declared in A.php, same namespace) and `Greeting`
  // isn't imported in the calling file. Without this, the compound-receiver
  // resolver can't resolve `Greeting` as a class binding in the importer's
  // scope chain.
  //
  // Additionally, mirror from files that are imported via `use` (different
  // namespace) so return types from dependencies are chain-followable too.
  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;
    const moduleTypeBindings = moduleScope.typeBindings as Map<
      string,
      import('gitnexus-shared').TypeRef
    >;

    const struct = structureByFile.get(parsed.filePath);
    const ownNs = struct?.namespace ?? '';

    // Collect namespaces accessible from this file:
    // 1. Own namespace (same-ns siblings)
    // 2. Namespaces of directly imported files (via parsedImports → targetRaw → PSR-4 namespace)
    const accessibleFiles = new Set<string>();

    // Same-namespace siblings.
    const sameBucket = buckets.get(ownNs);
    if (sameBucket !== undefined) {
      for (const { filePath } of sameBucket.scopes) {
        if (filePath !== parsed.filePath) accessibleFiles.add(filePath);
      }
    }

    // Files directly imported by this file (finalized import edges).
    const ownModuleScopeBindings = indexes.bindings.get(moduleScope.id);
    if (ownModuleScopeBindings !== undefined) {
      for (const [, refs] of ownModuleScopeBindings) {
        for (const ref of refs) {
          if (ref.origin === 'import' || ref.origin === 'namespace') {
            const importFilePath = ref.def.filePath;
            if (importFilePath !== parsed.filePath) {
              accessibleFiles.add(importFilePath);
            }
          }
        }
      }
    }

    // Mirror return-type bindings from accessible files.
    for (const srcFilePath of accessibleFiles) {
      const srcParsed = parsedFiles.find((p) => p.filePath === srcFilePath);
      if (srcParsed === undefined) continue;
      const srcModuleScope = srcParsed.scopes.find((s) => s.kind === 'Module');
      if (srcModuleScope === undefined) continue;
      for (const [boundName, typeRef] of srcModuleScope.typeBindings) {
        if (moduleTypeBindings.has(boundName)) continue;
        moduleTypeBindings.set(boundName, typeRef);
      }
    }
  }
}
