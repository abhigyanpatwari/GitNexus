import type Parser from 'tree-sitter';
import type { ExtractedRoute } from '../workers/parse-worker.js';
import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';

const CONTROLLER_ANNOTATIONS = new Set(['Controller', 'RestController']);
const SHORTCUT_HTTP_METHODS = new Map([
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
]);
const REQUEST_MAPPING_ANNOTATIONS = new Set([
  'RequestMapping',
  ...SHORTCUT_HTTP_METHODS.keys(),
]);

function getAnnotationName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name') ?? node.firstNamedChild;
  return nameNode?.text ?? null;
}

function extractJavaString(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string_fragment') return node.text;
  if (node.type === 'string_literal') {
    const fragment = node.namedChildren.find((child) => child.type === 'string_fragment');
    if (fragment) return fragment.text;
    return node.text.replace(/^"/, '').replace(/"$/, '');
  }
  return null;
}

function getElementValuePairParts(node: SyntaxNode): { key: string | null; value: SyntaxNode | null } {
  const keyNode = node.childForFieldName('key') ?? node.namedChild(0);
  const valueNode = node.childForFieldName('value') ?? node.namedChild(1);
  return {
    key: keyNode?.text ?? null,
    value: valueNode ?? null,
  };
}

function extractRequestMappingPath(annotation: SyntaxNode): string | null {
  const argsNode = findChild(annotation, 'annotation_argument_list');
  if (!argsNode) return null;

  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'string_literal') {
      return extractJavaString(child);
    }
    if (child.type === 'element_value_pair') {
      const { key, value } = getElementValuePairParts(child);
      if ((key === 'value' || key === 'path') && value) {
        return extractJavaString(value);
      }
    }
  }

  return null;
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

function findAnnotation(modifiersNode: SyntaxNode | null, names: ReadonlySet<string>): SyntaxNode | null {
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

function extractClassLevelPrefix(classNode: SyntaxNode): string | null {
  const modifiersNode = findChild(classNode, 'modifiers');
  const requestMapping = findAnnotation(modifiersNode, new Set(['RequestMapping']));
  return requestMapping ? extractRequestMappingPath(requestMapping) : null;
}

function extractMethodRoute(
  filePath: string,
  className: string,
  classPrefix: string | null,
  methodNode: SyntaxNode,
): ExtractedRoute | null {
  const modifiersNode = findChild(methodNode, 'modifiers');
  if (!modifiersNode) return null;

  const mappingAnnotation = findAnnotation(modifiersNode, REQUEST_MAPPING_ANNOTATIONS);
  if (!mappingAnnotation) return null;

  const annotationName = getAnnotationName(mappingAnnotation);
  const methodName = methodNode.childForFieldName('name')?.text ?? null;
  if (!annotationName || !methodName) return null;

  const methodPath = extractRequestMappingPath(mappingAnnotation);

  return {
    filePath,
    httpMethod: extractRequestMethodName(mappingAnnotation, annotationName),
    routePath: joinRoutePaths(classPrefix, methodPath),
    controllerName: className,
    methodName,
    middleware: [],
    prefix: normalizePath(classPrefix),
    lineNumber: mappingAnnotation.startPosition.row,
  };
}

function walkClasses(node: SyntaxNode, visit: (classNode: SyntaxNode) => void): void {
  if (node.type === 'class_declaration') visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkClasses(child, visit);
  }
}

export function extractSpringJavaRoutes(tree: Parser.Tree, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  walkClasses(tree.rootNode, (classNode) => {
    const modifiersNode = findChild(classNode, 'modifiers');
    if (!isSpringController(modifiersNode)) return;

    const className = classNode.childForFieldName('name')?.text;
    const classBody = classNode.childForFieldName('body');
    if (!className || !classBody) return;

    const classPrefix = extractClassLevelPrefix(classNode);
    for (let i = 0; i < classBody.namedChildCount; i++) {
      const child = classBody.namedChild(i);
      if (!child || child.type !== 'method_declaration') continue;
      const route = extractMethodRoute(filePath, className, classPrefix, child);
      if (route) routes.push(route);
    }
  });

  return routes;
}
