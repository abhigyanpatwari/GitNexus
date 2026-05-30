import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getGoParser, getGoScopeQuery } from './query.js';
import { recordGoCacheHit, recordGoCacheMiss } from './cache-stats.js';
import { computeGoCallArity, computeGoDeclarationArity } from './arity-metadata.js';
import { splitGoImportStatement } from './import-decomposer.js';
import { synthesizeGoReceiverBinding } from './receiver-binding.js';
import { synthesizeGoTypeBindings } from './type-binding.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

export function emitGoScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getGoParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getGoParser(), sourceText, undefined, {
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
    // Parallel tag -> captured SyntaxNode map. The tree-sitter query already
    // hands us the matched node as `c.node`; keeping it here lets us derive the
    // anchor/relative node by walking LOCALLY (parent chain / own subtree)
    // instead of re-walking from tree.rootNode (the O(matches x rootChildren)
    // hotpath that made #1848's 250-struct DAO file take ~10s). The captured
    // node either IS the node the old findNodeAtRange re-derived, or is a close
    // relative reachable by a bounded local walk.
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue; // skip anonymous captures
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    if (grouped['@import.statement'] !== undefined) {
      // The captured node is the `import_spec`; the original code preferred its
      // enclosing `import_declaration` ONLY when that ancestor shares the exact
      // same range (which never happens — the declaration always includes the
      // `import` keyword prefix — so it falls back to the import_spec itself).
      // Replicate that exactly via a local ancestor walk, never from root.
      const importNode = resolveImportNode(nodeMap['@import.statement']!);
      if (importNode !== null) {
        out.push(...splitGoImportStatement(importNode));
        continue;
      }
    }

    if (grouped['@scope.function'] !== undefined) {
      // @scope.function captures function_declaration | method_declaration |
      // func_literal. The original looked for a function_declaration or
      // method_declaration at the captured range; the captured node IS that
      // node for the first two, and a func_literal never coincides in range
      // with either, so the lookup yields null for func_literal.
      const scopeNode = nodeMap['@scope.function']!;
      const fnNode =
        scopeNode.type === 'function_declaration' || scopeNode.type === 'method_declaration'
          ? scopeNode
          : null;
      if (fnNode !== null) {
        const receiver = synthesizeGoReceiverBinding(fnNode);
        if (receiver !== null) out.push(receiver);
      }
    }

    if (isRawMultiAssignTypeBinding(nodeMap)) continue;

    const declAnchorNode = nodeMap['@declaration.function'] ?? nodeMap['@declaration.method'];
    if (declAnchorNode !== undefined) {
      // @declaration.function / @declaration.method are captured directly on
      // the function_declaration / method_declaration node.
      const fnNode =
        declAnchorNode.type === 'function_declaration' ||
        declAnchorNode.type === 'method_declaration'
          ? declAnchorNode
          : null;
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

    // @reference.call.free / .member are captured on the call_expression;
    // @reference.call.constructor on the composite_literal. The captured node
    // IS the node the old findNodeAtRange re-derived for each, so use it.
    const callNode =
      nodeMap['@reference.call.free'] ??
      nodeMap['@reference.call.member'] ??
      nodeMap['@reference.call.constructor'];
    if (callNode !== undefined && grouped['@reference.arity'] === undefined) {
      if (callNode.type === 'call_expression' || callNode.type === 'composite_literal') {
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

/**
 * Resolve the node passed to `splitGoImportStatement` for an @import.statement
 * match. The capture is on the `import_spec`; the original preferred an
 * `import_declaration` at the SAME range, else the import_spec. An
 * import_declaration always includes the `import` keyword and so never shares
 * the spec's exact range — the only candidate is an ancestor, and it can only
 * match when ranges coincide. Walk the parent chain (bounded, local) for an
 * import_declaration whose range equals the spec's; otherwise return the spec.
 */
function resolveImportNode(importSpec: SyntaxNode): SyntaxNode {
  let current: SyntaxNode | null = importSpec.parent;
  while (current !== null) {
    if (current.type === 'import_declaration') {
      if (nodeRangeEquals(current, importSpec)) return current;
      break;
    }
    // import_spec is nested at most under import_declaration ->
    // import_spec_list -> import_spec; stop once we leave the import subtree.
    if (current.type !== 'import_spec_list') break;
    current = current.parent;
  }
  return importSpec;
}

/** True iff two nodes occupy the exact same source range. */
function nodeRangeEquals(a: SyntaxNode, b: SyntaxNode): boolean {
  return (
    a.startPosition.row === b.startPosition.row &&
    a.startPosition.column === b.startPosition.column &&
    a.endPosition.row === b.endPosition.row &&
    a.endPosition.column === b.endPosition.column
  );
}

function isRawMultiAssignTypeBinding(nodeMap: Record<string, SyntaxNode>): boolean {
  const anchor =
    nodeMap['@type-binding.constructor'] ??
    nodeMap['@type-binding.call-return'] ??
    nodeMap['@type-binding.assertion'];
  if (anchor === undefined) return false;

  // These tags are captured directly ON the short_var_declaration, so the
  // captured node IS what the original findNodeAtRange(root, range,
  // 'short_var_declaration') re-derived. The var_declaration (var-form)
  // variants — @type-binding.assertion (`var x = e.(T)`) and
  // @type-binding.call-return (`var x = Func()`) — anchor on a var_declaration
  // instead; the old range+type lookup found no short_var_declaration at that
  // range and returned null -> false, which this type guard reproduces exactly.
  if (anchor.type !== 'short_var_declaration') return false;
  const node = anchor;
  const lhs = node.childForFieldName('left');
  const rhs = node.childForFieldName('right');
  if (lhs === null) return false;
  if (rhs === null) return false;
  return (
    lhs.namedChildren.filter((c) => c.type === 'identifier').length >= 2 &&
    rhs.namedChildren.length >= 2
  );
}
