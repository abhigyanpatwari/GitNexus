/**
 * `emitScopeCaptures` for C#.
 *
 * Drives the C# scope query against tree-sitter-c-sharp and groups raw
 * matches into `CaptureMatch[]` for the central extractor. Layers one
 * synthesized stream on top today:
 *
 *   1. **Decomposed using directives** — each `using_directive` is
 *      re-emitted with `@import.kind/source/name/alias` markers so
 *      `interpretCsharpImport` can recover the ParsedImport shape
 *      without re-parsing raw text (see `import-decomposer.ts`).
 *
 * Receiver-binding synthesis (`this` / `base` type anchors) and arity
 * metadata synthesis (Unit 5) layer on top later.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { findNodeAtRange, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { splitUsingDirective } from './import-decomposer.js';
import { computeCsharpArityMetadata } from './arity-metadata.js';
import { synthesizeCsharpReceiverBinding } from './receiver-binding.js';
import { getCsharpParser, getCsharpScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = [
  '@declaration.method',
  '@declaration.constructor',
  '@declaration.function',
] as const;

/** tree-sitter-c-sharp node types that the method extractor accepts. */
const FUNCTION_NODE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
] as const;

export function emitCsharpScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Skip the parse when the caller (parse phase's scopeTreeCache)
  // already produced a Tree for this source. Cache miss = re-parse,
  // same as before. The cachedTree parameter is typed as `unknown` at
  // the LanguageProvider contract layer; cast here at the use site.
  let tree = cachedTree as ReturnType<ReturnType<typeof getCsharpParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = getCsharpParser().parse(sourceText);
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getCsharpScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // Group captures by their tag name. Tree-sitter strips the leading
    // `@`; we put it back so the central extractor's prefix lookups
    // (`@scope.`, `@declaration.`, …) work.
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Decompose each `using_directive` so `interpretCsharpImport` sees
    // the kind/source/name/alias markers it consumes. Raw query match
    // only carries the @import.statement anchor.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      const stmtNode = findNodeAtRange(tree.rootNode, stmtCapture.range, 'using_directive');
      if (stmtNode !== null) {
        const decomposed = splitUsingDirective(stmtNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      // Defensive fallback: emit the raw match so the extractor at
      // least sees an anchor, even without markers.
      out.push(grouped);
      continue;
    }

    // Synthesize `this` / `base` receiver type-bindings on every
    // instance method-like. Tree-sitter can't cleanly express "the
    // implicit receiver of a non-static member of a class/struct/
    // record/interface" via a static `.scm` pattern, so we walk up
    // the AST in code. Mirrors Python's `self`/`cls` synthesis on
    // `@scope.function` matches.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const anchor = grouped['@scope.function']!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        for (const synth of synthesizeCsharpReceiverBinding(fnNode)) {
          out.push(synth);
        }
      }
      continue;
    }

    // Synthesize arity metadata on function-like declarations so the
    // registry can narrow overloads (C# relies heavily on this). Mirrors
    // Python's captures.ts pattern — one anchor per match, so we find
    // the first tag that matches.
    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const anchor = grouped[declTag]!;
      const fnNode = findFunctionNode(tree.rootNode, anchor.range);
      if (fnNode !== null) {
        const arity = computeCsharpArityMetadata(fnNode);
        if (arity.parameterCount !== undefined) {
          grouped['@declaration.parameter-count'] = syntheticCapture(
            '@declaration.parameter-count',
            fnNode,
            String(arity.parameterCount),
          );
        }
        if (arity.requiredParameterCount !== undefined) {
          grouped['@declaration.required-parameter-count'] = syntheticCapture(
            '@declaration.required-parameter-count',
            fnNode,
            String(arity.requiredParameterCount),
          );
        }
        if (arity.parameterTypes !== undefined) {
          grouped['@declaration.parameter-types'] = syntheticCapture(
            '@declaration.parameter-types',
            fnNode,
            JSON.stringify(arity.parameterTypes),
          );
        }
      }
    }

    out.push(grouped);
  }

  return out;
}

type SyntaxNode = ReturnType<ReturnType<typeof getCsharpParser>['parse']>['rootNode'];

/** Find the first C# function-like node at the given range. The
 *  declaration anchor range covers the whole method/constructor/etc.
 *  node, but the tag alone doesn't tell us which node type. */
function findFunctionNode(rootNode: SyntaxNode, range: Capture['range']): SyntaxNode | null {
  for (const nodeType of FUNCTION_NODE_TYPES) {
    const n = findNodeAtRange(rootNode, range, nodeType);
    if (n !== null) return n as SyntaxNode;
  }
  return null;
}
