import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { findNodeAtRange, nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import { getCParser, getCScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitCInclude } from './import-decomposer.js';
import { computeCDeclarationArity, computeCCallArity } from './arity-metadata.js';

export function emitCScopeCaptures(
  sourceText: string,
  _filePath: string,
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

    // Enrich function declarations with arity metadata
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
      }
    }

    // Enrich call references with arity
    const callAnchor =
      grouped['@reference.call.free'] ?? grouped['@reference.call.member'];
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

  // Synthesize typeBindings for struct fields (for compound receiver resolution)
  for (const match of out) {
    if (match['@declaration.field'] === undefined) continue;
    const nameCap = match['@declaration.name'];
    if (nameCap === undefined) continue;
    // For C, we don't have rich type info on fields from the query
    // but we keep the slot for future enhancement
  }

  return out;
}
