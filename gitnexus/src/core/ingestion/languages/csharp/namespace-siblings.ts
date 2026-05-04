/**
 * C# same-namespace cross-file visibility.
 *
 * C# makes every type declared in `namespace X` visible to every other
 * file that also declares `namespace X`, without any explicit `using`
 * directive. Python has no equivalent — every cross-file reference
 * needs an explicit import — so this is a C#-specific pass.
 *
 * Without this: `Service.cs` (namespace `FieldTypes`) can't see
 * `User` declared in `Models.cs` (same namespace), so `user.Address`
 * field-chain resolution fails at `findClassBindingInScope('User')`
 * in the Service.cs scope chain.
 *
 * Implementation: after the finalize pass populates immutable
 * `indexes.bindings` (from explicit `using` directives), walk each
 * file's tree-sitter AST for `namespace_declaration` /
 * `file_scoped_namespace_declaration` and `using_directive` nodes.
 * The orchestrator hands us its `treeCache` so files already parsed
 * by `extractParsedFile` are re-used instead of re-parsed —
 * `ParsedFile`'s underlying tree is the single source of truth.
 * Group classes by namespace, and append cross-file sibling classes
 * into each Namespace scope's `bindingAugmentations` bucket with
 * `origin: 'namespace'`. Finalized bindings remain first in
 * `lookupBindingsAt`, and local lexical `Scope.bindings` remains the
 * first-tier shadowing channel.
 *
 * The tree-sitter walk is authoritative: it sees `global using static`,
 * aliased `using static X = Y.Z;`, attributed namespace declarations,
 * and preprocessor-guarded declarations correctly because the
 * tree-sitter grammar parses them as real nodes (not textual
 * coincidences).
 */

import type { SyntaxNode } from 'tree-sitter';
import type { BindingRef, ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getCsharpParser } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';

interface CsharpFileStructure {
  /** Declared namespace names in file source order. Empty array means
   *  the file has no `namespace X;` / `namespace X { }` declaration
   *  and sits in the default (global) namespace. */
  readonly namespaces: readonly string[];
  /** Dotted paths from `using static X.Y.Z;` (including
   *  `global using static` and aliased `using static A = X.Y.Z;`). */
  readonly usingStaticPaths: readonly string[];
}

/** Build a structural view of a C# file by walking the tree-sitter
 *  AST. Prefers `cachedTree` (handed in via `treeCache`) so we don't
 *  re-parse files the orchestrator already parsed for `extractParsedFile`;
 *  falls back to a fresh parse on cache miss. Parser singleton is
 *  shared across calls. */
function extractFileStructure(content: string, cachedTree: unknown): CsharpFileStructure {
  type CsharpTree = ReturnType<ReturnType<typeof getCsharpParser>['parse']>;
  const tree =
    (cachedTree as CsharpTree | undefined) ??
    getCsharpParser().parse(content, undefined, {
      bufferSize: getTreeSitterBufferSize(content),
    });
  const namespaces: string[] = [];
  const usingStaticPaths: string[] = [];

  const visit = (node: SyntaxNode): void => {
    if (
      node.type === 'namespace_declaration' ||
      node.type === 'file_scoped_namespace_declaration'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) namespaces.push(nameNode.text);
    } else if (node.type === 'using_directive') {
      // Inspect the directive's own text for the `static` keyword
      // (tree-sitter-c-sharp does not expose it as a named child).
      // This is a single-node-scoped text inspection, not a whole-file
      // regex, so it stays well within AST semantics.
      if (/^\s*(?:global\s+)?using\s+static\s/.test(node.text)) {
        // Path lives on the `name:` field when the using-directive is
        // aliased (`using static A = X.Y.Z;`); otherwise it's the
        // first named child.
        const aliasField = node.childForFieldName('name');
        let pathNode: SyntaxNode | null = null;
        if (aliasField !== null) {
          for (const c of node.namedChildren) {
            if (c !== null && c.startIndex !== aliasField.startIndex) {
              pathNode = c;
              break;
            }
          }
        } else {
          pathNode = node.namedChildren[0] ?? null;
        }
        if (pathNode !== null) usingStaticPaths.push(pathNode.text);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };

  visit(tree.rootNode);
  return { namespaces, usingStaticPaths };
}

/** Content + (optional) pre-parsed tree-sitter trees keyed by filePath.
 *  The orchestrator builds `fileContents` from the pipeline's file list;
 *  `treeCache` is the same `scopeTreeCache` already populated by the
 *  parse phase, so cache hits avoid a second `parser.parse()`. */
export interface CsharpSiblingInputs {
  readonly fileContents: ReadonlyMap<string, string>;
  readonly treeCache?: { get(filePath: string): unknown };
}

/**
 * Append cross-file sibling class defs to each Namespace scope's
 * `bindingAugmentations` bucket. Class-like defs (Class / Interface /
 * Struct / Record / Enum) are visible cross-file; method / field
 * members are not.
 */
export function populateCsharpNamespaceSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  inputs: CsharpSiblingInputs,
): void {
  // Build a structural view (namespaces + using-static paths) per
  // file once up-front. Reuses the orchestrator's `treeCache` so
  // files already parsed by `extractParsedFile` don't get re-parsed
  // here — single-source-of-truth for the AST.
  const structureByFile = new Map<string, CsharpFileStructure>();
  for (const parsed of parsedFiles) {
    const content = inputs.fileContents.get(parsed.filePath);
    if (content === undefined) continue;
    const cachedTree = inputs.treeCache?.get(parsed.filePath);
    structureByFile.set(parsed.filePath, extractFileStructure(content, cachedTree));
  }

  // Group namespace scopes by their dotted name. Each entry carries
  // the scope id so we can inject bindings post-hoc, plus the
  // file's own class-like defs for cross-pollination.
  interface NamespaceBucket {
    readonly scopes: { filePath: string; scopeId: ScopeId; scope: Scope }[];
    readonly classDefs: SymbolDefinition[];
  }
  const buckets = new Map<string, NamespaceBucket>();
  const getBucket = (name: string): NamespaceBucket => {
    let b = buckets.get(name);
    if (b === undefined) {
      b = { scopes: [], classDefs: [] };
      buckets.set(name, b);
    }
    return b;
  };

  for (const parsed of parsedFiles) {
    const struct = structureByFile.get(parsed.filePath);
    if (struct === undefined) continue;

    // Declared namespace names, source order (AST walk visits children
    // left-to-right, matching the scope-extractor's ordering).
    const names = struct.namespaces.length > 0 ? [...struct.namespaces] : [''];

    const namespaceScopes = parsed.scopes.filter((s) => s.kind === 'Namespace');
    // With file-scoped namespaces (`namespace X;`), the Namespace
    // scope's range covers only the declaration line, not the rest of
    // the file — so classes below it land under the Module scope, not
    // the Namespace scope. Group top-level classes by "any class whose
    // parent scope is Module or Namespace" and attribute them to the
    // first declared namespace in the file. Multiple-namespace files
    // are rare enough that first-wins is the right first pass; fix
    // when the parity suite surfaces a case.
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    const topLevelParentIds = new Set<ScopeId>();
    if (moduleScope !== undefined) topLevelParentIds.add(moduleScope.id);
    for (const ns of namespaceScopes) topLevelParentIds.add(ns.id);

    // Attribute all top-level classes to the first-declared namespace
    // in this file. Multiple-namespace files are rare and can be
    // addressed if the parity suite surfaces a case. Inject into BOTH
    // the Module and the Namespace scopes — the Module scope is on
    // the ancestor chain of every function body (the Namespace scope
    // is not, because file-scoped `namespace X;` has a 1-line range).
    const firstName = names[0]!;
    const bucket = getBucket(firstName);
    if (moduleScope !== undefined) {
      bucket.scopes.push({
        filePath: parsed.filePath,
        scopeId: moduleScope.id,
        scope: moduleScope,
      });
    }
    for (const ns of namespaceScopes) {
      bucket.scopes.push({ filePath: parsed.filePath, scopeId: ns.id, scope: ns });
    }

    for (const s of parsed.scopes) {
      if (s.kind !== 'Class') continue;
      if (s.parent === null || !topLevelParentIds.has(s.parent)) continue;
      for (const def of s.ownedDefs) {
        if (isTypeDef(def)) {
          bucket.classDefs.push(def);
          break;
        }
      }
    }
  }

  // Inject cross-file siblings into each namespace scope's
  // post-finalize augmentation channel (per I8). The
  // `indexes.bindingAugmentations` map is the dedicated mutable
  // append-only buffer for post-finalize hooks: inner `BindingRef[]`
  // arrays here are NEVER frozen (unlike `indexes.bindings`, which
  // `materializeBindings` freezes). Walkers consult both channels
  // via `lookupBindingsAt`; we never need to consult or mutate
  // `indexes.bindings`.
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  // Cross-namespace type-binding propagation: for each file, mirror
  // method return-type bindings from same-namespace sibling files and
  // from files in namespaces the importer `using`s, into the
  // importer's Module scope typeBindings. This enables
  // chain-follow from `var u = svc.GetUser()` → `GetUser → User`
  // even across files — without it the chain stalls at `GetUser`
  // because the return binding lives in the defining file's Module
  // scope, which isn't an ancestor of the importer's scope chain.
  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;
    const moduleTypeBindings = moduleScope.typeBindings as Map<
      string,
      import('gitnexus-shared').TypeRef
    >;

    // Accessible namespaces = this file's own namespaces + every
    // `using namespace X;` target. Source of truth is the cached AST
    // structure captured above.
    const accessibleNamespaces = new Set<string>();
    const struct = structureByFile.get(parsed.filePath);
    if (struct !== undefined) {
      for (const n of struct.namespaces) accessibleNamespaces.add(n);
    }
    if (accessibleNamespaces.size === 0) accessibleNamespaces.add('');
    for (const imp of parsed.parsedImports) {
      if (imp.kind === 'namespace' && imp.targetRaw !== null) {
        accessibleNamespaces.add(imp.targetRaw);
      }
    }

    // For each accessible namespace, also walk up the dotted path —
    // `using static X.Y.Z;` targets a type, so the real namespace is
    // `X.Y`. Both parse into `accessibleNamespaces` as-is; we probe
    // the bucket map with every prefix.
    const expandedNamespaces = new Set<string>(accessibleNamespaces);
    for (const ns of accessibleNamespaces) {
      const segments = ns.split('.');
      for (let i = segments.length - 1; i > 0; i--) {
        expandedNamespaces.add(segments.slice(0, i).join('.'));
      }
    }

    for (const nsName of expandedNamespaces) {
      const bucket = buckets.get(nsName);
      if (bucket === undefined) continue;
      for (const scopeInfo of bucket.scopes) {
        if (scopeInfo.filePath === parsed.filePath) continue;
        if (scopeInfo.scope.kind !== 'Module') continue;
        for (const [boundName, typeRef] of scopeInfo.scope.typeBindings) {
          if (moduleTypeBindings.has(boundName)) continue;
          moduleTypeBindings.set(boundName, typeRef);
        }
      }
    }
  }

  // `using static X.Y.Z;` — expose every public static method of
  // class Z as a free-callable binding in the importer's module
  // scope, so `Record(...)` (without `Logger.` qualifier) resolves
  // to `Logger.Record`. AST walk above captured these (including
  // `global using static` and aliased forms).
  for (const parsed of parsedFiles) {
    const struct = structureByFile.get(parsed.filePath);
    if (struct === undefined) continue;
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;

    for (const fullPath of struct.usingStaticPaths) {
      const lastDot = fullPath.lastIndexOf('.');
      if (lastDot === -1) continue;
      const className = fullPath.slice(lastDot + 1);
      const enclosingNs = fullPath.slice(0, lastDot);

      // Find the target class in the named namespace bucket.
      const bucket = buckets.get(enclosingNs);
      if (bucket === undefined) continue;
      const targetDef = bucket.classDefs.find((d) => {
        const q = d.qualifiedName ?? '';
        const simple = q.includes('.') ? q.slice(q.lastIndexOf('.') + 1) : q;
        return simple === className;
      });
      if (targetDef === undefined) continue;

      // Inject the class's member methods into the importer's module
      // scope. `memberByOwner` wasn't built yet here, so we walk the
      // file's localDefs to find members with `ownerId === targetDef.nodeId`.
      const targetFile = parsedFiles.find((p) => p.filePath === targetDef.filePath);
      if (targetFile === undefined) continue;
      for (const memberDef of targetFile.localDefs) {
        if ((memberDef as { ownerId?: string }).ownerId !== targetDef.nodeId) continue;
        if (memberDef.type !== 'Method' && memberDef.type !== 'Function') continue;
        const mq = memberDef.qualifiedName ?? '';
        const simpleName = mq.includes('.') ? mq.slice(mq.lastIndexOf('.') + 1) : mq;
        if (simpleName === '') continue;

        // Append to the augmentation bucket for the importer's module
        // scope. `findCallableBindingInScope` reads via
        // `lookupBindingsAt`, which fans out across `bindings` +
        // `bindingAugmentations`.
        const bucketArr = getAugmentationBucket(augmentations, moduleScope.id, simpleName);
        if (bucketArr.some((b) => b.def.nodeId === memberDef.nodeId)) continue;
        bucketArr.push({ def: memberDef, origin: 'import' });
      }
    }
  }

  // Cross-namespace imports: for each file's `using X;` directive,
  // if `X` matches a known namespace bucket, inject that bucket's
  // classes into the importer's module scope. This is what makes
  // `new User()` in `namespace App;` resolve to `User` declared in
  // a sibling file with `namespace Models;` when the importer says
  // `using Models;`. Legacy uses csproj directory↔namespace mapping;
  // the scope-resolver layer uses the declared namespace directly.
  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;
    for (const imp of parsed.parsedImports) {
      if (imp.kind !== 'namespace') continue;
      const targetNs = imp.targetRaw;
      if (targetNs === null || targetNs === '') continue;
      const bucket = buckets.get(targetNs);
      if (bucket === undefined) continue;
      for (const def of bucket.classDefs) {
        if (def.filePath === parsed.filePath) continue;
        const q = def.qualifiedName ?? '';
        const simpleName = q.includes('.') ? q.slice(q.lastIndexOf('.') + 1) : q;
        if (simpleName === '') continue;
        const bucketArr = getAugmentationBucket(augmentations, moduleScope.id, simpleName);
        if (bucketArr.some((b) => b.def.nodeId === def.nodeId)) continue;
        bucketArr.push({ def, origin: 'namespace' });
      }
    }
  }

  for (const [, bucket] of buckets) {
    // De-dup by (nodeId, filePath) across multiple declarations (e.g.
    // partial classes declaring the same name in two files — we take
    // both and leave de-dup to downstream consumers of bindings).
    const defsByName = new Map<string, SymbolDefinition[]>();
    for (const def of bucket.classDefs) {
      // Simple name = last segment of qualifiedName (e.g. `App.User` → `User`).
      const q = def.qualifiedName ?? '';
      const key = q.includes('.') ? q.slice(q.lastIndexOf('.') + 1) : q;
      if (key === '') continue;
      const arr = defsByName.get(key) ?? [];
      arr.push(def);
      defsByName.set(key, arr);
    }

    for (const { scopeId, filePath } of bucket.scopes) {
      for (const [name, defs] of defsByName) {
        // Skip names already present locally — `origin: 'local'` in
        // scope.bindings would naturally shadow the cross-file
        // namespace entry, but we also keep this index lean.
        const local = bucket.scopes.find((s) => s.filePath === filePath)?.scope.bindings.get(name);
        if (local !== undefined && local.some((b) => b.origin === 'local')) continue;

        let bucketArr: BindingRef[] | null = null;
        for (const def of defs) {
          if (def.filePath === filePath) continue; // don't self-reference
          if (bucketArr === null) bucketArr = getAugmentationBucket(augmentations, scopeId, name);
          if (bucketArr.some((b) => b.def.nodeId === def.nodeId)) continue;
          bucketArr.push({ def, origin: 'namespace' });
        }
      }
    }
  }
}

/** Get-or-create a mutable inner bucket inside the `bindingAugmentations`
 *  channel. The inner arrays here are mutable by contract (see
 *  `ScopeResolutionIndexes.bindingAugmentations` doc + scope-resolver I8);
 *  callers may `push` directly. Allocating the outer/inner Maps lazily
 *  keeps the augmentation footprint zero for files with no cross-file
 *  fanout. */
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
  let bucketArr = scopeBindings.get(name);
  if (bucketArr === undefined) {
    bucketArr = [];
    scopeBindings.set(name, bucketArr);
  }
  return bucketArr;
}

function isTypeDef(def: SymbolDefinition): boolean {
  return (
    def.type === 'Class' ||
    def.type === 'Interface' ||
    def.type === 'Struct' ||
    def.type === 'Record' ||
    def.type === 'Enum'
  );
}
