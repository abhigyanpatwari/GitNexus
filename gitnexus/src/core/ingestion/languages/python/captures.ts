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
import { findNodeAtRange, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { splitImportStatement } from './import-decomposer.js';
import { getPythonParser, getPythonScopeQuery } from './query.js';
import { synthesizeReceiverTypeBinding } from './receiver-binding.js';
import { computePythonArityMetadata } from './arity-metadata.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';

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
    tree = getPythonParser().parse(sourceText);
    recordCacheMiss();
  } else {
    recordCacheHit();
  }
  const rawMatches = getPythonScopeQuery().matches(tree.rootNode);

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

    if (grouped['@import.statement'] !== undefined) {
      // Decompose multi-name imports. Both `import_statement` and
      // `import_from_statement` share the matched range, so we try the
      // `from` form first and fall back to plain.
      const stmtCapture = grouped['@import.statement'];
      const stmtNode =
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_from_statement') ??
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_statement');
      if (stmtNode !== null) {
        for (const piece of splitImportStatement(stmtNode)) out.push(piece);
      } else {
        // Defensive fallback: emit the raw match.
        out.push(grouped);
      }
      continue;
    }

    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const fnNode = findNodeAtRange(
        tree.rootNode,
        grouped['@scope.function']!.range,
        'function_definition',
      );
      if (fnNode !== null) {
        const synth = synthesizeReceiverTypeBinding(fnNode);
        if (synth !== null) out.push(synth);
      }
      continue;
    }

    if (grouped['@declaration.function'] !== undefined) {
      // Synthesize arity captures on the declaration match so the
      // central scope-extractor picks them up alongside @declaration.name.
      // The anchor range is the function_definition itself — we resolve
      // the node and pipe it through the arity helper.
      const anchorCap = grouped['@declaration.function']!;
      const fnNode = findNodeAtRange(tree.rootNode, anchorCap.range, 'function_definition');
      if (fnNode !== null) {
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
