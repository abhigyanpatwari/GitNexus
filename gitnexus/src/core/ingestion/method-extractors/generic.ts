// gitnexus/src/core/ingestion/method-extractors/generic.ts

/**
 * Generic table-driven method extractor factory.
 *
 * Mirrors field-extractors/generic.ts — define a config per language and
 * generate extractors from configs. No class hierarchy needed.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  MethodExtractor,
  MethodExtractorContext,
  MethodExtractionConfig,
  ExtractedMethods,
  MethodInfo,
} from '../method-types.js';

/**
 * Node types that imply static member semantics when they appear as the owner
 * of a method (Kotlin companion objects, Kotlin top-level `object` declarations,
 * Ruby `class << self` singleton classes). A config that lists any of these in
 * `typeDeclarationNodes` MUST also include the same node type in
 * `staticOwnerTypes` — otherwise methods inside these containers silently get
 * `isStatic=false`, which is a correctness bug that previously only surfaced
 * at analysis time on large repos.
 *
 * Opt-out: a config that sets `staticOwnerTypes: new Set()` (explicit empty
 * set) signals "I handle static-ness entirely via isStatic()" and is exempt
 * from the guard.
 */
const STATIC_IMPLYING_OWNER_TYPES: ReadonlySet<string> = new Set([
  'companion_object',
  'object_declaration',
  'singleton_class',
]);

/**
 * Create a MethodExtractor from a declarative config.
 *
 * @throws {Error} if `typeDeclarationNodes` contains a static-implying owner
 *   type (companion_object / object_declaration / singleton_class) that is
 *   not covered by `staticOwnerTypes`. The guard fires once per language at
 *   provider construction to prevent silent `isStatic=false` regressions. See
 *   `STATIC_IMPLYING_OWNER_TYPES` for the exact opt-out convention.
 */
export function createMethodExtractor(config: MethodExtractionConfig): MethodExtractor {
  // Runtime invariant: each static-implying container type declared in
  // typeDeclarationNodes must be covered by staticOwnerTypes. An explicit
  // empty Set is treated as intentional opt-out.
  if (config.staticOwnerTypes === undefined) {
    const missing = config.typeDeclarationNodes.filter((t) => STATIC_IMPLYING_OWNER_TYPES.has(t));
    if (missing.length > 0) {
      throw new Error(
        `[MethodExtractionConfig:${config.language}] typeDeclarationNodes includes static-implying owner type(s) ` +
          `${JSON.stringify(missing)} but staticOwnerTypes is not set. Add ` +
          `'staticOwnerTypes: new Set([${missing.map((t) => `'${t}'`).join(', ')}])' ` +
          `to the config, or set 'staticOwnerTypes: new Set()' to opt out explicitly.`,
      );
    }
  } else {
    const missing = config.typeDeclarationNodes.filter(
      (t) => STATIC_IMPLYING_OWNER_TYPES.has(t) && !config.staticOwnerTypes!.has(t),
    );
    // Explicit empty Set is the opt-out signal; don't second-guess it.
    if (missing.length > 0 && config.staticOwnerTypes.size > 0) {
      throw new Error(
        `[MethodExtractionConfig:${config.language}] typeDeclarationNodes includes static-implying owner type(s) ` +
          `${JSON.stringify(missing)} that are missing from staticOwnerTypes. ` +
          `Either add them to staticOwnerTypes, or set 'staticOwnerTypes: new Set()' to opt out explicitly.`,
      );
    }
  }

  const typeDeclarationSet = new Set(config.typeDeclarationNodes);
  const methodNodeSet = new Set(config.methodNodeTypes);
  const bodyNodeSet = new Set(config.bodyNodeTypes);

  return {
    language: config.language,

    isTypeDeclaration(node: SyntaxNode): boolean {
      return typeDeclarationSet.has(node.type);
    },

    extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null {
      if (!typeDeclarationSet.has(node.type)) return null;

      // Resolve owner name: config hook → field-based → type_identifier → simple_identifier → "Companion"
      let ownerName: string | undefined;
      if (config.extractOwnerName) {
        ownerName = config.extractOwnerName(node);
      }
      if (!ownerName) {
        const nameField = node.childForFieldName('name');
        if (nameField) {
          ownerName = nameField.text;
        } else {
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (
              child &&
              (child.type === 'type_identifier' ||
                child.type === 'simple_identifier' ||
                child.type === 'identifier')
            ) {
              ownerName = child.text;
              break;
            }
          }
        }
      }
      // Unnamed companion objects use "Companion" (Kotlin convention)
      if (!ownerName && node.type === 'companion_object') {
        ownerName = 'Companion';
      }
      if (!ownerName) return null;

      const methods: MethodInfo[] = [];
      const bodies = findBodies(node, bodyNodeSet);
      for (const body of bodies) {
        extractMethodsFromBody(body, node, context, config, methodNodeSet, methods);
      }

      // Extract primary constructor from the owner node itself (e.g. C# 12)
      if (config.extractPrimaryConstructor) {
        const primaryCtor = config.extractPrimaryConstructor(node, context);
        if (primaryCtor) methods.push(primaryCtor);
      }

      return { ownerName, methods };
    },

    extractFromNode(node: SyntaxNode, context: MethodExtractorContext): MethodInfo | null {
      if (!methodNodeSet.has(node.type)) return null;
      return buildMethod(node, node, context, config);
    },

    ...(config.extractFunctionName ? { extractFunctionName: config.extractFunctionName } : {}),
  };
}

function findBodies(node: SyntaxNode, bodyNodeSet: Set<string>): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const bodyField = node.childForFieldName('body');
  if (bodyField && bodyNodeSet.has(bodyField.type)) {
    result.push(bodyField);
    addNestedBodies(bodyField, bodyNodeSet, result);
    return result;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && bodyNodeSet.has(child.type)) {
      result.push(child);
    }
  }
  if (result.length === 0 && bodyField) {
    // Fallback: body field exists but its type is not in bodyNodeTypes.
    // This may indicate a config typo — log for debugging if NODE_ENV is development.
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `[MethodExtractor] body field type '${bodyField.type}' not in bodyNodeTypes for node '${node.type}'`,
      );
    }
    result.push(bodyField);
    addNestedBodies(bodyField, bodyNodeSet, result);
  }
  return result;
}

function addNestedBodies(
  parent: SyntaxNode,
  bodyNodeSet: Set<string>,
  out: SyntaxNode[],
  seen?: Set<SyntaxNode>,
): void {
  const visited = seen ?? new Set(out);
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && bodyNodeSet.has(child.type) && !visited.has(child)) {
      visited.add(child);
      out.push(child);
    }
  }
}

function extractMethodsFromBody(
  body: SyntaxNode,
  ownerNode: SyntaxNode,
  context: MethodExtractorContext,
  config: MethodExtractionConfig,
  methodNodeSet: Set<string>,
  out: MethodInfo[],
): void {
  for (let i = 0; i < body.namedChildCount; i++) {
    let child = body.namedChild(i);
    if (!child) continue;

    // C++ template methods are wrapped in template_declaration — unwrap to the inner node
    if (child.type === 'template_declaration') {
      const inner = child.namedChildren.find((c) => methodNodeSet.has(c.type));
      if (inner) child = inner;
    }

    if (methodNodeSet.has(child.type)) {
      const method = buildMethod(child, ownerNode, context, config);
      if (method) out.push(method);
    }

    // Recurse into enum constant anonymous class bodies
    if (child.type === 'enum_constant') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const innerBody = child.namedChild(j);
        if (innerBody && innerBody.type === 'class_body') {
          extractMethodsFromBody(innerBody, ownerNode, context, config, methodNodeSet, out);
        }
      }
    }
  }
}

function buildMethod(
  node: SyntaxNode,
  ownerNode: SyntaxNode,
  context: MethodExtractorContext,
  config: MethodExtractionConfig,
): MethodInfo | null {
  const name = config.extractName(node);
  if (!name) return null;

  const isAbstract = config.isAbstract(node, ownerNode);
  let isFinal = config.isFinal(node);
  // Domain invariant: abstract methods cannot be final
  if (isAbstract) isFinal = false;

  // Static-owner detection is config-driven: each language declares which
  // container node types imply static (e.g. Ruby singleton_class, Kotlin companion_object).
  const isStatic = (config.staticOwnerTypes?.has(ownerNode.type) ?? false) || config.isStatic(node);

  return {
    name,
    receiverType: config.extractReceiverType?.(node) ?? null,
    returnType: config.extractReturnType(node) ?? null,
    parameters: config.extractParameters(node),
    visibility: config.extractVisibility(node),
    isStatic,
    isAbstract,
    isFinal,
    ...(config.isVirtual?.(node) ? { isVirtual: true } : {}),
    ...(config.isOverride?.(node) ? { isOverride: true } : {}),
    ...(config.isAsync?.(node) ? { isAsync: true } : {}),
    ...(config.isPartial?.(node) ? { isPartial: true } : {}),
    ...(config.isConst?.(node) ? { isConst: true } : {}),
    annotations: config.extractAnnotations?.(node) ?? [],
    sourceFile: context.filePath,
    line: node.startPosition.row + 1,
  };
}
