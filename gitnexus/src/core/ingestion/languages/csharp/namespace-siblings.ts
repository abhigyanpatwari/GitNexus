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
 * coincidences). When the orchestrator's `treeCache` has no Tree for a
 * file — the worker path, where native Trees can't cross MessageChannels
 * — `extractFileStructure` falls back to a line scanner rather than
 * re-parsing every file from scratch (that re-parse dominated worker-mode
 * scope-resolution time). See `extractCsharpStructureViaScanner`.
 */

import type { SyntaxNode } from 'tree-sitter';
import type { BindingRef, ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { getCsharpParser } from './query.js';

export interface CsharpFileStructure {
  /** Declared namespace names in file source order. Empty array means
   *  the file has no `namespace X;` / `namespace X { }` declaration
   *  and sits in the default (global) namespace. */
  readonly namespaces: readonly string[];
  /** Dotted paths from `using static X.Y.Z;` (including
   *  `global using static` and aliased `using static A = X.Y.Z;`). */
  readonly usingStaticPaths: readonly string[];
  /** True when the scanner saw a `namespace` / `using static` declaration it
   *  could not fully capture (keyword not at line start, split across lines, or
   *  an unparseable identifier form). Callers feeding the #1881 gate must treat
   *  this like a truncated scan and fail OPEN, since a dropped namespace would
   *  otherwise over-block a legitimate import (Codex F3). Absent/false on a
   *  cleanly-scanned file. */
  readonly incomplete?: boolean;
}

// A dotted C# namespace identifier: each segment is an optional verbatim `@`
// followed by a Unicode letter/`_` and Unicode letters/digits/`_`. The `u` flag
// makes the classes Unicode-aware so `namespace Café.Models;` is captured (the
// old ASCII `[A-Za-z…]` truncated it). The `@` markers are stripped from the
// capture so it matches the tree-sitter AST's `name` text.
const CS_NS_IDENT = String.raw`@?[\p{L}_][\p{L}\p{N}_]*(?:\.@?[\p{L}_][\p{L}\p{N}_]*)*`;

// Line-anchored matchers for the worker-path fallback (see
// `extractCsharpStructureViaScanner`). Anchored at line start (after
// indentation); the scanner additionally tracks block-comment / string
// state across lines so a keyword at the start of a line inside one of
// those regions is skipped.
const CS_NAMESPACE_RE = new RegExp(String.raw`^[ \t]*namespace[ \t]+(${CS_NS_IDENT})`, 'u');
// `global using static`, plain `using static`, and the aliased
// `using static Alias = NS.Type;` form (the AST keeps the RHS path, so
// the optional `Alias =` is skipped and only the dotted path captured).
const CS_USING_STATIC_RE = new RegExp(
  String.raw`^[ \t]*(?:global[ \t]+)?using[ \t]+static[ \t]+(?:@?[\p{L}_][\p{L}\p{N}_]*[ \t]*=[ \t]*)?(${CS_NS_IDENT})`,
  'u',
);

// Incompleteness detectors — used ONLY when the precise matchers above failed,
// to flag a declaration the scanner could not capture (so the file fails the
// #1881 gate OPEN instead of silently dropping the namespace). Kept
// high-precision so ordinary files never trip them (which would wrongly disable
// the gate repo-wide):
//   - `…_BARE`: the keyword alone on a line (the name is on the next line).
//   - `…_AT_START`: a line-start declaration the precise matcher couldn't parse.
//   - `CS_NAMESPACE_AFTER_CODE`: a `namespace` keyword right after a `}`/`;`/`{`/`]`
//     (real code, NOT a `//` comment), i.e. not at line start.
const CS_NAMESPACE_BARE = /^[ \t]*namespace[ \t]*\r?$/;
const CS_USING_STATIC_BARE = /^[ \t]*(?:global[ \t]+)?using[ \t]+static[ \t]*\r?$/;
const CS_NAMESPACE_AT_START = /^[ \t]*namespace[ \t]+\S/;
const CS_USING_STATIC_AT_START = /^[ \t]*(?:global[ \t]+)?using[ \t]+static[ \t]+\S/;
const CS_NAMESPACE_AFTER_CODE = /[}\];{][ \t]*namespace[ \t]+@?[\p{L}_]/u;

/** Whether a `code`-state line declares a namespace / using-static the precise
 *  matchers could not capture — see the detectors above. */
function looksLikeUncapturedDeclaration(line: string): boolean {
  return (
    CS_NAMESPACE_BARE.test(line) ||
    CS_USING_STATIC_BARE.test(line) ||
    CS_NAMESPACE_AT_START.test(line) ||
    CS_USING_STATIC_AT_START.test(line) ||
    CS_NAMESPACE_AFTER_CODE.test(line)
  );
}

/** Multi-line lexical state carried line-to-line by the scanner. */
type CsScanState = 'code' | 'block' | 'verbatim' | 'raw';

/** Advance the scanner's lexical state across one line, consuming block
 *  comments (slash-star), line comments (`//`), single-line regular /
 *  interpolated strings, verbatim strings (`@"…"`), and raw string literals
 *  (`"""…"""`, fence length tracked in `rawFence`). Returns the state and
 *  raw-fence length in effect at the START of the next line. Single-line
 *  strings and `//` comments resolve back to `code` before end of line; only
 *  block comments and multi-line strings carry state forward. */
function advanceCsScanState(
  line: string,
  state: CsScanState,
  rawFence: number,
): [CsScanState, number] {
  const n = line.length;
  let i = 0;
  while (i < n) {
    if (state === 'block') {
      const end = line.indexOf('*/', i);
      if (end === -1) return ['block', rawFence];
      i = end + 2;
      state = 'code';
    } else if (state === 'verbatim') {
      // Ends at a `"` that is not doubled (`""` is an escaped quote).
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= n) return ['verbatim', rawFence];
      i += 1;
      state = 'code';
    } else if (state === 'raw') {
      // Ends at a run of `"` at least `rawFence` long.
      let closed = false;
      while (i < n) {
        if (line[i] === '"') {
          let k = i;
          while (k < n && line[k] === '"') k++;
          if (k - i >= rawFence) {
            i = k;
            state = 'code';
            rawFence = 0;
            closed = true;
            break;
          }
          i = k;
        } else {
          i++;
        }
      }
      if (!closed) return ['raw', rawFence];
    } else {
      const c = line[i];
      const next = line[i + 1];
      if (c === '/' && next === '/') return ['code', rawFence]; // line comment to EOL
      if (c === '/' && next === '*') {
        state = 'block';
        i += 2;
      } else if (c === '@' && next === '"') {
        state = 'verbatim';
        i += 2;
      } else if ((c === '$' && next === '@') || (c === '@' && next === '$')) {
        if (line[i + 2] === '"') {
          state = 'verbatim'; // interpolated verbatim ($@"…" / @$"…")
          i += 3;
        } else {
          i++;
        }
      } else if (c === '"') {
        let k = i;
        while (k < n && line[k] === '"') k++;
        const run = k - i;
        if (run >= 3) {
          state = 'raw';
          rawFence = run;
          i = k;
        } else if (run === 2) {
          i = k; // "" — empty string
        } else {
          // single-line regular / interpolated string; consume to closer
          let j = i + 1;
          while (j < n) {
            if (line[j] === '\\') {
              j += 2;
              continue;
            }
            if (line[j] === '"') break;
            j++;
          }
          i = j >= n ? n : j + 1;
        }
      } else {
        i++;
      }
    }
  }
  return [state, rawFence];
}

/** Line-scanner used when no cached tree is available (worker-parsed files
 *  can't transfer native tree-sitter Trees across MessageChannels, so
 *  `treeCache` is empty for them). Re-parsing every C# file here with
 *  tree-sitter was the dominant scope-resolution cost on large worker-mode
 *  runs — for a multi-thousand-file solution this loop alone re-parsed the
 *  whole repo a second time. The scanner extracts the same `namespaces` /
 *  `usingStaticPaths` the AST walk produces for line-anchored declarations,
 *  while tracking block-comment and string state across lines (via
 *  `advanceCsScanState`) so a `namespace` / `using static` keyword at the
 *  start of a line inside a block comment, verbatim string, or raw string
 *  literal is NOT mistaken for a declaration. The remaining trade-off vs the
 *  AST is a declaration whose keyword is not at the start of a code line
 *  (split across lines, or sharing a line with a comment/string closer).
 *  Mirrors PHP's `extractNamespaceViaScanner` (issue #1741). */
/** Incremental form of {@link extractCsharpStructureViaScanner}: feed lines one
 *  at a time via `pushLine` (in source order), then read the accumulated
 *  structure with `result()`. Lets a caller stream a file off disk
 *  (`createReadStream` + `readline`) and scan it for `namespace` / `using
 *  static` declarations in CONSTANT memory rather than buffering the whole file
 *  into a string — the line splitting and per-line matching are identical, so a
 *  streamed scan yields the same result as scanning the full content. The line
 *  terminator must be stripped (as `readline` does, or `String.split('\n')`); a
 *  trailing `\r` on a CRLF line is inert to both the matchers and the lexer. */
export interface CsharpStructureLineScanner {
  pushLine(line: string): void;
  result(): CsharpFileStructure;
}

/** Create a fresh stateful line scanner — see {@link CsharpStructureLineScanner}. */
export function createCsharpStructureScanner(): CsharpStructureLineScanner {
  const namespaces: string[] = [];
  const usingStaticPaths: string[] = [];
  let incomplete = false;
  let state: CsScanState = 'code';
  let rawFence = 0;
  return {
    pushLine(line: string): void {
      // Only match when the line START is real code — keywords reached while
      // inside a block comment / multi-line string are skipped.
      if (state === 'code') {
        const ns = CS_NAMESPACE_RE.exec(line);
        if (ns !== null) {
          namespaces.push(ns[1]!.replace(/@/g, ''));
        } else {
          const us = CS_USING_STATIC_RE.exec(line);
          if (us !== null) {
            usingStaticPaths.push(us[1]!.replace(/@/g, ''));
          } else if (looksLikeUncapturedDeclaration(line)) {
            // A declaration the precise matchers couldn't capture → mark the
            // file incomplete so the #1881 gate fails OPEN (Codex F3).
            incomplete = true;
          }
        }
      }
      [state, rawFence] = advanceCsScanState(line, state, rawFence);
    },
    result(): CsharpFileStructure {
      return incomplete
        ? { namespaces, usingStaticPaths, incomplete }
        : { namespaces, usingStaticPaths };
    },
  };
}

export function extractCsharpStructureViaScanner(content: string): CsharpFileStructure {
  const scanner = createCsharpStructureScanner();
  for (const line of content.split('\n')) scanner.pushLine(line);
  return scanner.result();
}

/** Build a structural view of a C# file. Prefers `cachedTree` (handed in
 *  via `treeCache`) and walks the tree-sitter AST — the authoritative
 *  path that sees `global using static`, aliased `using static X = Y.Z;`,
 *  attributed namespace declarations, and preprocessor-guarded nodes
 *  correctly. On cache miss (worker-parsed files, whose native Trees
 *  can't cross MessageChannels) it falls back to the line scanner instead
 *  of a fresh tree-sitter parse — the parse here dominated worker-mode
 *  scope-resolution time. Parser singleton is shared across calls. */
function extractFileStructure(content: string, cachedTree: unknown): CsharpFileStructure {
  if (!cachedTree) {
    return extractCsharpStructureViaScanner(content);
  }
  type CsharpTree = ReturnType<ReturnType<typeof getCsharpParser>['parse']>;
  const tree = cachedTree as CsharpTree;
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
  // Pre-index files by path once: the member-injection lookup below would
  // otherwise be an O(files) scan per `using static` import.
  const fileByPath = new Map<string, ParsedFile>(parsedFiles.map((p) => [p.filePath, p]));
  for (const parsed of parsedFiles) {
    const struct = structureByFile.get(parsed.filePath);
    if (struct === undefined) continue;
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope === undefined) continue;
    // Per-file de-dup sets keyed by simple name, seeded lazily from the
    // augmentation bucket — replaces the per-member O(A) `.some` scan below.
    const seenByName = new Map<string, Set<string>>();

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
      const targetFile = fileByPath.get(targetDef.filePath);
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
        let seen = seenByName.get(simpleName);
        if (seen === undefined) {
          seen = new Set<string>();
          for (const b of bucketArr) seen.add(b.def.nodeId);
          seenByName.set(simpleName, seen);
        }
        if (seen.has(memberDef.nodeId)) continue;
        seen.add(memberDef.nodeId);
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
    // Per-file de-dup sets keyed by simple name, seeded lazily from the
    // augmentation bucket — replaces the per-def O(A) `.some` scan below.
    const seenByName = new Map<string, Set<string>>();
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
        let seen = seenByName.get(simpleName);
        if (seen === undefined) {
          seen = new Set<string>();
          for (const b of bucketArr) seen.add(b.def.nodeId);
          seenByName.set(simpleName, seen);
        }
        if (seen.has(def.nodeId)) continue;
        seen.add(def.nodeId);
        bucketArr.push({ def, origin: 'namespace' });
      }
    }
  }

  // Workspace-level binding channel for global-namespace types (see the
  // global fast-path below). `lookupBindingsAt` consults this as a third
  // source after finalized + per-scope augmented bindings. Its inner arrays
  // are mutable by contract (append-only, like `bindingAugmentations` — see
  // the ScopeResolutionIndexes doc + validateBindingsImmutability), so the
  // ReadonlyMap→Map cast is localized to this one line and all writes go
  // through `getWorkspaceBucket`.
  const workspace = indexes.workspaceFqnBindings as Map<string, BindingRef[]>;

  for (const [nsName, bucket] of buckets) {
    // Group sibling defs by simple name. Append in place — the previous
    // `[...prev, def]` copy made this O(D²) per bucket, which on the
    // global (`''`) namespace bucket of a large Unity solution (tens of
    // thousands of type defs) was a primary slowness/OOM source. We keep
    // every declaration (e.g. partial classes across files) and leave
    // de-dup to downstream consumers.
    const defsByName = new Map<string, SymbolDefinition[]>();
    for (const def of bucket.classDefs) {
      // Simple name = last segment of qualifiedName (e.g. `App.User` → `User`).
      const q = def.qualifiedName ?? '';
      const key = q.includes('.') ? q.slice(q.lastIndexOf('.') + 1) : q;
      if (key === '') continue;
      let arr = defsByName.get(key);
      if (arr === undefined) {
        arr = [];
        defsByName.set(key, arr);
      }
      arr.push(def);
    }

    // Global-namespace fast path (Unity OOM guard). Types declared in the
    // default (global) namespace are visible from EVERY file in C# — the
    // global namespace is always implicitly in scope — so one workspace-
    // level entry per simple name is both semantically correct and O(D)
    // instead of the O(S·D) per-scope augmentation that materialized
    // billions of BindingRefs on large Unity solutions (tens of thousands
    // of global types × tens of thousands of scopes). `walkScopeChain`
    // checks local `scope.bindings` first, so local declarations still
    // shadow these workspace entries; a file resolving its own global type
    // hits the local binding before this map. Dedup by `def.nodeId` keeps
    // partial-class / duplicate declarations from double-emitting.
    if (nsName === '') {
      for (const [name, defs] of defsByName) {
        const bucket = getWorkspaceBucket(workspace, name);
        const seen = new Set<string>();
        for (const b of bucket) seen.add(b.def.nodeId);
        for (const def of defs) {
          if (seen.has(def.nodeId)) continue; // dedup by nodeId (keeps partials, drops re-emits)
          seen.add(def.nodeId);
          bucket.push({ def, origin: 'namespace' });
        }
      }
      continue;
    }

    // Pre-index the first scope per file once (O(S)) instead of an
    // O(S) `.find` re-run for every (scope, name) pair, which made the
    // injection loop O(S²·D) and was the dominant cost on large buckets.
    // Multiple scopes share a filePath (Module + Namespace); the local
    // shadow check only needs that file's lexical `Scope.bindings`, which
    // is identical regardless of which of those scopes we read.
    const firstScopeByFile = new Map<string, Scope>();
    for (const s of bucket.scopes) {
      if (!firstScopeByFile.has(s.filePath)) firstScopeByFile.set(s.filePath, s.scope);
    }

    for (const { scopeId, filePath } of bucket.scopes) {
      const localScope = firstScopeByFile.get(filePath);
      for (const [name, defs] of defsByName) {
        // Skip names already present locally — `origin: 'local'` in
        // scope.bindings would naturally shadow the cross-file
        // namespace entry, but we also keep this index lean.
        const local = localScope?.bindings.get(name);
        if (local !== undefined && local.some((b) => b.origin === 'local')) continue;

        // Bind the augmentation bucket and its seeded de-dup set together
        // under one nullable lifecycle, so neither needs a non-null
        // assertion (they are always set or unset as a pair). Stays lazy:
        // nothing is allocated for a name with no cross-file defs.
        let inject: { bucket: BindingRef[]; seen: Set<string> } | null = null;
        for (const def of defs) {
          if (def.filePath === filePath) continue; // don't self-reference
          if (inject === null) {
            const bucket = getAugmentationBucket(augmentations, scopeId, name);
            // Seed the de-dup set from any entries an earlier pass
            // (using-static / cross-namespace imports) already added,
            // replacing the per-def O(A) `.some` scan.
            const seen = new Set<string>();
            for (const b of bucket) seen.add(b.def.nodeId);
            inject = { bucket, seen };
          }
          if (inject.seen.has(def.nodeId)) continue;
          inject.seen.add(def.nodeId);
          inject.bucket.push({ def, origin: 'namespace' });
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

/** Get-or-create a mutable inner bucket inside the `workspaceFqnBindings`
 *  channel (the scope-independent third channel; see
 *  `ScopeResolutionIndexes.workspaceFqnBindings`). Like
 *  `getAugmentationBucket`, the inner arrays are mutable by contract —
 *  callers `push` directly. Keeping the get-or-create here means the one
 *  ReadonlyMap→Map cast at the call site is the only place the mutable
 *  view is taken. */
function getWorkspaceBucket(workspace: Map<string, BindingRef[]>, name: string): BindingRef[] {
  let bucketArr = workspace.get(name);
  if (bucketArr === undefined) {
    bucketArr = [];
    workspace.set(name, bucketArr);
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
