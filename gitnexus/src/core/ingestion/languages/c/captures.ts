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
import {
  synthesizeCallableFlowCaptures,
  type CallableCaptureSignature,
} from '../../utils/callable-flow-captures.js';

const C_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set(['function_definition']),
  callNodeTypes: new Set(['call_expression']),
  parameterListNodeTypes: new Set(['parameter_list', 'argument_list']),
  parameterNodeTypes: new Set(['parameter_declaration']),
  bindingNodeTypes: new Set(['init_declarator']),
  assignmentNodeTypes: new Set(['assignment_expression']),
  identifierNodeTypes: new Set(['identifier', 'field_identifier', 'type_identifier']),
  callableSignatureDeclarationNodeTypes: new Set(['declaration', 'parameter_declaration']),
  emitCanonicalInvokeReference: true,
  parameterPassingMode: (parameter: SyntaxNode) =>
    containsNodeType(parameter, 'pointer_declarator') ? ('pointer' as const) : ('value' as const),
  expectedSignature: (container: SyntaxNode, destination: SyntaxNode) =>
    functionDeclaratorSignature(destination) ?? functionDeclaratorSignature(container),
} as const;

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

  out.push(...synthesizeCallableFlowCaptures(tree.rootNode, C_CALLABLE_CAPTURE_OPTIONS));
  return out;
}

function functionDeclaratorSignature(node: SyntaxNode): CallableCaptureSignature | undefined {
  const declarator = findDescendantOfType(node, 'function_declarator');
  const parameters = declarator?.childForFieldName('parameters');
  if (parameters === null || parameters === undefined) return undefined;
  const parameterNodes = parameters.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type === 'parameter_declaration',
  );
  // tree-sitter-c materializes `...` as a NAMED `variadic_parameter` node —
  // the anonymous-token checks never matched, so variadic signatures were
  // emitted with a wrong fixed arity (#2522 review). Keep the token checks
  // for grammar variants that expose `...` as an anonymous literal.
  const hasEllipsis = parameters.children.some(
    (child) =>
      child.type === 'variadic_parameter' ||
      child.type === '...' ||
      (!child.isNamed && child.text === '...'),
  );
  const isVoidOnly =
    parameterNodes.length === 1 &&
    parameterNodes[0]!.namedChildCount === 1 &&
    parameterNodes[0]!.firstNamedChild?.text === 'void';
  if (isVoidOnly) return { parameterCount: 0, parameterTypes: [] };
  const parameterTypes = parameterNodes.map(
    (parameter) => parameter.childForFieldName('type')?.text ?? 'unknown',
  );
  if (hasEllipsis) parameterTypes.push('...');
  return {
    ...(hasEllipsis ? {} : { parameterCount: parameterNodes.length }),
    parameterTypes,
  };
}

function containsNodeType(root: SyntaxNode, type: string): boolean {
  return findDescendantOfType(root, type) !== null;
}

function findDescendantOfType(root: SyntaxNode, type: string): SyntaxNode | null {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    for (const child of node.namedChildren) if (child !== null) stack.push(child);
  }
  return null;
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
