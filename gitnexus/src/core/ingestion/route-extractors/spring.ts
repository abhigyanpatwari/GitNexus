// Extracts Spring Boot routes from Java source code
// This is a basic implementation using regex for annotation parsing
// For robust extraction, consider integrating a Java parser in the future
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

export interface SpringRoute {
  path: string;
  method: string;
  httpMethod?: string; // optional for compatibility
  controller: string;
  handler: string;
  lineNumber: number;
  framework: string;
}

const CONTROLLER_ANNOTATIONS = [
  '@RestController',
  '@Controller',
];

const MAPPING_ANNOTATIONS = [
  { regex: /@GetMapping\(([^)]*)\)/, method: 'GET' },
  { regex: /@PostMapping\(([^)]*)\)/, method: 'POST' },
  { regex: /@PutMapping\(([^)]*)\)/, method: 'PUT' },
  { regex: /@DeleteMapping\(([^)]*)\)/, method: 'DELETE' },
  // (#91) @PatchMapping was missing from the standalone extractor.
  // The production pipeline (workers/spring-route-extractor.ts) handled
  // it correctly, but the standalone extractRoutesFromClass in this
  // file was emitting `ANY` for every @PatchMapping endpoint. Add it
  // here so the standalone extractor and the pipeline agree.
  { regex: /@PatchMapping\(([^)]*)\)/, method: 'PATCH' },
  { regex: /@RequestMapping\(([^)]*)\)/, method: 'ANY' },
];

function joinSpringPaths(classPath: string, methodPath: string): string {
  // Normalize both paths
  let c = classPath ? classPath.trim() : '';
  let m = methodPath ? methodPath.trim() : '';
  if (!c && !m) return '/';
  // Remove trailing slash from classPath (unless it's just '/')
  if (c.length > 1 && c.endsWith('/')) c = c.slice(0, -1);
  // Remove leading slash from methodPath
  if (m.startsWith('/')) m = m.slice(1);
  // Avoid double slashes
  if (c && m) return (c.startsWith('/') ? '' : '/') + c + (m ? '/' + m : '');
  if (c) return c.startsWith('/') ? c : '/' + c;
  if (m) return m.startsWith('/') ? m : '/' + m;
  return '/';
}

/**
 * Public entry point for the pipeline: parse a Java source string and extract
 * all `public static final String` constants from every class in the file.
 *
 * Used by the pipeline's cross-file pre-pass: scan all .java files first,
 * merge constants into a repo-wide map, then call extractSpringRoutes() with it.
 *
 * @example
 *   const globalConstants = new Map<string, string>();
 *   for (const file of javaFiles) {
 *     for (const [k, v] of extractJavaConstants(file.content)) globalConstants.set(k, v);
 *   }
 *   const routes = await extractSpringRoutes(controllerSource, globalConstants);
 */
export function extractJavaConstants(javaSource: string): Map<string, string> {
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse(javaSource);
  return collectFileConstants(tree.rootNode);
}

/**
 * Collect all `public static final String CONST_NAME = "value";` declarations
 * from the parsed Java AST. This covers constants declared in the same file
 * (e.g. inside the controller class, or in a sibling class in the same file).
 *
 * Returns a Map: qualifiedName → value  (e.g. "Config.API_PATH" → "/api/v1")
 * and also simple name → value          (e.g. "API_PATH" → "/api/v1")
 */
export function collectFileConstants(rootNode: any): Map<string, string> {
  const constants = new Map<string, string>();

  function walk(node: any) {
    // Look for class declarations to get class name as qualifier
    if (node.type === 'class_declaration') {
      const classNameNode = node.namedChildren?.find((n: any) => n.type === 'identifier');
      const className = classNameNode?.text ?? '';
      const body = node.namedChildren?.find((n: any) => n.type === 'class_body');
      if (body) {
        for (const member of body.namedChildren ?? []) {
          extractFieldConstant(member, className, constants);
        }
      }
    }
    // Recurse
    for (const child of node.namedChildren ?? []) {
      walk(child);
    }
  }

  walk(rootNode);
  return constants;
}

/**
 * Try to extract a `static final String` field and record it in the map.
 * Handles:
 *   public static final String FOO = "bar";
 *   public static final String FOO = OTHER_CONST + "/sub";  (simple concat)
 */
function extractFieldConstant(
  fieldNode: any,
  className: string,
  constants: Map<string, string>,
): void {
  if (fieldNode.type !== 'field_declaration') return;

  // Check modifiers: must have 'static' and 'final'
  const modifiersNode = fieldNode.namedChildren?.find((n: any) => n.type === 'modifiers');
  if (!modifiersNode) return;
  const modText = modifiersNode.text ?? '';
  if (!modText.includes('static') || !modText.includes('final')) return;

  // Must be String type
  const typeNode = fieldNode.namedChildren?.find((n: any) =>
    n.type === 'type_identifier' || n.type === 'integral_type' || n.type === 'void_type',
  );
  if (!typeNode || typeNode.text !== 'String') return;

  // Find declarator(s)
  for (const decl of fieldNode.namedChildren ?? []) {
    if (decl.type !== 'variable_declarator') continue;
    const nameNode = decl.namedChildren?.find((n: any) => n.type === 'identifier');
    if (!nameNode) continue;
    const fieldName = nameNode.text;
    const valueNode = decl.namedChildren?.find((n: any) => n !== nameNode);
    if (!valueNode) continue;

    // Resolve value — may be a string literal or simple binary concat
    const resolved = resolveStringNode(valueNode, constants);
    if (resolved !== null) {
      constants.set(fieldName, resolved);
      if (className) {
        constants.set(`${className}.${fieldName}`, resolved);
      }
    }
  }
}

/**
 * Recursively resolve an AST node to a string value using the known constants map.
 *
 * Supported node types:
 *   string_literal           → strip quotes
 *   identifier               → look up constants map (local/simple name)
 *   field_access             → look up as "Object.FIELD" or just "FIELD"
 *   binary_expression (+)    → concatenate two resolved operands
 */
function resolveStringNode(node: any, constants: Map<string, string>): string | null {
  if (!node) return null;

  switch (node.type) {
    case 'string_literal': {
      // Java string: "value" — strip surrounding quotes
      return node.text.replace(/^["']|["']$/g, '');
    }

    case 'identifier': {
      // Simple constant name, e.g. PATH_PREFIX
      return constants.get(node.text) ?? null;
    }

    case 'field_access': {
      // e.g. Config.API_PATH_PREFIX
      // tree-sitter-java: field_access has object (left) and field (identifier on right)
      const fullText = node.text; // "Config.API_PATH_PREFIX"
      if (constants.has(fullText)) return constants.get(fullText)!;

      // Try just the field name (right-hand identifier)
      const fieldNameNode = node.namedChildren?.find((n: any) => n.type === 'identifier');
      const fieldName = fieldNameNode?.text;
      if (fieldName && constants.has(fieldName)) return constants.get(fieldName)!;

      return null;
    }

    case 'binary_expression': {
      // String concatenation: LEFT + RIGHT
      const operatorNode = node.children?.find((n: any) => n.type === '+');
      if (!operatorNode) return null;
      // namedChildren for binary_expression are the two operands
      const [left, right] = node.namedChildren ?? [];
      const leftVal = resolveStringNode(left, constants);
      const rightVal = resolveStringNode(right, constants);
      if (leftVal !== null && rightVal !== null) return leftVal + rightVal;
      if (leftVal !== null) return leftVal; // partial resolve — keep what we can
      return null;
    }

    default:
      return null;
  }
}

export async function extractSpringRoutes(
  javaSource: string,
  /** Optional pre-built constant map from other files (cross-file resolution) */
  externalConstants?: ReadonlyMap<string, string>,
): Promise<SpringRoute[]> {
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse(javaSource);
  const routes: SpringRoute[] = [];

  // ── Phase 1: collect constants from this file ──────────────────────────
  const fileConstants = collectFileConstants(tree.rootNode);

  // Merge external constants (external wins only when local doesn't have the key)
  const constants: Map<string, string> = new Map(fileConstants);
  if (externalConstants) {
    for (const [k, v] of externalConstants) {
      if (!constants.has(k)) constants.set(k, v);
    }
  }

  // ── AST helper functions ───────────────────────────────────────────────

  function getAnnotationName(annotationNode: any): string | null {
    if (!annotationNode) return null;
    // For marker_annotation or annotation
    const idNode = annotationNode.namedChildren?.find((n: any) => n.type === 'identifier');
    return idNode ? idNode.text : null;
  }

  /**
   * Extract the string value from an annotation argument.
   *
   * If `key` is given, finds a named element_value_pair (e.g. value="...", path="...").
   * Otherwise, reads the first positional argument.
   *
   * Supports: string literals, constants (field_access / identifier), string concatenation.
   */
  function getAnnotationValue(annotationNode: any, key: string | null = null): string | null {
    if (!annotationNode) return null;
    // For annotation arguments
    const argsNode = annotationNode.namedChildren?.find(
      (n: any) => n.type === 'argument_list' || n.type === 'annotation_argument_list',
    );
    if (!argsNode) return null;

    if (key) {
      // Find key-value pair
      for (const pair of argsNode.namedChildren) {
        if (pair.type === 'element_value_pair' && pair.namedChildren[0]?.text === key) {
          const valNode = pair.namedChildren[1];
          return resolveStringNode(valNode, constants);
        }
      }
    } else {
      // Single value or multiple values
      for (const valNode of argsNode.namedChildren) {
        // Skip element_value_pair with a key — we want positional only here
        if (valNode.type === 'element_value_pair') continue;

        // Handle array_initializer for multiple paths (take the first one)
        if (valNode.type === 'array_initializer' && valNode.namedChildren.length > 0) {
          for (const item of valNode.namedChildren) {
            const resolved = resolveStringNode(item, constants);
            if (resolved !== null) return resolved;
          }
          continue;
        }

        const resolved = resolveStringNode(valNode, constants);
        if (resolved !== null) return resolved;
      }
    }
    return null;
  }

  function getModifiers(node: any) {
    // Chỉ lấy annotation từ modifiers node
    const modifiersNode = node.namedChildren?.find((n: any) => n.type === 'modifiers');
    if (!modifiersNode) return [];
    return modifiersNode.namedChildren?.filter((n: any) => n.type.endsWith('annotation')) || [];
  }

  function findNodesByType(node: any, type: string, results: any[] = []) {
    if (node.type === type) results.push(node);
    if (node.namedChildren) {
      for (const child of node.namedChildren) {
        findNodesByType(child, type, results);
      }
    }
    return results;
  }

  function findControllerClasses(root: any) {
    const result: any[] = [];
    const classNodes = findNodesByType(root, 'class_declaration');
    for (const classNode of classNodes) {
      const annotations = getModifiers(classNode);
      for (const ann of annotations) {
        const annName = getAnnotationName(ann);
        if (CONTROLLER_ANNOTATIONS.includes('@' + annName)) {
          result.push(classNode);
          break;
        }
      }
    }
    return result;
  }

  function extractRoutesFromClass(classNode: any) {
    let classLevelPath = '';
    let controllerName = classNode.namedChildren.find((n: any) => n.type === 'identifier')?.text || '';
    const classAnnotations = getModifiers(classNode);
    for (const ann of classAnnotations) {
      const annName = getAnnotationName(ann);
      if (annName === 'RequestMapping') {
        classLevelPath = getAnnotationValue(ann, 'value') || getAnnotationValue(ann, 'path') || getAnnotationValue(ann) || '';
      }
    }
    const classBody = classNode.namedChildren.find((n: any) => n.type === 'class_body');
    if (!classBody) return;
    for (const methodNode of classBody.namedChildren.filter((n: any) => n.type === 'method_declaration')) {
      let methodLevelPath = '';
      let httpMethods: string[] = ['ANY'];
      let handler = methodNode.namedChildren.find((n: any) => n.type === 'identifier')?.text || '';
      const methodAnnotations = getModifiers(methodNode);
      for (const ann of methodAnnotations) {
        const annName = getAnnotationName(ann);
        if (annName === 'GetMapping') { httpMethods = ['GET']; }
        if (annName === 'PostMapping') { httpMethods = ['POST']; }
        if (annName === 'PutMapping') { httpMethods = ['PUT']; }
        if (annName === 'DeleteMapping') { httpMethods = ['DELETE']; }
        // (#91) @PatchMapping was missing from the inline check below.
        // The MAPPING_ANNOTATIONS regex at the top of the file is only
        // used by the regex-based extractors; extractRoutesFromClass
        // dispatches by name explicitly. Add the dispatch here so
        // @PatchMapping produces a PATCH route, not ANY.
        if (annName === 'PatchMapping') { httpMethods = ['PATCH']; }
        if ([
          'GetMapping','PostMapping','PutMapping','DeleteMapping','PatchMapping','RequestMapping'
        ].includes(annName)) {
          methodLevelPath = getAnnotationValue(ann, 'value') || getAnnotationValue(ann, 'path') || getAnnotationValue(ann) || '';
          if (methodLevelPath.startsWith('/')) methodLevelPath = methodLevelPath.slice(1);
          if (annName === 'RequestMapping') {
            const argsNode = ann.namedChildren?.find((n: any) => n.type === 'argument_list' || n.type === 'annotation_argument_list');
            if (argsNode) {
              for (const pair of argsNode.namedChildren) {
                if (pair.type === 'element_value_pair' && pair.namedChildren[0]?.text === 'method') {
                  const valNode = pair.namedChildren[1];
                  if (valNode) {
                    if (valNode.type === 'field_access') {
                      const val = valNode.text;
                      if (val && val.startsWith('RequestMethod.')) {
                        httpMethods = [val.replace('RequestMethod.', '')];
                      }
                    // (#91) tree-sitter-java wraps `{RequestMethod.X}`
                    // (and `{RequestMethod.X, RequestMethod.Y}`) in an
                    // `element_value_array_initializer` node, NOT an
                    // `array_initializer`. The previous check only
                    // matched `array_initializer`, so single-element and
                    // multi-element method arrays both fell through to
                    // the default `['ANY']`. Match the real node type
                    // and also keep the bare `array_initializer` check
                    // for robustness across tree-sitter versions.
                    } else if (valNode.type === 'element_value_array_initializer' || valNode.type === 'array_initializer') {
                      httpMethods = valNode.namedChildren
                        .filter((n: any) => n.type === 'field_access' && n.text.startsWith('RequestMethod.'))
                        .map((n: any) => n.text.replace('RequestMethod.', ''));
                    }
                  }
                }
              }
            }
          }
        }
      }
      if (methodLevelPath || classLevelPath) {
        const fullPath = joinSpringPaths(classLevelPath, methodLevelPath);
        for (const httpMethod of httpMethods) {
          routes.push({
            path: fullPath,
            method: httpMethod,
            controller: controllerName,
            handler,
            lineNumber: methodNode.startPosition?.row ?? 0,
            framework: 'spring',
          });
        }
      }
    }
  }

  const controllerClasses = findControllerClasses(tree.rootNode);
  for (const cls of controllerClasses) {
    extractRoutesFromClass(cls);
  }
  return routes;
}
