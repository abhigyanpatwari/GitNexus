import { SupportedLanguages } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import type { ResolutionContext } from '../resolution-context.js';
import type { SymbolDefinition } from '../symbol-table.js';
import type { ExtractedRoute } from '../workers/parse-worker.js';
import type {
  ExtractedSpringJavaRouteCandidate,
  SpringRoutePathExpression,
} from './spring-java-types.js';
import type { DeferredRouteCandidate } from './deferred-route-types.js';
import { extractJavaStringLiteral } from '../utils/java-strings.js';
import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';

const CONTROLLER_ANNOTATIONS = new Set(['Controller', 'RestController']);
const CLASS_DECLARATION_TYPES = new Set([
  'class_declaration',
  'record_declaration',
  'interface_declaration',
  'enum_declaration',
]);
const CLASS_LIKE_TYPES = new Set(['Class', 'Record', 'Interface', 'Enum']);
const SHORTCUT_HTTP_METHODS = new Map([
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
]);
const REQUEST_MAPPING_ANNOTATIONS = new Set(['RequestMapping', ...SHORTCUT_HTTP_METHODS.keys()]);

function getAnnotationName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name') ?? node.firstNamedChild;
  return nameNode?.text ?? null;
}

function getElementValuePairParts(node: SyntaxNode): {
  key: string | null;
  value: SyntaxNode | null;
} {
  const keyNode = node.childForFieldName('key') ?? node.namedChild(0);
  const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
  return {
    key: keyNode?.text ?? null,
    value: valueNode ?? null,
  };
}

function extractOwnerPath(node: SyntaxNode | null | undefined): string[] | null {
  if (!node) return null;
  if (node.type === 'identifier') return [node.text];
  if (node.type !== 'field_access') return null;

  const objectNode = node.childForFieldName('object') ?? node.namedChild(0);
  const fieldNode = node.childForFieldName('field') ?? node.namedChild(node.namedChildCount - 1);
  const objectPath = extractOwnerPath(objectNode);
  if (!objectPath || fieldNode?.type !== 'identifier') return null;
  return [...objectPath, fieldNode.text];
}

function extractRoutePathExpression(
  node: SyntaxNode | null | undefined,
): SpringRoutePathExpression | null {
  if (!node) return null;

  const literal = extractJavaStringLiteral(node);
  if (literal !== undefined) return { kind: 'literal', value: literal };

  if (node.type === 'identifier') {
    return { kind: 'identifier', name: node.text };
  }

  if (node.type === 'field_access') {
    const ownerPath = extractOwnerPath(node.childForFieldName('object') ?? node.namedChild(0));
    const fieldNode = node.childForFieldName('field') ?? node.namedChild(node.namedChildCount - 1);
    if (ownerPath && fieldNode?.type === 'identifier') {
      return {
        kind: 'field-access',
        ownerPath,
        fieldName: fieldNode.text,
      };
    }
  }

  return null;
}

function extractRequestMappingPath(annotation: SyntaxNode): {
  expression: SpringRoutePathExpression | null;
  hasExplicitPath: boolean;
} {
  const argsNode = findChild(annotation, 'annotation_argument_list');
  if (!argsNode) return { expression: null, hasExplicitPath: false };

  let hasExplicitPath = false;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (!child) continue;

    const direct = extractRoutePathExpression(child);
    if (direct) return { expression: direct, hasExplicitPath: true };

    if (
      child.type === 'string_literal' ||
      child.type === 'identifier' ||
      child.type === 'field_access'
    ) {
      return { expression: null, hasExplicitPath: true };
    }

    if (child.type === 'element_value_pair') {
      const { key, value } = getElementValuePairParts(child);
      if (key === 'value' || key === 'path') {
        hasExplicitPath = true;
        const fromPair = extractRoutePathExpression(value);
        if (fromPair) return { expression: fromPair, hasExplicitPath: true };
      }
    }
  }

  return { expression: null, hasExplicitPath };
}

function extractRequestMethodName(annotation: SyntaxNode, annotationName: string): string {
  const shortcutMethod = SHORTCUT_HTTP_METHODS.get(annotationName);
  if (shortcutMethod) return shortcutMethod;
  if (annotationName !== 'RequestMapping') return 'GET';

  const argsNode = findChild(annotation, 'annotation_argument_list');
  if (!argsNode) return 'GET';

  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (!child || child.type !== 'element_value_pair') continue;
    const { key, value } = getElementValuePairParts(child);
    if (key !== 'method' || !value) continue;

    if (value.type === 'field_access') {
      return value.text.split('.').pop() ?? 'GET';
    }

    if (value.type === 'array_initializer') {
      for (let j = 0; j < value.namedChildCount; j++) {
        const candidate = value.namedChild(j);
        if (candidate?.type === 'field_access') {
          return candidate.text.split('.').pop() ?? 'GET';
        }
      }
    }
  }

  return 'GET';
}

function normalizePath(path: string | null): string | null {
  if (path == null) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/g, '/');
}

function joinRoutePaths(prefix: string | null, routePath: string | null): string {
  const normalizedPrefix = normalizePath(prefix);
  const normalizedRoutePath = normalizePath(routePath);

  if (normalizedPrefix && normalizedRoutePath) {
    return `${normalizedPrefix}/${normalizedRoutePath.replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  }
  if (normalizedPrefix) return normalizedPrefix;
  if (normalizedRoutePath) return normalizedRoutePath;
  return '/';
}

function findAnnotation(
  modifiersNode: SyntaxNode | null,
  names: ReadonlySet<string>,
): SyntaxNode | null {
  if (!modifiersNode) return null;

  for (let i = 0; i < modifiersNode.namedChildCount; i++) {
    const child = modifiersNode.namedChild(i);
    if (!child || (child.type !== 'annotation' && child.type !== 'marker_annotation')) continue;
    const name = getAnnotationName(child);
    if (name && names.has(name)) return child;
  }

  return null;
}

function isSpringController(modifiersNode: SyntaxNode | null): boolean {
  return findAnnotation(modifiersNode, CONTROLLER_ANNOTATIONS) !== null;
}

function walkClasses(node: SyntaxNode, visit: (classNode: SyntaxNode) => void): void {
  if (CLASS_DECLARATION_TYPES.has(node.type)) visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkClasses(child, visit);
  }
}

function firstConstantValue(defs: readonly SymbolDefinition[]): string | null {
  const withConstant = defs.filter((def) => typeof def.constantValue === 'string');
  return withConstant.length === 1 ? (withConstant[0].constantValue ?? null) : null;
}

function resolveUniqueClassLike(
  name: string,
  filePath: string,
  ctx: ResolutionContext,
): SymbolDefinition | null {
  const resolved = ctx.resolve(name, filePath);
  if (!resolved) return null;
  const classLikes = resolved.candidates.filter((candidate) =>
    CLASS_LIKE_TYPES.has(candidate.type),
  );
  return classLikes.length === 1 ? classLikes[0] : null;
}

function resolveNamedImportConstant(
  name: string,
  filePath: string,
  ctx: ResolutionContext,
): string | null {
  const binding = ctx.namedImportMap.get(filePath)?.get(name);
  if (!binding) return null;

  const def = ctx.symbols.lookupExactFull(binding.sourcePath, binding.exportedName);
  return def?.constantValue ?? null;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function resolveQualifiedClassLike(
  ownerPath: string[],
  filePath: string,
  ctx: ResolutionContext,
): SymbolDefinition | null {
  const ownerName = ownerPath[ownerPath.length - 1];
  if (!ownerName) return null;

  const exact = resolveUniqueClassLike(ownerName, filePath, ctx);
  if (exact || ownerPath.length === 1) return exact;

  const qualifiedSuffix = `/${ownerPath.join('/')}.java`;
  const classLikes = ctx.symbols
    .lookupFuzzy(ownerName)
    .filter((candidate) => CLASS_LIKE_TYPES.has(candidate.type))
    .filter((candidate) => normalizeFilePath(candidate.filePath).endsWith(qualifiedSuffix));
  return classLikes.length === 1 ? classLikes[0] : null;
}

function resolveFieldAccessConstant(
  ownerPath: string[],
  fieldName: string,
  filePath: string,
  ctx: ResolutionContext,
): string | null {
  const ownerDef = resolveQualifiedClassLike(ownerPath, filePath, ctx);
  if (!ownerDef) return null;
  return ctx.symbols.lookupFieldByOwner(ownerDef.nodeId, fieldName)?.constantValue ?? null;
}

function resolvePathExpression(
  expression: SpringRoutePathExpression | null,
  filePath: string,
  className: string,
  ctx: ResolutionContext,
): string | null {
  if (!expression) return null;

  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'identifier': {
      const sameClass = resolveUniqueClassLike(className, filePath, ctx);
      if (sameClass) {
        const local = ctx.symbols.lookupFieldByOwner(
          sameClass.nodeId,
          expression.name,
        )?.constantValue;
        if (local) return local;
      }

      const imported = resolveNamedImportConstant(expression.name, filePath, ctx);
      if (imported) return imported;

      const sameFile = firstConstantValue(
        ctx.symbols
          .lookupExactAll(filePath, expression.name)
          .filter((def) => def.type === 'Property'),
      );
      if (sameFile) return sameFile;

      const resolved = ctx.resolve(expression.name, filePath);
      return resolved ? firstConstantValue(resolved.candidates) : null;
    }
    case 'field-access':
      return resolveFieldAccessConstant(expression.ownerPath, expression.fieldName, filePath, ctx);
  }
}

function buildSpringRouteCandidate(
  filePath: string,
  className: string,
  classPathExpression: SpringRoutePathExpression | null,
  hasExplicitClassPath: boolean,
  methodNode: SyntaxNode,
): ExtractedSpringJavaRouteCandidate | null {
  const modifiersNode = findChild(methodNode, 'modifiers');
  if (!modifiersNode) return null;

  const mappingAnnotation = findAnnotation(modifiersNode, REQUEST_MAPPING_ANNOTATIONS);
  if (!mappingAnnotation) return null;

  const annotationName = getAnnotationName(mappingAnnotation);
  const methodName = methodNode.childForFieldName('name')?.text ?? null;
  if (!annotationName || !methodName) return null;

  const { expression: methodPathExpression, hasExplicitPath: hasExplicitMethodPath } =
    extractRequestMappingPath(mappingAnnotation);

  return {
    kind: 'spring-java',
    language: SupportedLanguages.Java,
    filePath,
    controllerName: className,
    methodName,
    httpMethod: extractRequestMethodName(mappingAnnotation, annotationName),
    classPathExpression,
    methodPathExpression,
    hasExplicitClassPath,
    hasExplicitMethodPath,
    lineNumber: mappingAnnotation.startPosition.row,
  };
}

export function extractSpringJavaRouteCandidates(
  tree: Parser.Tree,
  filePath: string,
): ExtractedSpringJavaRouteCandidate[] {
  const candidates: ExtractedSpringJavaRouteCandidate[] = [];

  walkClasses(tree.rootNode, (classNode) => {
    const modifiersNode = findChild(classNode, 'modifiers');
    if (!isSpringController(modifiersNode)) return;

    const className = classNode.childForFieldName('name')?.text;
    const classBody = classNode.childForFieldName('body');
    if (!className || !classBody) return;

    const requestMapping = findAnnotation(modifiersNode, new Set(['RequestMapping']));
    const classPath = requestMapping
      ? extractRequestMappingPath(requestMapping)
      : { expression: null, hasExplicitPath: false };

    for (let i = 0; i < classBody.namedChildCount; i++) {
      const child = classBody.namedChild(i);
      if (!child || child.type !== 'method_declaration') continue;
      const candidate = buildSpringRouteCandidate(
        filePath,
        className,
        classPath.expression,
        classPath.hasExplicitPath,
        child,
      );
      if (candidate) candidates.push(candidate);
    }
  });

  return candidates;
}

function isSpringJavaRouteCandidate(
  candidate: DeferredRouteCandidate,
): candidate is ExtractedSpringJavaRouteCandidate {
  return candidate.kind === 'spring-java';
}

export function finalizeSpringJavaRoutes(
  candidates: DeferredRouteCandidate[],
  ctx: ResolutionContext,
): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  for (const candidate of candidates) {
    if (!isSpringJavaRouteCandidate(candidate)) continue;
    const classPrefix = resolvePathExpression(
      candidate.classPathExpression,
      candidate.filePath,
      candidate.controllerName,
      ctx,
    );
    const methodPath = resolvePathExpression(
      candidate.methodPathExpression,
      candidate.filePath,
      candidate.controllerName,
      ctx,
    );

    if (candidate.hasExplicitClassPath && classPrefix === null) continue;
    if (candidate.hasExplicitMethodPath && methodPath === null) continue;
    if (classPrefix === null && methodPath === null) continue;

    routes.push({
      filePath: candidate.filePath,
      httpMethod: candidate.httpMethod,
      routePath: joinRoutePaths(classPrefix, methodPath),
      controllerName: candidate.controllerName,
      methodName: candidate.methodName,
      middleware: [],
      prefix: normalizePath(classPrefix),
      lineNumber: candidate.lineNumber,
    });
  }

  return routes;
}
