/**
 * `emitScopeCaptures` for Python.
 *
 * Drives the scope query against `tree-sitter-python` and groups raw
 * matches into `CaptureMatch[]` for the central extractor, then layers
 * two synthesized streams on top:
 *
 *   1. **Per-name import statements** — `import a, b` and
 *      `from m import x, y` decompose to one match per imported name
 *      (see `import-decomposer.ts`).
 *   2. **Receiver type bindings** — each `function_definition` inside a
 *      class body emits a `@type-binding.self` (or `@type-binding.cls`
 *      for `@classmethod`) capture so Pass-4 attaches the implicit
 *      receiver (see `receiver-binding.ts`).
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { splitImportStatement } from './import-decomposer.js';
import { getPythonParser, getPythonScopeQuery } from './query.js';
import { synthesizeReceiverTypeBinding } from './receiver-binding.js';
import { synthesizeDependsReferences } from './depends-references.js';
import { computePythonArityMetadata } from './arity-metadata.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { pythonFunctionDefinitionLabel } from './simple-hooks.js';

export function emitPythonScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Skip the parse when the caller (parse phase's ASTCache) already
  // produced a Tree for this source. Cache miss = re-parse, same as
  // before. The cachedTree parameter is typed as `unknown` at the
  // contract layer (see `LanguageProvider.emitScopeCaptures`); cast
  // here at the use site.
  let tree = cachedTree as ReturnType<ReturnType<typeof getPythonParser>['parse']> | undefined;
  if (tree === undefined) {
    try {
      tree = parseSourceSafe(getPythonParser(), sourceText, undefined, {
        bufferSize: getTreeSitterBufferSize(sourceText),
      });
    } catch (err) {
      throw scopeExtractionError('parse', _filePath, err);
    }
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  let rawMatches: ReturnType<ReturnType<typeof getPythonScopeQuery>['matches']>;
  try {
    rawMatches = getPythonScopeQuery().matches(tree.rootNode);
  } catch (err) {
    throw scopeExtractionError('scope query', _filePath, err);
  }

  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // Group captures by their tag name. Tree-sitter strips the leading
    // `@`; we put it back so the central extractor's prefix lookups
    // (`@scope.`, `@declaration.`, …) work.
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The tree-sitter query already
    // hands us each matched node as `c.node`, so anchor nodes can be used
    // directly (or via a bounded LOCAL walk) instead of re-deriving them with
    // `findNodeAtRange(tree.rootNode, ...)`, which scanned all of root's named
    // children on every match -> O(matches x rootChildren). That was the #1848
    // hotpath in Go (fixed in eaf0a305); the same shape lived here in Python.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      // `@import.statement` is captured directly ON the `import_statement` /
      // `import_from_statement` node (query: `(import_statement) @import.statement`
      // and `(import_from_statement) @import.statement`), so the captured node IS
      // the one the old findNodeAtRange re-derived. `splitImportStatement`
      // dispatches on those two types; a captured node of any other type would
      // have made the old range+type lookup return null -> the defensive raw
      // fallback, which the type guard below reproduces exactly.
      const stmtNode = nodeMap['@import.statement']!;
      if (stmtNode.type === 'import_from_statement' || stmtNode.type === 'import_statement') {
        for (const piece of splitImportStatement(stmtNode)) out.push(piece);
      } else {
        // Defensive fallback: emit the raw match.
        out.push(grouped);
      }
      continue;
    }

    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      // `@scope.function` is captured directly on the `function_definition`
      // node (query: `(function_definition) @scope.function`), so it IS the
      // node the old findNodeAtRange re-derived at that range.
      const scopeNode = nodeMap['@scope.function']!;
      const fnNode = scopeNode.type === 'function_definition' ? scopeNode : null;
      if (fnNode !== null) {
        const synth = synthesizeReceiverTypeBinding(fnNode);
        if (synth !== null) out.push(synth);
        for (const depRef of synthesizeDependsReferences(fnNode)) out.push(depRef);
      }
      continue;
    }

    if (grouped['@declaration.function'] !== undefined) {
      // Synthesize arity captures on the declaration match so the
      // central scope-extractor picks them up alongside @declaration.name.
      // The anchor range is the function_definition itself — we resolve
      // the node and pipe it through the arity helper.
      const anchorCap = grouped['@declaration.function']!;
      // `@declaration.function` is captured directly on the `function_definition`
      // node (query: `(function_definition name: (identifier) @declaration.name)
      // @declaration.function`), so use the captured node, not a root re-walk.
      const anchorNode = nodeMap['@declaration.function']!;
      const fnNode = anchorNode.type === 'function_definition' ? anchorNode : null;
      if (fnNode !== null) {
        if (pythonFunctionDefinitionLabel(fnNode, 'Function') === 'Method') {
          delete grouped['@declaration.function'];
          grouped['@declaration.method'] = { ...anchorCap, name: '@declaration.method' };
        }
        const arity = computePythonArityMetadata(fnNode);
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
          // Serialize as JSON so the consumer can round-trip without
          // inventing a quoting convention for type names that may
          // contain commas (`Dict[str, int]`).
          grouped['@declaration.parameter-types'] = syntheticCapture(
            '@declaration.parameter-types',
            fnNode,
            JSON.stringify(arity.parameterTypes),
          );
        }
      }
      out.push(grouped);
      continue;
    }

    out.push(grouped);
  }

  return out;
}

function scopeExtractionError(stage: string, filePath: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(
    `[python] tree-sitter ${stage} failed for ${filePath}: ${reason}; skipping scope extraction for this file`,
  );
}
