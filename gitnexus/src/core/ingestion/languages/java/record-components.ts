import { SupportedLanguages, type CaptureMatch } from 'gitnexus-shared';
import type { CaptureMap } from '../../language-provider.js';
import { createMethodExtractor } from '../../method-extractors/generic.js';
import { javaMethodConfig } from '../../method-extractors/configs/jvm.js';
import { extractAnnotations } from '../../field-extractors/configs/helpers.js';
import type {
  ExtractedMethods,
  MethodExtractor,
  MethodExtractorContext,
  MethodInfo,
} from '../../method-types.js';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const javaExplicitMethodExtractor = createMethodExtractor(javaMethodConfig);

function recordComponents(recordNode: SyntaxNode): SyntaxNode[] {
  const parameters = recordNode.childForFieldName('parameters');
  if (parameters === null) return [];
  return parameters.namedChildren.filter(
    (node): node is SyntaxNode =>
      node !== null && (node.type === 'formal_parameter' || node.type === 'spread_parameter'),
  );
}

/**
 * A record component is named by a real `identifier` and nothing else.
 *
 * Two node shapes reach this that are not one, and both would mint a graph node
 * for source that does not compile:
 *
 *  - `record M(int x, y) {}` — a dropped type. tree-sitter recovers by
 *    synthesizing `name: (MISSING identifier)`, a zero-width node whose text is
 *    `''`. It still satisfies the query's `name: (identifier)`, so testing the
 *    node TYPE alone does not reject it.
 *  - `record R(int _) {}` — the grammar declares both `formal_parameter.name`
 *    and `variable_declarator.name` as `identifier | underscore_pattern`, and
 *    `_` parses with no error at all. `_` is illegal as a component name, and
 *    admitting it here while the query rejects it is what let the structure and
 *    scope paths disagree.
 *
 * Same degenerate-node shape as `javaBaseLookupNameNode` in captures.ts (#2935).
 */
function isRecordComponentName(node: SyntaxNode | null | undefined): node is SyntaxNode {
  return (
    node !== null &&
    node !== undefined &&
    node.type === 'identifier' &&
    !node.isMissing &&
    node.text.length > 0
  );
}

function recordComponentNameNode(component: SyntaxNode): SyntaxNode | null {
  const name =
    component.type === 'formal_parameter'
      ? component.childForFieldName('name')
      : (component.namedChildren
          .find((node) => node?.type === 'variable_declarator')
          ?.childForFieldName('name') ?? null);
  return isRecordComponentName(name) ? name : null;
}

/**
 * Memoised per record node. `shouldSkipJavaRecordComponentDefinition` is called
 * once per component capture, so recomputing this would rescan the whole record
 * body per component — O(components x body members) for a single record. The
 * scope-capture path hoists the call out of its own loop instead; this cache is
 * what gives the structure path the same cost. Keyed weakly on the AST node, so
 * it drops with the tree at the end of the file's parse.
 */
const explicitZeroArgAccessorNamesCache = new WeakMap<SyntaxNode, Set<string>>();

function explicitZeroArgAccessorNames(recordNode: SyntaxNode): Set<string> {
  const memoized = explicitZeroArgAccessorNamesCache.get(recordNode);
  if (memoized !== undefined) return memoized;
  const names = computeExplicitZeroArgAccessorNames(recordNode);
  explicitZeroArgAccessorNamesCache.set(recordNode, names);
  return names;
}

function computeExplicitZeroArgAccessorNames(recordNode: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const body = recordNode.childForFieldName('body');
  if (body === null) return names;

  for (const node of body.namedChildren) {
    if (node === null || node.type !== 'method_declaration') continue;
    const name = node.childForFieldName('name')?.text;
    const parameters = node.childForFieldName('parameters');
    const parameterCount =
      parameters?.namedChildren.filter(
        (parameter) =>
          parameter !== null &&
          (parameter.type === 'formal_parameter' || parameter.type === 'spread_parameter'),
      ).length ?? 0;
    if (name !== undefined && parameterCount === 0) names.add(name);
  }
  return names;
}

function recordComponentReturnType(component: SyntaxNode): string | null {
  const typeNode =
    component.childForFieldName('type') ??
    (component.type === 'spread_parameter'
      ? component.namedChildren.find(
          (node) => node?.type !== 'modifiers' && node?.type !== 'variable_declarator',
        )
      : undefined);
  const type = typeNode?.text;
  if (type === undefined) return null;
  return component.type === 'spread_parameter' ? `${type}[]` : type;
}

function implicitAccessorInfo(
  component: SyntaxNode,
  context: MethodExtractorContext,
): MethodInfo | null {
  const name = recordComponentNameNode(component)?.text;
  if (name === undefined) return null;

  return {
    name,
    receiverType: null,
    returnType: recordComponentReturnType(component),
    parameters: [],
    visibility: 'public',
    isStatic: false,
    isAbstract: false,
    isFinal: false,
    // JLS 8.10.3 / 9.7.4: a component annotation reaches the generated accessor
    // when its @Target admits METHOD (or TYPE_USE, in the return-type position).
    // ponytail: over-approximate — we propagate every component annotation,
    // because @Target lives in another file and parsing is per-file, so the
    // target set is not knowable here. Nothing reads Method annotations today:
    // `annotations` is not a column in METHOD_SCHEMA/FUNCTION_SCHEMA
    // (src/core/lbug/schema.ts), so it lives only in the in-memory graph for one
    // analyze run, and the sole in-memory reader (springDiFieldMatcher) is gated
    // to `Property` nodes. If that column is ever added, revisit this: the set
    // would then become an agent-visible claim that may over-state the target.
    annotations: extractAnnotations(component, 'modifiers'),
    sourceFile: context.filePath,
    line: component.startPosition.row + 1,
    column: component.startPosition.column,
  };
}

/** Java records synthesize one public, zero-argument accessor per component. */
export const javaRecordMethodExtractor: MethodExtractor = {
  ...javaExplicitMethodExtractor,
  language: SupportedLanguages.Java,
  extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null {
    const extracted = javaExplicitMethodExtractor.extract(node, context);
    if (extracted === null || node.type !== 'record_declaration') return extracted;

    const explicitAccessors = explicitZeroArgAccessorNames(node);
    const implicitAccessors = recordComponents(node)
      .filter((component) => {
        const name = recordComponentNameNode(component)?.text;
        return name !== undefined && !explicitAccessors.has(name);
      })
      .map((component) => implicitAccessorInfo(component, context))
      .filter((method): method is MethodInfo => method !== null);

    return { ...extracted, methods: [...extracted.methods, ...implicitAccessors] };
  },
};

/** Scope declarations matching the structure-phase synthetic accessor nodes. */
export function synthesizeJavaRecordComponentAccessorCaptures(
  rootNode: SyntaxNode,
): CaptureMatch[] {
  const captures: CaptureMatch[] = [];
  for (const recordNode of rootNode.descendantsOfType('record_declaration')) {
    const explicitAccessors = explicitZeroArgAccessorNames(recordNode);
    for (const component of recordComponents(recordNode)) {
      const nameNode = recordComponentNameNode(component);
      const returnType = recordComponentReturnType(component);
      if (nameNode === null || returnType === null || explicitAccessors.has(nameNode.text))
        continue;

      captures.push({
        '@scope.function': nodeToCapture('@scope.function', component),
      });
      captures.push({
        '@declaration.method': nodeToCapture('@declaration.method', component),
        '@declaration.name': nodeToCapture('@declaration.name', nameNode),
        '@declaration.parameter-count': syntheticCapture(
          '@declaration.parameter-count',
          component,
          '0',
        ),
        '@declaration.required-parameter-count': syntheticCapture(
          '@declaration.required-parameter-count',
          component,
          '0',
        ),
        '@declaration.return-type': syntheticCapture(
          '@declaration.return-type',
          component,
          returnType,
        ),
      });
    }
  }
  return captures;
}

/**
 * The structure query sees every record component. Suppress that synthetic
 * definition when the record body provides the canonical zero-argument
 * accessor explicitly, leaving the explicit method as the single authority.
 */
export function shouldSkipJavaRecordComponentDefinition(captureMap: CaptureMap): boolean {
  const component = captureMap['definition.method'];
  if (component?.type !== 'formal_parameter' && component?.type !== 'spread_parameter') {
    return false;
  }

  const parameters = component.parent;
  const recordNode = parameters?.parent;
  if (parameters?.type !== 'formal_parameters' || recordNode?.type !== 'record_declaration') {
    return false;
  }

  // Same predicate the scope path applies, so the two can never disagree about
  // which components have an accessor. The query's `name: (identifier)` is
  // satisfied by tree-sitter's zero-width MISSING recovery token, so the
  // structure path has to re-check what the query cannot express.
  const nameNode = captureMap['name'];
  if (!isRecordComponentName(nameNode)) return true;

  return explicitZeroArgAccessorNames(recordNode).has(nameNode.text);
}
