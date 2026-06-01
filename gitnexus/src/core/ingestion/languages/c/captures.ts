import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getCParser, getCScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitCInclude } from './import-decomposer.js';
import { computeCDeclarationArity, computeCCallArity } from './arity-metadata.js';
import { markStaticName } from './static-linkage.js';

export function emitCScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getCParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getCParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getCScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  // Track ranges where typedef-struct/union/enum was captured as its concrete
  // type so we can suppress the duplicate @declaration.typedef match.
  const concreteTypedefRanges = new Set<string>();

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    // Parallel tag -> captured SyntaxNode map. The tree-sitter query already
    // hands us each matched node as `c.node`, so anchors resolve via a
    // type-guarded lookup (`nodeIfType`) instead of re-deriving them with
    // `findNodeAtRange(tree.rootNode, ...)` per match — the
    // O(matches × rootChildren) root-walk fixed for go #1848 / python #1918 /
    // rust/csharp #1915 / java #1951, mirrored here for C. Every C scope-query
    // anchor below captures directly ON the node the old root-walk re-derived
    // (verified against C_SCOPE_QUERY in query.ts: @import.statement on
    // preproc_include, @declaration.function on function_definition/declaration,
    // @reference.call.free/.member on call_expression), so the type check is
    // exact. C has no inheritance construct, so there is no heritage synthesis.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Handle #include statements. `@import.statement` is captured directly on
    // the `preproc_include` node.
    if (grouped['@import.statement'] !== undefined) {
      const includeNode = nodeIfType(nodeMap['@import.statement'], 'preproc_include');
      if (includeNode !== null) {
        const split = splitCInclude(includeNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // Track typedef struct/union/enum ranges to suppress duplicate typedef declarations
    const concreteTypeAnchor =
      grouped['@declaration.struct'] ??
      grouped['@declaration.union'] ??
      grouped['@declaration.enum'];
    if (concreteTypeAnchor !== undefined) {
      const r = concreteTypeAnchor.range;
      concreteTypedefRanges.add(`${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`);
    }

    // Suppress @declaration.typedef if the same range was already captured as a concrete type.
    const typedefAnchor = grouped['@declaration.typedef'];
    if (typedefAnchor !== undefined) {
      const r = typedefAnchor.range;
      const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
      if (concreteTypedefRanges.has(key)) continue;
    }

    // Enrich function declarations with arity metadata and detect static linkage.
    // `@declaration.function` is captured directly on the `function_definition`
    // node (definitions) or the `declaration` node (prototypes) — the captured
    // node IS what the old findNodeAtRange re-derived.
    if (grouped['@declaration.function'] !== undefined) {
      const fnNode = nodeIfType(
        nodeMap['@declaration.function'],
        'function_definition',
        'declaration',
      );
      if (fnNode !== null) {
        const arity = computeCDeclarationArity(fnNode);
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

        // Detect static storage class (file-local linkage)
        if (hasStaticStorageClass(fnNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markStaticName(filePath, nameText);
          }
        }
      }
    }

    // Enrich call references with arity. @reference.call.free / .member are both
    // captured directly on the `call_expression` node — the captured node IS
    // what the old findNodeAtRange re-derived.
    const callAnchorNode = nodeMap['@reference.call.free'] ?? nodeMap['@reference.call.member'];
    if (callAnchorNode !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = nodeIfType(callAnchorNode, 'call_expression');
      if (callNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(computeCCallArity(callNode)),
        );
      }
    }

    out.push(grouped);
  }

  return out;
}

/**
 * Check if a C function_definition or declaration has `static` storage class.
 * Walks direct children for a `storage_class_specifier` node with text `static`.
 */
function hasStaticStorageClass(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.type === 'storage_class_specifier' && child.text === 'static') {
      return true;
    }
  }
  return false;
}
