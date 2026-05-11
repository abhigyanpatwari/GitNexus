import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
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

  // Track ranges where typedef-struct/union was captured as @declaration.struct/union
  // so we can suppress the duplicate @declaration.typedef match at the same range.
  const structTypedefRanges = new Set<string>();

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // Handle #include statements
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const includeNode = findNodeAtRange(tree.rootNode, anchor.range, 'preproc_include');
      if (includeNode !== null) {
        const split = splitCInclude(includeNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // Track typedef-struct ranges to suppress duplicate typedef declarations
    const structAnchor = grouped['@declaration.struct'] ?? grouped['@declaration.union'];
    if (structAnchor !== undefined) {
      const r = structAnchor.range;
      structTypedefRanges.add(`${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`);
    }

    // Suppress @declaration.typedef if the same range was already captured as struct/union
    const typedefAnchor = grouped['@declaration.typedef'];
    if (typedefAnchor !== undefined) {
      const r = typedefAnchor.range;
      const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
      if (structTypedefRanges.has(key)) continue;
    }

    // Enrich function declarations with arity metadata and detect static linkage
    const declAnchor = grouped['@declaration.function'];
    if (declAnchor !== undefined) {
      const fnNode =
        findNodeAtRange(tree.rootNode, declAnchor.range, 'function_definition') ??
        findNodeAtRange(tree.rootNode, declAnchor.range, 'declaration');
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

    // Enrich call references with arity
    const callAnchor = grouped['@reference.call.free'] ?? grouped['@reference.call.member'];
    if (callAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = findNodeAtRange(tree.rootNode, callAnchor.range, 'call_expression');
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
