import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getGoParser, getGoScopeQuery } from './query.js';
import { recordGoCacheHit, recordGoCacheMiss } from './cache-stats.js';
import { computeGoCallArity, computeGoDeclarationArity } from './arity-metadata.js';
import { splitGoImportStatement } from './import-decomposer.js';
import { synthesizeGoReceiverBinding } from './receiver-binding.js';
import { synthesizeGoTypeBindings } from './type-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';

export function emitGoScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getGoParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = getGoParser().parse(sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordGoCacheMiss();
  } else {
    recordGoCacheHit();
  }

  const rawMatches = getGoScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue; // skip anonymous captures
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const importNode =
        findNodeAtRange(tree.rootNode, anchor.range, 'import_declaration') ??
        findNodeAtRange(tree.rootNode, anchor.range, 'import_spec');
      if (importNode !== null) {
        out.push(...splitGoImportStatement(importNode));
        continue;
      }
    }

    if (grouped['@scope.function'] !== undefined) {
      const scopeCap = grouped['@scope.function']!;
      const fnNode =
        findNodeAtRange(tree.rootNode, scopeCap.range, 'function_declaration') ??
        findNodeAtRange(tree.rootNode, scopeCap.range, 'method_declaration');
      if (fnNode !== null) {
        const receiver = synthesizeGoReceiverBinding(fnNode);
        if (receiver !== null) out.push(receiver);
      }
    }

    if (isRawMultiAssignTypeBinding(tree.rootNode, grouped)) continue;

    const declAnchor = grouped['@declaration.function'] ?? grouped['@declaration.method'];
    if (declAnchor !== undefined) {
      const fnNode =
        findNodeAtRange(tree.rootNode, declAnchor.range, 'function_declaration') ??
        findNodeAtRange(tree.rootNode, declAnchor.range, 'method_declaration');
      if (fnNode !== null) {
        const arity = computeGoDeclarationArity(fnNode);
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
      out.push(grouped);
      continue;
    }

    const callAnchor =
      grouped['@reference.call.free'] ??
      grouped['@reference.call.member'] ??
      grouped['@reference.call.constructor'];
    if (callAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode =
        findNodeAtRange(tree.rootNode, callAnchor.range, 'call_expression') ??
        findNodeAtRange(tree.rootNode, callAnchor.range, 'composite_literal');
      if (callNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(computeGoCallArity(callNode)),
        );
      }
    }

    out.push(grouped);
  }

  // Layer on type-binding synthesis (new/make/qualified composite literal)
  const synthesized = synthesizeGoTypeBindings(tree.rootNode);
  out.push(...synthesized);

  // Synthesize typeBindings for struct fields so compound receiver
  // resolution (`user.Address.Save()`) can walk field types.
  for (const match of out) {
    if (match['@declaration.field'] === undefined) continue;
    const nameCap = match['@declaration.name'];
    const typeCap = match['@declaration.field-type'];
    if (nameCap === undefined || typeCap === undefined) continue;
    // Create a synthetic @type-binding.field match using the field
    // name and its declared type from the @declaration.field-type capture.
    // This lands in the Class scope's typeBindings (via pass4 positioning).
    out.push({
      '@type-binding.field': typeCap,
      '@type-binding.name': nameCap,
      '@type-binding.type': {
        name: '@type-binding.type',
        text: typeCap.text,
        range: { ...typeCap.range },
      },
    });
  }

  return out;
}

function isRawMultiAssignTypeBinding(
  rootNode: SyntaxNode,
  grouped: Record<string, Capture>,
): boolean {
  const anchor =
    grouped['@type-binding.constructor'] ??
    grouped['@type-binding.call-return'] ??
    grouped['@type-binding.assertion'];
  if (anchor === undefined) return false;

  const node = findNodeAtRange(rootNode, anchor.range, 'short_var_declaration');
  if (node === null) return false;
  const lhs = node.childForFieldName('left');
  const rhs = node.childForFieldName('right');
  if (lhs === null) return false;
  if (rhs === null) return false;
  return (
    lhs.namedChildren.filter((c) => c.type === 'identifier').length >= 2 &&
    rhs.namedChildren.length >= 2
  );
}
