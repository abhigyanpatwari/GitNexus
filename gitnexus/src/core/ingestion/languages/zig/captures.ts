import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getZigParser, getZigScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

const ZIG_CONTAINER_TYPES = new Set([
  'struct_declaration',
  'enum_declaration',
  'union_declaration',
]);

/** Is this variable_declaration a container binding (`const T = struct {…}`)
 *  or an import binding (`const x = @import("…")`)? Those groups are emitted
 *  by their dedicated query rules; the plain @declaration.variable match for
 *  the same node must be dropped so the name binds exactly once. */
function isContainerOrImportBinding(declNode: SyntaxNode): boolean {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child === null) continue;
    if (ZIG_CONTAINER_TYPES.has(child.type)) return true;
    if (child.type === 'builtin_function') {
      const builtin = child.namedChild(0);
      if (builtin?.type === 'builtin_identifier' && builtin.text === '@import') return true;
    }
  }
  return false;
}

/** A `fn` nested in a struct/enum/union container is a method — mirror the
 *  provider's `labelOverride` so scope-side defs carry the same label the
 *  worker gives the graph node. */
function isContainerMethod(fnNode: SyntaxNode): boolean {
  let ancestor = fnNode.parent;
  while (ancestor) {
    if (ZIG_CONTAINER_TYPES.has(ancestor.type)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

export function emitZigScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getZigParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getZigParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getZigScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue; // skip anonymous predicate captures
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // Drop the plain-variable group for container/import bindings — their
    // dedicated rules already bind the name (as Struct/Enum/Union or import).
    const variableAnchor = nodeMap['@declaration.variable'];
    if (variableAnchor !== undefined && isContainerOrImportBinding(variableAnchor)) {
      continue;
    }

    // Relabel container-nested fns Function → Method (provider labelOverride
    // parity). The anchor capture name carries the kind, so rebuild it.
    const fnAnchor = nodeMap['@declaration.function'];
    if (fnAnchor !== undefined && isContainerMethod(fnAnchor)) {
      const fnCapture = grouped['@declaration.function']!;
      delete grouped['@declaration.function'];
      grouped['@declaration.method'] = { ...fnCapture, name: '@declaration.method' };
    }

    out.push(grouped);
  }

  return out;
}
