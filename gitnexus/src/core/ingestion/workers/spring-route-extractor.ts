import type { ExtractedRoute } from './parse-worker.js';
import type Parser from 'tree-sitter';

/**
 * Extracts HTTP routes from Spring Boot controller classes by analyzing
 * tree-sitter AST for Java annotations like @GetMapping, @PostMapping, etc.
 *
 * Key behaviors:
 * - Skips @FeignClient interfaces/classes entirely
 * - Combines class-level @RequestMapping prefix with method-level paths
 * - Sets isControllerClass=true for classes with @RestController/@Controller
 * - Defaults to GET for @RequestMapping without method attribute
 */

// Tree-sitter Java node types for annotations
// - marker_annotation — no args (e.g., @RestController, @GetMapping with no path)
// - annotation + annotation_argument_list → element_value_pair nodes

const HTTP_METHOD_ANNOTATIONS = new Map<string, string>([
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
]);

/**
 * Combines class prefix with method path, normalizing the result.
 * - Strips trailing slashes from prefix
 * - Ensures method path starts with /
 * - Avoids double slashes
 */
function combinePaths(prefix: string | null, methodPath: string): string {
  if (!prefix && !methodPath) return '';
  if (!prefix) return methodPath.startsWith('/') ? methodPath : '/' + methodPath;
  if (!methodPath) return prefix;

  // Strip trailing slash from prefix
  const p = prefix.replace(/\/+$/, '');
  // Ensure method path starts with /
  const m = methodPath.startsWith('/') ? methodPath : '/' + methodPath;
  return p + m;
}

/**
 * Extracts string content from a string_literal node.
 */
function extractStringContent(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type !== 'string_literal') return null;
  // string_literal has string_fragment as a child with the actual content
  for (const child of node.children) {
    if (child.type === 'string_fragment') {
      return child.text;
    }
  }
  // Fallback: remove quotes from the text
  return node.text.replace(/^["']|["']$/g, '');
}

/**
 * Extracts the first string argument from an annotation.
 * Handles both unnamed first arg and named "value" or "path" attributes.
 * When encountering an identifier or field_access node, uses resolveStringNode
 * with the provided constants map to resolve the constant value.
 */
function extractAnnotationPath(
  annotationNode: Parser.SyntaxNode,
  constants?: Map<string, string>,
): string | null {
  // marker_annotation has no arguments
  if (annotationNode.type === 'marker_annotation') {
    return '';
  }

  // annotation has annotation_argument_list
  const argsList = annotationNode.childForFieldName('arguments') ?? annotationNode.children.find(c => c.type === 'annotation_argument_list');
  if (!argsList) return null;

  // Helper to check if node is a "value" node we can resolve
  const isValueNode = (node: Parser.SyntaxNode): boolean => {
    return node.type === 'string_literal' || node.type === 'identifier' ||
           node.type === 'field_access' || node.type === 'binary_expression';
  };

  // Helper to skip punctuation (brackets, parens, commas)
  const isPunctuation = (node: Parser.SyntaxNode): boolean => {
    const t = node.type;
    return t === '(' || t === ')' || t === '[' || t === ']' || t === ',' || t === '{' || t === '}';
  };

  // Look for element_value_pair with key "value" or "path"
  for (const child of argsList.children) {
    if (child.type === 'element_value_pair') {
      // The key is an 'identifier' child at index 0, '=' is at index 1
      // Value is at index 2 or later
      const keyNode = child.children[0];
      if (keyNode && keyNode.type === 'identifier' && (keyNode.text === 'value' || keyNode.text === 'path')) {
        // Value is after key ('=' at index 1)
        const valueNode = child.children[2];
        if (valueNode) {
          if (valueNode.type === 'string_literal') {
            const str = extractStringContent(valueNode);
            if (str !== null) return str;
          }
          // identifier, field_access, or binary_expression - use resolveStringNode
          if (constants) {
            const resolved = resolveStringNode(valueNode, constants);
            if (resolved !== null) return resolved;
          }
        }
      }
    }
  }

  // Look for unnamed first argument (skip punctuation)
  for (const child of argsList.children) {
    if (isPunctuation(child)) continue;
    if (child.type === 'string_literal') {
      return extractStringContent(child);
    }
    // identifier, field_access, or binary_expression (constant reference)
    if (constants && isValueNode(child)) {
      const resolved = resolveStringNode(child, constants);
      // If resolved is null, the constant wasn't found - return raw text
      // so caller can distinguish "no value" from "unresolved constant"
      return resolved ?? child.text;
    }
  }

  return null;
}

/**
 * Extracts HTTP method(s) from an @RequestMapping annotation.
 * Returns an array because `method = {RequestMethod.X, RequestMethod.Y}` is valid
 * Java syntax and Spring fans it out to one route per element.
 * Defaults to ['GET'] for marker annotations or when no `method` attribute is present.
 * Handles:
 *   - method = RequestMethod.POST                  → ['POST']
 *   - method = {RequestMethod.PUT}                 → ['PUT']
 *   - method = {RequestMethod.GET, RequestMethod.POST} → ['GET', 'POST']
 */
function extractRequestMappingMethod(annotationNode: Parser.SyntaxNode): string[] {
  if (annotationNode.type === 'marker_annotation') {
    return ['GET']; // Default method
  }

  const argsList = annotationNode.childForFieldName('arguments') ?? annotationNode.children.find(c => c.type === 'annotation_argument_list');
  if (!argsList) return ['GET'];

  for (const child of argsList.children) {
    if (child.type === 'element_value_pair') {
      // The key is an 'identifier' child
      const keyNode = child.children.find(c => c.type === 'identifier');
      if (keyNode && keyNode.text === 'method') {
        // Find value after '=' (could be field_access, scoped_identifier, or element_value_array_initializer)
        const valueNode = child.children.find(c => c.type === 'field_access' || c.type === 'scoped_identifier' || c.type === 'element_value_array_initializer');
        if (valueNode) {
          // Handle: method = RequestMethod.POST → ['POST']
          if (valueNode.type === 'field_access' || valueNode.type === 'scoped_identifier') {
            const parts = valueNode.text.split('.');
            const lastPart = parts[parts.length - 1];
            return [lastPart.toUpperCase()];
          }
          // Handle: method = {RequestMethod.X, ...} → ['X', ...]
          // Collect ALL elements; do not stop at the first.
          if (valueNode.type === 'element_value_array_initializer') {
            const methods: string[] = [];
            for (const elem of valueNode.children) {
              if (elem.type === 'field_access' || elem.type === 'scoped_identifier') {
                const parts = elem.text.split('.');
                const lastPart = parts[parts.length - 1];
                methods.push(lastPart.toUpperCase());
              }
            }
            if (methods.length > 0) return methods;
          }
        }
      }
    }
  }

  return ['GET']; // Default
}

/**
 * Resolves an AST node to its string value, using the constants map
 * for identifier and field_access references.
 * Handles: string_literal, identifier, field_access, binary_expression (concatenation)
 *
 * For identifiers/field_access: returns resolved value if found, otherwise the raw text.
 * For binary_expression: returns concatenated string if all parts resolve, otherwise null.
 */

/**
 * Extracts a string-or-array attribute (e.g. `produces`, `consumes`) from an annotation.
 *
 * Returns the array of string values:
 * - If the annotation has an `element_value_pair` with the given `key`...
 *   - and the value is a `string_literal`, returns `[value]`
 *   - and the value is an `element_value_array_initializer`, returns all string
 *     fragments inside the braces (skipping punctuation).
 * - Otherwise returns `[]` (attribute omitted or value not a recognized form).
 *
 * Constant references (identifiers, field_access) are resolved against the
 * provided `constants` map. Unresolved references are kept as their raw text.
 */
function extractArrayOrString(
  annotationNode: Parser.SyntaxNode,
  key: 'produces' | 'consumes',
  constants: Map<string, string>,
): string[] {
  if (annotationNode.type === 'marker_annotation') {
    return [];
  }

  const argsList =
    annotationNode.childForFieldName('arguments') ??
    annotationNode.children.find(c => c.type === 'annotation_argument_list');
  if (!argsList) return [];

  for (const child of argsList.children) {
    if (child.type !== 'element_value_pair') continue;
    const keyNode = child.children.find(c => c.type === 'identifier');
    if (!keyNode || keyNode.text !== key) continue;

    // The value node sits after the '=' token. Skip the key identifier (it is
    // an `identifier` too) by starting the search from the child that follows
    // the keyNode, then look for the first value-shaped node. Fall back to the
    // last child for robustness against extra whitespace nodes.
    const valueCandidates = child.children.slice(child.children.indexOf(keyNode) + 1);
    const valueNode =
      valueCandidates.find(
        c => c.type === 'string_literal' || c.type === 'element_value_array_initializer' ||
             c.type === 'identifier' || c.type === 'field_access' || c.type === 'binary_expression',
      ) ?? valueCandidates[valueCandidates.length - 1];
    if (!valueNode) return [];

    if (valueNode.type === 'string_literal') {
      const str = extractStringContent(valueNode);
      return str !== null ? [str] : [];
    }

    if (valueNode.type === 'element_value_array_initializer') {
      const out: string[] = [];
      for (const elem of valueNode.children) {
        if (elem.type === 'string_literal') {
          const str = extractStringContent(elem);
          if (str !== null) out.push(str);
        } else if (constants && (elem.type === 'identifier' || elem.type === 'field_access' || elem.type === 'binary_expression')) {
          const resolved = resolveStringNode(elem, constants);
          if (resolved !== null) out.push(resolved);
        }
      }
      return out;
    }

    // Single constant reference like `produces = MediaType.APPLICATION_JSON_VALUE`
    if (constants && (valueNode.type === 'identifier' || valueNode.type === 'field_access' || valueNode.type === 'binary_expression')) {
      const resolved = resolveStringNode(valueNode, constants);
      if (resolved !== null) return [resolved];
    }

    return [];
  }

  return [];
}

function resolveStringNode(node: Parser.SyntaxNode, constants: Map<string, string>): string | null {
  if (!node) return null;

  switch (node.type) {
    case 'string_literal':
      return extractStringContent(node);

    case 'identifier': {
      // Simple constant name, e.g., API_PATH
      const value = constants.get(node.text);
      return value !== undefined ? value : node.text;
    }

    case 'field_access': {
      // Qualified reference, e.g., Constants.API_PATH
      const text = node.text;
      const value = constants.get(text);
      if (value !== undefined) return value;

      // Also try just the simple name as fallback
      const parts = text.split('.');
      const simpleName = parts[parts.length - 1];
      const simpleValue = constants.get(simpleName);
      return simpleValue !== undefined ? simpleValue : text;
    }

    case 'binary_expression': {
      // String concatenation, e.g., Constants.PREFIX + "/users"
      // Use namedChildCount and namedChild to avoid non-named children like '+'
      if (node.namedChildCount < 2) return null;

      const leftNode = node.namedChild(0);
      const rightNode = node.namedChild(1);

      // Verify it's a '+' operator by checking for binary_operator or literal '+' node
      let hasPlus = false;
      for (const child of node.children) {
        if (!child.isNamed && (child.type === 'binary_operator' || child.type === '+')) {
          if (child.text === '+') {
            hasPlus = true;
            break;
          }
        }
      }
      if (!hasPlus) return null;

      const left = leftNode ? resolveStringNode(leftNode, constants) : null;
      const right = rightNode ? resolveStringNode(rightNode, constants) : null;

      if (left !== null && right !== null) {
        return left + right;
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Extracts a public static final String constant from a field_declaration node.
 * Adds to the constants map with both simple name and qualified ClassName.CONST name.
 */
function extractFieldConstant(
  fieldNode: Parser.SyntaxNode,
  className: string,
  constants: Map<string, string>,
): void {
  // Find modifiers to check for public static final
  let isPublic = false;
  let isStatic = false;
  let isFinal = false;
  let isStringType = false;

  for (const child of fieldNode.children) {
    if (child.type === 'modifiers') {
      for (const mod of child.children) {
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') continue;
        const modText = mod.text;
        if (modText === 'public') isPublic = true;
        if (modText === 'static') isStatic = true;
        if (modText === 'final') isFinal = true;
      }
    } else if (child.type === 'integral_type' || child.type === 'type_identifier') {
      // Check if it's a String type
      const typeText = child.text;
      if (typeText === 'String') isStringType = true;
    } else if (child.type === 'field_access') {
      // Could be String -> check if it's java.lang.String
      const text = child.text;
      if (text === 'java.lang.String' || text.endsWith('.String')) isStringType = true;
    }
  }

  if (!isPublic || !isStatic || !isFinal || !isStringType) return;

  // Find the variable_declarator to get the name and value
  for (const child of fieldNode.children) {
    if (child.type === 'variable_declarator') {
      let nameNode: Parser.SyntaxNode | null = null;
      let valueNode: Parser.SyntaxNode | null = null;

      for (const vc of child.children) {
        // Skip non-named tokens like '=' punctuation
        if (!vc.isNamed) continue;
        if (vc.type === 'identifier' && !nameNode) {
          nameNode = vc;
        } else if (!valueNode) {
          valueNode = vc;
        }
      }

      if (nameNode) {
        const constName = nameNode.text;
        const constValue = valueNode ? resolveStringNode(valueNode, constants) : null;

        if (constValue !== null) {
          // Add with simple name
          constants.set(constName, constValue);
          // Add with qualified name ClassName.CONST
          if (className) {
            constants.set(`${className}.${constName}`, constValue);
          }
        }
      }
    }
  }
}

/**
 * Collects all public static final String constants from a Java file AST.
 * Walks the tree for class declarations and extracts constants from field declarations.
 */
export function collectFileConstants(rootNode: Parser.SyntaxNode): Map<string, string> {
  const constants = new Map<string, string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
      // Get class name
      const className = node.childForFieldName('name')?.text ?? node.children.find(c => c.type === 'identifier')?.text;

      // Find class_body
      const body = node.children.find(c => c.type === 'class_body' || c.type === 'interface_body' || c.type === 'enum_body');

      if (body) {
        // Look for field_declarations
        for (const member of body.children) {
          if (member.type === 'field_declaration') {
            extractFieldConstant(member, className ?? '', constants);
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(rootNode);
  return constants;
}

/**
 * Extracts all `public static final String` constants from a Java AST.
 * Returns Map with both simple name -> value and qualified ClassName.CONST -> value.
 */
export function extractJavaConstants(tree: Parser.Tree): Map<string, string> {
  return collectFileConstants(tree.rootNode);
}

/**
 * Checks if a class/interface has a specific annotation.
 */
function hasAnnotation(classBody: Parser.SyntaxNode | null, annotationName: string): boolean {
  if (!classBody) return false;

  // Find the class_declaration or interface_declaration node
  const classDecl = classBody.parent;
  if (!classDecl) return false;

  // Look for modifiers which contain annotations
  for (const child of classDecl.children) {
    if (child.type === 'modifiers' || child.type === 'marker_annotation' || child.type === 'annotation') {
      // Check for annotation in modifiers
      const annotations = child.type === 'modifiers' ? child.children : [child];
      for (const ann of annotations) {
        if (ann.type === 'marker_annotation' || ann.type === 'annotation') {
          const nameNode = ann.childForFieldName('name') ?? ann.children[0];
          if (nameNode && nameNode.text === annotationName) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Gets all annotations from a class or interface declaration.
 */
function getClassAnnotations(classDecl: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const annotations: Parser.SyntaxNode[] = [];

  for (const child of classDecl.children) {
    if (child.type === 'modifiers') {
      for (const modChild of child.children) {
        if (modChild.type === 'marker_annotation' || modChild.type === 'annotation') {
          annotations.push(modChild);
        }
      }
    } else if (child.type === 'marker_annotation' || child.type === 'annotation') {
      annotations.push(child);
    }
  }

  return annotations;
}

/**
 * Extracts the path from a class-level @RequestMapping annotation.
 */
function getClassRequestMappingPrefix(
  classDecl: Parser.SyntaxNode,
  constants?: Map<string, string>,
): string | null {
  const annotations = getClassAnnotations(classDecl);

  for (const ann of annotations) {
    // The annotation name is an 'identifier' child, not 'name' field
    const nameNode = ann.children.find(c => c.type === 'identifier');
    if (nameNode && nameNode.text === 'RequestMapping') {
      return extractAnnotationPath(ann, constants);
    }
  }

  return null;
}

/**
 * Extracts the method name from a method_declaration node.
 */
function getMethodName(methodDecl: Parser.SyntaxNode): string | null {
  for (const child of methodDecl.children) {
    if (child.type === 'identifier' || child.type === 'method_header') {
      // For method_header, find the identifier inside
      if (child.type === 'method_header') {
        for (const headerChild of child.children) {
          if (headerChild.type === 'identifier') {
            return headerChild.text;
          }
        }
      } else {
        return child.text;
      }
    }
  }
  // Fallback: look for method_header and then identifier
  const header = methodDecl.childForFieldName('name') ?? methodDecl.children.find(c => c.type === 'identifier');
  return header ? header.text : null;
}

/**
 * Builds a map of className -> class-level @RequestMapping prefix for every
 * class/interface/enum declaration in the file. The map is used to resolve
 * inherited prefixes when a subclass has no class-level @RequestMapping.
 *
 * Note: This is computed for every class in the file (not just @RestController
 * ones) because a base class may carry a plain @Controller annotation or
 * even no controller annotation at all but still declare a path prefix.
 */
function buildClassPrefixMap(
  rootNode: Parser.SyntaxNode,
  constants: Map<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
      const name = node.childForFieldName('name')?.text ?? node.children.find(c => c.type === 'identifier')?.text;
      if (name) {
        const prefix = getClassRequestMappingPrefix(node, constants);
        // Only set if there is a prefix; absence means "no class-level @RequestMapping"
        if (prefix !== null) {
          map.set(name, prefix);
        }
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(rootNode);
  return map;
}

/**
 * Extracts the superclass type name from a class_declaration node.
 * Handles the common Java `extends BaseClass` form. Returns null if the class
 * does not extend anything (e.g. an interface, enum, or class without a parent).
 */
function getSuperclassName(classDecl: Parser.SyntaxNode): string | null {
  if (classDecl.type !== 'class_declaration') return null;

  // Tree-sitter Java exposes the parent class via the `superclass` field on
  // class_declaration.
  const superclassField = classDecl.childForFieldName('superclass');
  if (superclassField) {
    if (superclassField.type === 'type_identifier') {
      return superclassField.text;
    }
    const inner = superclassField.children.find(c => c.type === 'type_identifier');
    if (inner) return inner.text;
    return superclassField.text;
  }

  // Fallback: scan children for superclass / superclass_list
  for (const child of classDecl.children) {
    if (child.type === 'superclass') {
      const inner = child.children.find(c => c.type === 'type_identifier');
      if (inner) return inner.text;
      return child.text;
    }
    if (child.type === 'superclass_list') {
      for (const sc of child.children) {
        if (sc.type === 'type_identifier') {
          return sc.text;
        }
      }
    }
  }

  return null;
}

/**
 * Extracts routes from a single class/interface declaration.
 */
function extractRoutesFromClass(
  classDecl: Parser.SyntaxNode,
  filePath: string,
  constants: Map<string, string>,
  classPrefixMap: Map<string, string> = new Map(),
): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  // Check for @FeignClient — skip entire class/interface
  const classAnnotations = getClassAnnotations(classDecl);
  for (const ann of classAnnotations) {
    // The annotation name is an 'identifier' child, not 'name' field
    const nameNode = ann.children.find(c => c.type === 'identifier');
    if (nameNode && nameNode.text === 'FeignClient') {
      return []; // Skip FeignClient
    }
  }

  // Check if this is a controller class
  const isControllerClass = classAnnotations.some(ann => {
    const nameNode = ann.children.find(c => c.type === 'identifier');
    return nameNode && (nameNode.text === 'RestController' || nameNode.text === 'Controller');
  });

  // Get class-level @RequestMapping prefix, falling back to an inherited
  // prefix from a superclass declared in the same file.
  let classPrefix = getClassRequestMappingPrefix(classDecl, constants);
  let isInheritedPrefix = false;
  if (classPrefix === null) {
    const superName = getSuperclassName(classDecl);
    if (superName) {
      const inherited = classPrefixMap.get(superName);
      if (inherited !== undefined) {
        classPrefix = inherited;
        isInheritedPrefix = true;
      }
    }
  }

  // Get class name
  const className = classDecl.childForFieldName('name')?.text ?? classDecl.children.find(c => c.type === 'identifier')?.text;

  // Find class_body
  const classBody = classDecl.children.find(c => c.type === 'class_body' || c.type === 'interface_body' || c.type === 'enum_body');

  if (!classBody) return [];

  // Iterate over methods in class_body
  for (const member of classBody.children) {
    if (member.type !== 'method_declaration') continue;

    const methodName = getMethodName(member);
    if (!methodName) continue;

    // Find route annotations on the method
    for (const child of member.children) {
      if (child.type === 'modifiers') {
        for (const modChild of child.children) {
          if (modChild.type === 'marker_annotation' || modChild.type === 'annotation') {
            const ann = modChild;
            // The annotation name is an 'identifier' child
            const nameNode = ann.children.find(c => c.type === 'identifier');
            if (!nameNode) continue;

            const annotationName = nameNode.text;

            // Check for specific HTTP method annotations
            if (HTTP_METHOD_ANNOTATIONS.has(annotationName)) {
              const methodPath = extractAnnotationPath(ann, constants) ?? '';
              // If methodPath looks like a raw constant reference (contains '.'), use it directly
              // Otherwise combine with class prefix as normal
              const fullRoutePath = methodPath.includes('.') ? methodPath : combinePaths(classPrefix, methodPath);
              const lineNumber = ann.startPosition.row + 1; // tree-sitter uses 0-based
              const produces = extractArrayOrString(ann, 'produces', constants);
              const consumes = extractArrayOrString(ann, 'consumes', constants);

              routes.push({
                filePath,
                httpMethod: HTTP_METHOD_ANNOTATIONS.get(annotationName)!,
                routePath: fullRoutePath,
                controllerName: className ?? null,
                methodName,
                middleware: [],
                prefix: classPrefix,
                lineNumber,
                isControllerClass,
                isInherited: isInheritedPrefix,
                ...(produces.length > 0 ? { produces } : {}),
                ...(consumes.length > 0 ? { consumes } : {}),
              });
            } else if (annotationName === 'RequestMapping') {
              const methodPath = extractAnnotationPath(ann, constants) ?? '';
              // extractRequestMappingMethod returns string[] because Spring allows
              // `method = {RequestMethod.GET, RequestMethod.POST}` (array form),
              // which fans out into one route per element.
              const httpMethods = extractRequestMappingMethod(ann);
              // If methodPath looks like a raw constant reference (contains '.'), use it directly
              const fullRoutePath = methodPath.includes('.') ? methodPath : combinePaths(classPrefix, methodPath);
              const lineNumber = ann.startPosition.row + 1;
              const produces = extractArrayOrString(ann, 'produces', constants);
              const consumes = extractArrayOrString(ann, 'consumes', constants);

              // Fan out: one route per HTTP method (single-element array still produces one route)
              for (const httpMethod of httpMethods) {
                routes.push({
                  filePath,
                  httpMethod,
                  routePath: fullRoutePath,
                  controllerName: className ?? null,
                  methodName,
                  middleware: [],
                  prefix: classPrefix,
                  lineNumber,
                  isControllerClass,
                  isInherited: isInheritedPrefix,
                  ...(produces.length > 0 ? { produces } : {}),
                  ...(consumes.length > 0 ? { consumes } : {}),
                });
              }
            }
          }
        }
      }
    }
  }

  return routes;
}

/**
 * Main entry point: extracts Spring routes from a parsed Java file.
 * Walks all class and interface declarations, extracts routes from controller classes.
 * Optionally accepts a Map of constants for resolving constant references like
 * @GetMapping(Constants.API_PATH) - pass a Map with entries like 'Constants.API_PATH' -> '/api'
 */
export function extractSpringRoutes(
  tree: Parser.Tree,
  filePath: string,
  constants?: Map<string, string>,
): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  const constantMap = constants ?? new Map<string, string>();

  // Pre-pass: build className -> @RequestMapping prefix map for ALL classes
  // in the file. This enables a subclass to inherit a class-level prefix
  // from a same-file superclass (see WI-90).
  const classPrefixMap = buildClassPrefixMap(tree.rootNode, constantMap);

  function walk(node: Parser.SyntaxNode): void {
    // Check for class_declaration, interface_declaration, enum_declaration
    if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
      const classRoutes = extractRoutesFromClass(node, filePath, constantMap, classPrefixMap);
      routes.push(...classRoutes);
      // Continue walking for nested classes
    }

    // Recurse into children
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return routes;
}

// ============================================================================
// WI-90: cross-file @RequestMapping inheritance (repo-wide pass)
//
// The single-tree `extractSpringRoutes` above only sees one file and emits
// routes for methods physically present in each class body. A @RestController
// that `extends` a base controller declared in ANOTHER file therefore loses
// every inherited handler. The functions below run AFTER all Java files are
// parsed: they build a repo-wide class registry and emit synthetic routes for
// inherited mapped methods, with the concrete subclass as the controller.
// `extractSpringRoutes` / `extractRoutesFromClass` are intentionally left
// untouched so the same-file behavior (and the #144 negative test) is preserved.
// ============================================================================

/** A mapped (route-bearing) method recorded for cross-file inheritance. */
interface SpringMappedMethod {
  methodName: string;
  httpMethods: string[];        // already fanned out (['GET'] or ['GET','POST'])
  methodPath: string;           // raw path BEFORE prefix combine
  rawConstantPath: boolean;     // methodPath.includes('.') → use as-is, don't combine
  produces?: string[];
  consumes?: string[];
  lineNumber: number;
}

/** One class declaration recorded in the repo-wide Spring registry. */
export interface SpringClassRegistryEntry {
  className: string;
  filePath: string;
  classPrefix: string | null;   // own class-level @RequestMapping prefix, else null
  isController: boolean;        // has @RestController or @Controller
  superclassName: string | null;
  ownMethodNames: Set<string>;  // method names physically declared in this class body
  mappedMethods: SpringMappedMethod[];
}

/** Collect the route-bearing methods of one class body (additive — mirrors the
 *  per-method annotation loop in extractRoutesFromClass without changing it). */
function buildSpringClassRegistryEntry(
  classDecl: Parser.SyntaxNode,
  filePath: string,
  constants: Map<string, string>,
): SpringClassRegistryEntry | null {
  const className = classDecl.childForFieldName('name')?.text
    ?? classDecl.children.find(c => c.type === 'identifier')?.text;
  if (!className) return null;

  const classAnnotations = getClassAnnotations(classDecl);
  // @FeignClient classes never contribute routes (mirror extractRoutesFromClass).
  for (const ann of classAnnotations) {
    const nameNode = ann.children.find(c => c.type === 'identifier');
    if (nameNode && nameNode.text === 'FeignClient') return null;
  }
  const isController = classAnnotations.some(ann => {
    const nameNode = ann.children.find(c => c.type === 'identifier');
    return !!nameNode && (nameNode.text === 'RestController' || nameNode.text === 'Controller');
  });

  const classPrefix = getClassRequestMappingPrefix(classDecl, constants);
  const superclassName = getSuperclassName(classDecl);

  const ownMethodNames = new Set<string>();
  const mappedMethods: SpringMappedMethod[] = [];

  const classBody = classDecl.children.find(c =>
    c.type === 'class_body' || c.type === 'interface_body' || c.type === 'enum_body');
  if (classBody) {
    for (const member of classBody.children) {
      if (member.type !== 'method_declaration') continue;
      const methodName = getMethodName(member);
      if (!methodName) continue;
      ownMethodNames.add(methodName);

      for (const child of member.children) {
        if (child.type !== 'modifiers') continue;
        for (const modChild of child.children) {
          if (modChild.type !== 'marker_annotation' && modChild.type !== 'annotation') continue;
          const ann = modChild;
          const nameNode = ann.children.find(c => c.type === 'identifier');
          if (!nameNode) continue;
          const annotationName = nameNode.text;

          if (HTTP_METHOD_ANNOTATIONS.has(annotationName)) {
            const methodPath = extractAnnotationPath(ann, constants) ?? '';
            const produces = extractArrayOrString(ann, 'produces', constants);
            const consumes = extractArrayOrString(ann, 'consumes', constants);
            mappedMethods.push({
              methodName,
              httpMethods: [HTTP_METHOD_ANNOTATIONS.get(annotationName)!],
              methodPath,
              rawConstantPath: methodPath.includes('.'),
              lineNumber: ann.startPosition.row + 1,
              ...(produces.length > 0 ? { produces } : {}),
              ...(consumes.length > 0 ? { consumes } : {}),
            });
          } else if (annotationName === 'RequestMapping') {
            const methodPath = extractAnnotationPath(ann, constants) ?? '';
            const httpMethods = extractRequestMappingMethod(ann);
            const produces = extractArrayOrString(ann, 'produces', constants);
            const consumes = extractArrayOrString(ann, 'consumes', constants);
            mappedMethods.push({
              methodName,
              httpMethods,
              methodPath,
              rawConstantPath: methodPath.includes('.'),
              lineNumber: ann.startPosition.row + 1,
              ...(produces.length > 0 ? { produces } : {}),
              ...(consumes.length > 0 ? { consumes } : {}),
            });
          }
        }
      }
    }
  }

  return { className, filePath, classPrefix, isController, superclassName, ownMethodNames, mappedMethods };
}

/**
 * Build a repo-wide registry of Spring class declarations across all parsed
 * Java files. Reuses already-parsed trees (no second parse).
 */
export function buildSpringClassRegistry(
  javaFiles: Array<{ filePath: string; tree: Parser.Tree }>,
  constants: Map<string, string>,
): Map<string, SpringClassRegistryEntry> {
  const registry = new Map<string, SpringClassRegistryEntry>();

  const walk = (node: Parser.SyntaxNode, filePath: string): void => {
    if (node.type === 'class_declaration') {
      const entry = buildSpringClassRegistryEntry(node, filePath, constants);
      if (entry) registry.set(entry.className, entry); // last-writer-wins on name collision
    }
    for (const child of node.children) walk(child, filePath);
  };

  for (const { filePath, tree } of javaFiles) {
    walk(tree.rootNode, filePath);
  }
  return registry;
}

/** Resolve the effective class-level prefix for a controller: its own prefix,
 *  else the nearest ancestor prefix (Spring merges @RequestMapping up the chain). */
function resolveEffectiveSpringPrefix(
  entry: SpringClassRegistryEntry,
  registry: Map<string, SpringClassRegistryEntry>,
): string | null {
  if (entry.classPrefix !== null) return entry.classPrefix;
  const visited = new Set<string>([entry.className]);
  let current = entry.superclassName;
  let depth = 0;
  while (current && !visited.has(current) && depth < 10) {
    visited.add(current);
    depth++;
    const ancestor = registry.get(current);
    if (!ancestor) break;
    if (ancestor.classPrefix !== null) return ancestor.classPrefix;
    current = ancestor.superclassName;
  }
  return null;
}

/**
 * Emit synthetic ExtractedRoutes for handler methods a controller inherits from
 * base classes defined in OTHER files. Each controller walks its superclass
 * chain (cycle-guarded, depth-capped); for each ancestor mapped method not
 * already provided by the subclass or a nearer ancestor, one route per HTTP
 * method is emitted with the concrete subclass as controller and isInherited:true.
 */
export function extractInheritedSpringRoutes(
  registry: Map<string, SpringClassRegistryEntry>,
): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  for (const entry of registry.values()) {
    if (!entry.isController) continue;

    const effectivePrefix = resolveEffectiveSpringPrefix(entry, registry);
    // own methods (and, as we walk, nearer-ancestor methods) win over farther ones
    const emitted = new Set<string>(entry.ownMethodNames);

    const visited = new Set<string>([entry.className]);
    let current = entry.superclassName;
    let depth = 0;
    while (current && !visited.has(current) && depth < 10) {
      visited.add(current);
      depth++;
      const ancestor = registry.get(current);
      if (!ancestor) break;

      for (const mm of ancestor.mappedMethods) {
        if (emitted.has(mm.methodName)) continue;
        for (const httpMethod of mm.httpMethods) {
          const routePath = mm.rawConstantPath
            ? mm.methodPath
            : combinePaths(effectivePrefix, mm.methodPath);
          routes.push({
            filePath: entry.filePath,
            httpMethod,
            routePath,
            controllerName: entry.className,
            methodName: mm.methodName,
            middleware: [],
            prefix: effectivePrefix,
            lineNumber: mm.lineNumber,
            isControllerClass: true,
            isInherited: true,
            ...(mm.produces && mm.produces.length > 0 ? { produces: mm.produces } : {}),
            ...(mm.consumes && mm.consumes.length > 0 ? { consumes: mm.consumes } : {}),
          });
        }
        emitted.add(mm.methodName);
      }

      current = ancestor.superclassName;
    }
  }

  return routes;
}