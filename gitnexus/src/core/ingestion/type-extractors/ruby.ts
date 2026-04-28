import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ConstructorBindingScanner,
  PendingAssignmentExtractor,
  ForLoopExtractor,
} from './types.js';
import {
  extractRubyConstructorAssignment,
  extractSimpleTypeName,
  extractElementTypeFromString,
  extractVarName,
  resolveIterableElementType,
} from './shared.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * Ruby type extractor — YARD annotation parsing.
 *
 * Ruby has no static type system, but the YARD documentation convention
 * provides de facto type annotations via comments:
 *
 *   # @param name [String] the user's name
 *   # @param repo [UserRepo] the repository
 *   # @return [User]
 *   def create(name, repo)
 *     repo.save
 *   end
 *
 * This extractor parses `@param name [Type]` patterns from comment nodes
 * preceding method definitions and binds parameter names to their types.
 *
 * Resolution tiers:
 * - Tier 0: YARD @param annotations (extractDeclaration pre-populates env)
 * - Tier 1: Constructor inference via `user = User.new` (handled by scanConstructorBinding in typeConfig)
 */

/** Regex to extract @param annotations: `@param name [Type]` */
const YARD_PARAM_RE = /@param\s+(\w+)\s+\[([^\]]+)\]/g;
/** Alternate YARD order: `@param [Type] name` */
const YARD_PARAM_ALT_RE = /@param\s+\[([^\]]+)\]\s+(\w+)/g;

/**
 * Extract the simple type name from a YARD type string.
 * Handles:
 * - Simple types: "String" → "String"
 * - Qualified types: "Models::User" → "User"
 * - Generic types: "Array<User>" → "Array"
 * - Nullable types: "String, nil" → "String"
 * - Union types: "String, Integer" → undefined (ambiguous)
 */
const extractYardTypeName = (yardType: string): string | undefined => {
  const trimmed = yardType.trim();

  // Handle nullable: "Type, nil" or "nil, Type"
  // Use bracket-balanced split to avoid breaking on commas inside generics like Hash<Symbol, User>
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '<') depth++;
    else if (trimmed[i] === '>') depth--;
    else if (trimmed[i] === ',' && depth === 0) {
      parts.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start).trim());
  const filtered = parts.filter((p) => p !== '' && p !== 'nil');
  if (filtered.length !== 1) return undefined; // ambiguous union

  const typePart = filtered[0];

  // Handle qualified: "Models::User" → "User"
  const segments = typePart.split('::');
  const last = segments[segments.length - 1];

  // Handle generic: "Array<User>" → "Array"
  const genericMatch = last.match(/^(\w+)\s*[<{(]/);
  if (genericMatch) return genericMatch[1];

  // Simple identifier check
  if (/^\w+$/.test(last)) return last;

  return undefined;
};

/**
 * Collect YARD @param annotations from comment nodes preceding a method definition.
 * Returns a map of paramName → typeName.
 *
 * In tree-sitter-ruby, comments are sibling nodes that appear before the method node.
 * We walk backwards through preceding siblings collecting consecutive comment nodes.
 */
const collectYardParams = (methodNode: SyntaxNode): Map<string, string> => {
  const params = new Map<string, string>();

  // In tree-sitter-ruby, YARD comments preceding a method inside a class body
  // are placed as children of the `class` node, NOT as siblings of the `method`
  // inside `body_statement`. The AST structure is:
  //
  //   class
  //     constant = "ClassName"
  //     comment = "# @param ..."     ← sibling of body_statement
  //     comment = "# @param ..."     ← sibling of body_statement
  //     body_statement
  //       method                     ← method is here, no preceding siblings
  //
  // For top-level methods (outside classes), comments ARE direct siblings.
  // We handle both by checking: if method has no preceding comment siblings,
  // look at parent (body_statement) siblings instead.
  const commentTexts: string[] = [];

  const collectComments = (startNode: SyntaxNode): void => {
    let sibling = startNode.previousSibling;
    while (sibling) {
      if (sibling.type === 'comment') {
        commentTexts.unshift(sibling.text);
      } else if (sibling.isNamed) {
        break;
      }
      sibling = sibling.previousSibling;
    }
  };

  // Try method's own siblings first (top-level methods)
  collectComments(methodNode);

  // If no comments found and parent is body_statement, check parent's siblings
  if (commentTexts.length === 0 && methodNode.parent?.type === 'body_statement') {
    collectComments(methodNode.parent);
  }

  // Parse all comment lines for @param annotations
  const commentBlock = commentTexts.join('\n');
  let match: RegExpExecArray | null;

  // Reset regex state
  YARD_PARAM_RE.lastIndex = 0;
  while ((match = YARD_PARAM_RE.exec(commentBlock)) !== null) {
    const paramName = match[1];
    const rawType = match[2];
    const typeName = extractYardTypeName(rawType);
    if (typeName) {
      params.set(paramName, typeName);
    }
  }

  // Also check alternate YARD order: @param [Type] name
  YARD_PARAM_ALT_RE.lastIndex = 0;
  while ((match = YARD_PARAM_ALT_RE.exec(commentBlock)) !== null) {
    const rawType = match[1];
    const paramName = match[2];
    if (params.has(paramName)) continue; // standard format takes priority
    const typeName = extractYardTypeName(rawType);
    if (typeName) {
      params.set(paramName, typeName);
    }
  }

  return params;
};

/**
 * Ruby node types that may carry type bindings.
 * - `method`/`singleton_method`: YARD @param annotations (via extractDeclaration)
 * - `assignment`: Constructor inference like `user = User.new` (via extractInitializer;
 *   extractDeclaration returns early for these nodes)
 */
const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'method',
  'singleton_method',
  'assignment',
]);

/**
 * Extract YARD annotations from method definitions.
 * Pre-populates the scope env with parameter types before the
 * standard parameter walk (which won't find types since Ruby has none).
 */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type !== 'method' && node.type !== 'singleton_method') return;

  const yardParams = collectYardParams(node);
  if (yardParams.size === 0) return;

  // Pre-populate env with YARD type bindings for each parameter
  for (const [paramName, typeName] of yardParams) {
    env.set(paramName, typeName);
  }
};

/**
 * Ruby parameter extraction.
 * Ruby parameters (identifiers inside method_parameters) have no inline
 * type annotations. YARD types are already populated by extractDeclaration,
 * so this is a no-op — the bindings are already in the env.
 *
 * We still register this to maintain the LanguageTypeConfig contract.
 */
const extractParameter: ParameterExtractor = (
  _node: SyntaxNode,
  _env: Map<string, string>,
): void => {
  // Ruby parameters have no type annotations.
  // YARD types are pre-populated by extractDeclaration.
};

/**
 * Ruby constructor inference: user = User.new or service = Models::User.new
 * Uses the shared extractRubyConstructorAssignment helper for AST matching,
 * then resolves against locally-known class names.
 */
const extractInitializer: InitializerExtractor = (node, env, classNames): void => {
  const result = extractRubyConstructorAssignment(node);
  if (!result) return;
  if (env.has(result.varName)) return;
  if (classNames.has(result.calleeName)) {
    env.set(result.varName, result.calleeName);
  }
};

/**
 * Ruby constructor binding scanner: captures both `user = User.new` and
 * plain call assignments like `user = get_user()`.
 * The `.new` pattern returns the class name directly; plain calls return the
 * callee name for return-type inference via SymbolTable lookup.
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  // Try the .new pattern first (returns class name directly)
  const newResult = extractRubyConstructorAssignment(node);
  if (newResult) return newResult;

  // Plain call assignment: user = get_user() / user = Models.create()
  if (node.type !== 'assignment') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'identifier' && left.type !== 'constant') return undefined;
  if (right.type !== 'call') return undefined;
  const method = right.childForFieldName('method');
  if (!method) return undefined;
  const calleeName = extractSimpleTypeName(method);
  if (!calleeName) return undefined;
  return { varName: left.text, calleeName };
};

/** Ruby method node types that carry a parameter list. */
const RUBY_METHOD_NODE_TYPES = new Set(['method', 'singleton_method']);

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['for']);

/**
 * Collect raw YARD @param type strings from comment nodes preceding a method.
 * Unlike collectYardParams which returns simplified type names, this returns the
 * raw bracket content (e.g., "Array<User>" not "Array") for element type extraction.
 */
const collectYardRawParams = (methodNode: SyntaxNode): Map<string, string> => {
  const params = new Map<string, string>();
  const commentTexts: string[] = [];

  const collectComments = (startNode: SyntaxNode): void => {
    let sibling = startNode.previousSibling;
    while (sibling) {
      if (sibling.type === 'comment') {
        commentTexts.unshift(sibling.text);
      } else if (sibling.isNamed) {
        break;
      }
      sibling = sibling.previousSibling;
    }
  };

  collectComments(methodNode);
  if (commentTexts.length === 0 && methodNode.parent?.type === 'body_statement') {
    collectComments(methodNode.parent);
  }

  const commentBlock = commentTexts.join('\n');
  let match: RegExpExecArray | null;

  YARD_PARAM_RE.lastIndex = 0;
  while ((match = YARD_PARAM_RE.exec(commentBlock)) !== null) {
    params.set(match[1], match[2]);
  }
  YARD_PARAM_ALT_RE.lastIndex = 0;
  while ((match = YARD_PARAM_ALT_RE.exec(commentBlock)) !== null) {
    if (!params.has(match[2])) params.set(match[2], match[1]);
  }

  return params;
};

/**
 * Walk up the AST from a for-statement to find the enclosing method,
 * then search its YARD @param annotations for one named `iterableName`.
 * Returns the element type extracted from the raw YARD type string.
 *
 * Example: `@param users [Array<User>]` → extracts "User" from "Array<User>".
 */
const findRubyParamElementType = (
  iterableName: string,
  startNode: SyntaxNode,
): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (RUBY_METHOD_NODE_TYPES.has(current.type)) {
      const rawParams = collectYardRawParams(current);
      const rawType = rawParams.get(iterableName);
      if (rawType) return extractElementTypeFromString(rawType);
      break;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Ruby: for user in users ... end
 *
 * tree-sitter-ruby `for` node structure:
 *   pattern field: the loop variable (identifier)
 *   value field: `in` node whose child is the iterable expression
 *
 * Tier 1c: resolves the element type via:
 *   1. scopeEnv string — extractElementTypeFromString on the stored type
 *   2. AST walk — walks up to the enclosing method's YARD @param to read Array<User> directly
 *
 * Ruby has no static types on loop variables, so this mainly works when the
 * iterable has a YARD-annotated container type (e.g., `@param users [Array<User>]`).
 */
const extractForLoopBinding: ForLoopExtractor = (
  node,
  { scopeEnv, declarationTypeNodes, scope },
): void => {
  if (node.type !== 'for') return;

  // The loop variable is the `pattern` field (identifier).
  const patternNode = node.childForFieldName('pattern');
  if (!patternNode) return;
  const loopVarName = extractVarName(patternNode);
  if (!loopVarName) return;

  // The iterable is inside the `value` field which is an `in` node wrapping the expression.
  const inNode = node.childForFieldName('value');
  if (!inNode) return;
  const iterableNode = inNode.firstNamedChild;
  let iterableName: string | undefined;
  if (iterableNode?.type === 'identifier') {
    iterableName = iterableNode.text;
  } else if (iterableNode?.type === 'call') {
    const method = iterableNode.childForFieldName('method');
    if (method) iterableName = method.text;
  }
  if (!iterableName) return;

  // Ruby has no extractFromTypeNode (no AST type annotations), pass a no-op.
  const noopExtractFromTypeNode = (): string | undefined => undefined;

  const elementType = resolveIterableElementType(
    iterableName,
    node,
    scopeEnv,
    declarationTypeNodes,
    scope,
    noopExtractFromTypeNode,
    findRubyParamElementType,
    undefined,
  );
  if (!elementType) return;

  scopeEnv.set(loopVarName, elementType);
};

/**
 * Ruby: alias_user = user → assignment with left/right identifier fields.
 * Only handles plain identifier RHS (not calls, not literals).
 * Skips if LHS already has a resolved type in scopeEnv.
 */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type !== 'assignment') return undefined;
  const lhsNode = node.childForFieldName('left');
  if (!lhsNode || lhsNode.type !== 'identifier') return undefined;
  const varName = lhsNode.text;
  if (scopeEnv.has(varName)) return undefined;
  const rhsNode = node.childForFieldName('right');
  if (!rhsNode) return undefined;
  if (rhsNode.type === 'identifier') return { kind: 'copy', lhs: varName, rhs: rhsNode.text };
  // call/method_call RHS — Ruby uses method calls for both field access and method calls
  if (rhsNode.type === 'call' || rhsNode.type === 'method_call') {
    const methodNode = rhsNode.childForFieldName('method');
    const receiverNode = rhsNode.childForFieldName('receiver');
    if (!receiverNode && methodNode?.type === 'identifier') {
      // No receiver → callResult (bare function call)
      return { kind: 'callResult', lhs: varName, callee: methodNode.text };
    }
    if (receiverNode?.type === 'identifier' && methodNode?.type === 'identifier') {
      // With receiver → methodCallResult (a.method)
      return {
        kind: 'methodCallResult',
        lhs: varName,
        receiver: receiverNode.text,
        method: methodNode.text,
      };
    }
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractForLoopBinding,
  extractPendingAssignment,
};
