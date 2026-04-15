import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ConstructorBindingScanner,
} from './types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * R type extractor — roxygen2 annotation parsing.
 *
 * R has no static type system, but the roxygen2 documentation convention
 * provides de facto type annotations via comments:
 *
 *   #' @param name Character the user's name
 *   #' @param repo UserRepo the repository
 *   #' @return User
 *   create <- function(name, repo) {
 *     repo$save()
 *   }
 *
 * This extractor parses `#' @param name Type` patterns from comment nodes
 * preceding function definitions and binds parameter names to their types.
 *
 * Resolution tiers:
 * - Tier 0: roxygen2 @param annotations (extractDeclaration pre-populates env)
 * - Tier 1: Constructor inference via `obj <- ClassName$new()` (R6) or `obj <- new("ClassName")` (S4)
 */

/** Regex to extract @param annotations: `#' @param name Type description` */
const ROXYGEN_PARAM_RE = /#'\s*@param\s+(\w+)\s+(\S+)/g;

/** Regex to extract @return annotations: `#' @return Type` */
const ROXYGEN_RETURN_RE = /#'\s*@return\s+(\S+)/;

/**
 * Walk backwards through preceding sibling nodes collecting consecutive
 * roxygen2 comment lines (`#'`). Returns the joined comment block text.
 */
const collectRoxygenBlock = (node: SyntaxNode): string => {
  const commentTexts: string[] = [];
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment' && sibling.text.startsWith("#'")) {
      commentTexts.unshift(sibling.text);
    } else if (sibling.type === 'comment') {
      // Regular comment (not roxygen2) — skip, don't break
    } else if (sibling.isNamed) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  return commentTexts.join('\n');
};

/**
 * Collect roxygen2 @param annotations from comment nodes preceding a function definition.
 * Returns a map of paramName → typeName.
 */
const collectRoxygenParams = (node: SyntaxNode): Map<string, string> => {
  const params = new Map<string, string>();
  const commentBlock = collectRoxygenBlock(node);

  let match: RegExpExecArray | null;
  ROXYGEN_PARAM_RE.lastIndex = 0;
  while ((match = ROXYGEN_PARAM_RE.exec(commentBlock)) !== null) {
    const paramName = match[1];
    const typeName = match[2];
    // Only accept types that start with uppercase (class/type names)
    if (/^[A-Z]/.test(typeName)) {
      params.set(paramName, typeName);
    }
  }

  return params;
};

/**
 * R node types that may carry type bindings.
 * - `binary_operator`: function definitions use `name <- function(...)` which
 *   tree-sitter-r parses as binary_operator nodes. Also used for constructor
 *   assignments like `obj <- ClassName$new()`.
 */
const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set(['binary_operator']);

/**
 * Extract roxygen2 annotations from function definitions.
 * Pre-populates the scope env with parameter types before the
 * standard parameter walk (which won't find types since R has none).
 */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type !== 'binary_operator') return;
  const rhs = node.childForFieldName('rhs');
  if (!rhs || rhs.type !== 'function_definition') return;

  const roxygenParams = collectRoxygenParams(node);
  for (const [paramName, typeName] of roxygenParams) {
    env.set(paramName, typeName);
  }
};

/**
 * R parameter extraction.
 * R parameters have no inline type annotations. Roxygen2 types are
 * already populated by extractDeclaration, so this is a no-op — the
 * bindings are already in the env.
 *
 * We still register this to maintain the LanguageTypeConfig contract.
 */
const extractParameter: ParameterExtractor = (
  _node: SyntaxNode,
  _env: Map<string, string>,
): void => {
  // R parameters have no type annotations.
  // Roxygen2 types are pre-populated by extractDeclaration.
};

/**
 * R constructor inference:
 * - R6: `obj <- ClassName$new(...)` → type is ClassName
 * - S4: `obj <- new("ClassName", ...)` → type is ClassName
 *
 * Resolves against locally-known class names.
 */
const extractInitializer: InitializerExtractor = (node, env, classNames): void => {
  const result = scanConstructorBinding(node);
  if (!result) return;
  if (env.has(result.varName)) return;
  if (classNames.has(result.calleeName)) {
    env.set(result.varName, result.calleeName);
  }
};

/**
 * R constructor binding scanner: captures both R6 `obj <- ClassName$new()`
 * and S4 `obj <- new("ClassName", ...)` patterns.
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'binary_operator') return undefined;
  const lhs = node.childForFieldName('lhs');
  const rhs = node.childForFieldName('rhs');
  if (!lhs || !rhs) return undefined;
  if (lhs.type !== 'identifier') return undefined;
  if (rhs.type !== 'call') return undefined;

  const fn = rhs.childForFieldName('function');
  if (!fn) return undefined;

  // R6 pattern: obj <- ClassName$new(...)
  // tree-sitter-r parses `ClassName$new` as an `extract_operator` node
  if (fn.type === 'extract_operator') {
    const children = fn.namedChildren;
    if (children.length >= 2) {
      const className = children[0];
      const method = children[1];
      if (className?.type === 'identifier' && method?.text === 'new') {
        return { varName: lhs.text, calleeName: className.text };
      }
    }
  }

  // S4 pattern: obj <- new("ClassName", ...)
  if (fn.type === 'identifier' && fn.text === 'new') {
    const args = rhs.childForFieldName('arguments');
    if (args) {
      for (const child of args.children) {
        if (child.type === 'argument') {
          const val = child.childForFieldName('value');
          if (val?.type === 'string') {
            const content = val.children.find((c: SyntaxNode) => c.type === 'string_content');
            if (content) {
              return { varName: lhs.text, calleeName: content.text };
            }
          }
          break;
        }
      }
    }
  }

  return undefined;
};

/**
 * Extract return type from roxygen2 `#' @return Type` annotation preceding
 * a function definition. Walks backwards through preceding sibling comment nodes.
 */
export const extractReturnType = (node: SyntaxNode): string | undefined => {
  const commentBlock = collectRoxygenBlock(node);
  const match = ROXYGEN_RETURN_RE.exec(commentBlock);
  if (match) {
    const typeName = match[1];
    if (/^[A-Z]/.test(typeName)) return typeName;
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
};
