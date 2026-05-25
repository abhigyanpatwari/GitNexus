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

// ─── PHP file structure extraction ──────────────────────────────────────────

interface PhpFileStructure {
  /** The declared namespace (backslash-separated), or '' for global namespace. */
  readonly namespace: string;
}

type PhpTree = ReturnType<ReturnType<typeof getPhpParser>['parse']>;

const NAMESPACE_RE = /^\s*namespace\s+([\w\\]+)\s*[;{]/i;
const HEREDOC_START_RE = /<<<\s*['"]?(\w+)['"]?\s*$/;

/**
 * Extract a PHP namespace declaration from raw source without tree-sitter.
 *
 * Single-pass line scanner that skips heredoc/nowdoc bodies, block
 * comments, and single-line comments before matching. This avoids the
 * false positives that a multiline regex produces when `namespace` appears
 * inside a heredoc, nowdoc, string, or comment.
 */
export function extractNamespaceViaScanner(content: string): string {
  const lines = content.split('\n');
  let inBlockComment = false;
  let heredocDelimiter: string | null = null;

  for (const raw of lines) {
    if (heredocDelimiter !== null) {
      const trimmed = raw.trim();
      if (trimmed === heredocDelimiter + ';' || trimmed === heredocDelimiter) {
        heredocDelimiter = null;
      }
      continue;
    }

    if (inBlockComment) {
      if (raw.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    let line = raw;

    const blockStart = line.indexOf('/*');
    if (blockStart >= 0) {
      const blockEnd = line.indexOf('*/', blockStart + 2);
      if (blockEnd >= 0) {
        line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
      } else {
        line = line.slice(0, blockStart);
        inBlockComment = true;
      }
    }

    const slashIdx = line.indexOf('//');
    const hashIdx = line.indexOf('#');
    if (slashIdx >= 0 && (hashIdx < 0 || slashIdx < hashIdx)) {
      line = line.slice(0, slashIdx);
    } else if (hashIdx >= 0) {
      line = line.slice(0, hashIdx);
    }

    const heredocMatch = raw.match(HEREDOC_START_RE);
    if (heredocMatch) {
      heredocDelimiter = heredocMatch[1];
      continue;
    }

    const stripped = line.replace(/<\?php/gi, '').replace(/declare\s*\([^)]*\)\s*;?/gi, '');
    const nsMatch = stripped.match(NAMESPACE_RE);
    if (nsMatch) {
      return nsMatch[1];
    }
  }

  return '';
}

/**
 * Extract the declared namespace from a PHP file's source.
 * Uses the cached AST tree when available to avoid re-parsing.
 *
 * When no cached tree is available (worker-parsed files can't transfer
 * native Tree objects across MessageChannels), uses a line scanner
 * instead of re-parsing every file with tree-sitter. For 16K+ PHP files
 * this eliminates ~16K tree-sitter re-parses during the namespace-siblings
 * pass. See: https://github.com/abhigyanpatwari/GitNexus/issues/1741
 */
export function extractPhpFileStructure(content: string, cachedTree: unknown): PhpFileStructure {
  if (!cachedTree) {
    return { namespace: extractNamespaceViaScanner(content) };
  }

  // Walk top-level nodes looking for namespace_definition.
  // PHP files have at most one namespace declaration (PSR-4 convention).
  // `namespace_definition` has a `name:` field of type `namespace_name`.
  const root = (cachedTree as PhpTree).rootNode;
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

  // Step 3b: Register FQN bindings in a workspace-level map instead of
  // per-scope augmentations. PHP `\App\Models\User` and `App\Models\User`
  // must resolve regardless of which file the lookup originates from.
  // `lookupBindingsAt` consults `workspaceFqnBindings` as a third source.
  //
  // Cost: O(class-like defs) entries — NOT O(files × classDefs). For 16K
  // PHP files with 5K classes, this is 5K entries instead of 80M.
  const fqnMap = indexes.workspaceFqnBindings as Map<string, BindingRef[]>;
  for (const [ns, bucket] of buckets) {
    if (ns === '') continue;
    for (const def of bucket.classDefs) {
      const q = def.qualifiedName ?? '';
      const simpleName = q.includes('\\') ? q.slice(q.lastIndexOf('\\') + 1) : q;
      if (simpleName === '') continue;
      const fqn = `${ns}\\${simpleName}`;
      let arr = fqnMap.get(fqn);
      if (arr === undefined) {
        arr = [];
        fqnMap.set(fqn, arr);
      }
      if (arr.some((b) => b.def.nodeId === def.nodeId)) continue;
      arr.push({ def, origin: 'namespace' });
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
  const parsedByPath = new Map<string, (typeof parsedFiles)[number]>();
  for (const p of parsedFiles) parsedByPath.set(p.filePath, p);

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
      const srcParsed = parsedByPath.get(srcFilePath);
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
