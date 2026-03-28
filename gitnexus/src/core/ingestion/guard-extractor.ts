/**
 * Guard Clause & Guarded Call Extraction
 *
 * Extracts two things from function bodies:
 * 1. Guard clauses: early-return if-statements with status codes (e.g., if (!session) return 401)
 * 2. Guarded calls: function calls wrapped in if/switch conditions (e.g., if (status === 'x') doThing())
 *
 * Uses tree-sitter AST for accurate extraction. Falls back gracefully for unsupported languages.
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import PHP from 'tree-sitter-php';

export interface GuardClause {
  /** The condition text (e.g., "!session", "!org") */
  condition: string;
  /** HTTP status code if detectable (401, 403, 404, etc.) */
  returnStatus?: number;
  /** Line number of the if-statement */
  line: number;
  /** Enclosing function name */
  functionName?: string;
  /** For throw/raise guards: the exception class name (e.g., "PermissionDenied", "UnauthorizedException") */
  throwType?: string;
  /** Confidence: 1.0 = has status code or throw type, 0.7 = negation guard in route handler, 0.3 = other early return */
  confidence: number;
}

export interface GuardedCall {
  /** Name of the called function */
  calledName: string;
  /** The condition text wrapping this call */
  guard: string;
  /** Line number of the call */
  line: number;
  /** Enclosing function name */
  functionName?: string;
}

const LANGUAGE_MAP: Record<string, any> = {
  typescript: TypeScript.typescript,
  javascript: JavaScript,
  python: Python,
  php: (PHP as any).php_only ?? PHP,
};

const STATUS_PATTERN = /status[:\s]*(\d{3})/;

/** Tree-sitter node types that represent throw/raise exits across languages */
const THROW_TYPES = new Set([
  'throw_statement',   // JS/TS, Java, C#, Kotlin
  'throw_expression',  // PHP, Kotlin
  'raise_statement',   // Python
]);

/**
 * Extract the exception class name from a throw/raise node.
 * e.g., `throw new UnauthorizedException()` → "UnauthorizedException"
 *       `raise PermissionDenied()` → "PermissionDenied"
 */
function extractThrowType(node: Parser.SyntaxNode): string | undefined {
  const text = node.text;
  // Match: throw new ClassName(...) or raise ClassName(...)
  const match = text.match(/(?:throw\s+new\s+|throw\s+|raise\s+)(\w+)/);
  return match?.[1];
}

/**
 * Extract both guard clauses and guarded calls in a single parse pass.
 * Parses the file once and walks function bodies once for both extractions.
 */
export function extractGuards(content: string, language: string): { clauses: GuardClause[]; calls: GuardedCall[] } {
  const lang = LANGUAGE_MAP[language];
  if (!lang) return { clauses: [], calls: [] };

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(content);

  const clauses: GuardClause[] = [];
  const calls: GuardedCall[] = [];

  walkFunctionBodies(tree.rootNode, language, (bodyNode, funcName) => {
    // Resolve the actual statement list — if the body is a single try-catch,
    // look inside the try block for guards (common Next.js route handler pattern)
    let stmtSource = bodyNode;
    if (bodyNode.namedChildren.length <= 2) {
      const tryStmt = bodyNode.namedChildren.find((c: any) => c.type === 'try_statement');
      if (tryStmt) {
        const tryBody = tryStmt.childForFieldName('body');
        if (tryBody) stmtSource = tryBody;
      }
    }

    for (const child of stmtSource.namedChildren) {
      if (child.type !== 'if_statement') {
        // Allow variable declarations between guards (e.g., const session = await getSession())
        // Python uses 'expression_statement' for assignments and 'assignment' for var = ...
        if (child.type === 'lexical_declaration' || child.type === 'variable_declaration' ||
            child.type === 'expression_statement' || child.type === 'assignment') {
          continue;
        }
        // Any other statement type means we've passed the guard region
        break;
      }

      const condNode = child.childForFieldName('condition');
      const consBlock = child.childForFieldName('consequence');
      if (!condNode || !consBlock) continue;

      const condText = condNode.text.replace(/^\(/, '').replace(/\)$/, '').trim();

      // Check if the consequent block contains a return statement or throw/raise (guard clause)
      const hasReturn = findDescendantOfType(consBlock, 'return_statement');
      const hasThrow = findDescendantOfAnyType(consBlock, THROW_TYPES);
      if (hasReturn || hasThrow) {
        let returnStatus: number | undefined;
        let throwType: string | undefined;
        if (hasReturn) {
          const statusMatch = hasReturn.text.match(STATUS_PATTERN);
          if (statusMatch) {
            returnStatus = parseInt(statusMatch[1], 10);
          }
        }
        if (hasThrow) {
          throwType = extractThrowType(hasThrow);
          // Also try to extract status from throw text (e.g., throw new HttpException(..., 401))
          if (!returnStatus) {
            const statusMatch = hasThrow.text.match(STATUS_PATTERN);
            if (statusMatch) {
              returnStatus = parseInt(statusMatch[1], 10);
            }
          }
        }
        // Compute confidence based on evidence strength
        let confidence = 0.3; // default: early return without clear signal
        if (returnStatus || throwType) {
          confidence = 1.0; // has HTTP status code or exception type — definitely a guard
        } else if (condText.startsWith('!') || condText.startsWith('not ')) {
          confidence = 0.7; // negation pattern (e.g., !session, !org) — likely a guard
        }

        clauses.push({
          condition: condText,
          returnStatus,
          confidence,
          line: child.startPosition.row + 1,
          functionName: funcName,
          ...(throwType && { throwType }),
        });
      } else {
        // Not a guard clause — stop scanning for guards but still check guarded calls below
        break;
      }
    }

    // Second pass for guarded calls — scans all if-statements (not just early-return guards)
    for (const child of stmtSource.namedChildren) {
      if (child.type !== 'if_statement') continue;
      const condNode = child.childForFieldName('condition');
      const consBlock = child.childForFieldName('consequence');
      if (!condNode || !consBlock) continue;

      const condText = condNode.text.replace(/^\(/, '').replace(/\)$/, '').trim();

      const callNodes = findAllDescendantsOfType(consBlock, 'call_expression');
      for (const call of callNodes) {
        const funcNode = call.childForFieldName('function');
        if (!funcNode) continue;
        const calledName = funcNode.type === 'member_expression'
          ? funcNode.childForFieldName('property')?.text ?? funcNode.text
          : funcNode.text;

        // Skip common non-interesting calls (console.log, NextResponse.json, etc.)
        if (calledName === 'json' || calledName === 'log' || calledName === 'error') continue;

        calls.push({
          calledName,
          guard: condText,
          line: call.startPosition.row + 1,
          functionName: funcName,
        });
      }
    }
  });

  return { clauses, calls };
}

/**
 * Extract guard clauses (early-return if-statements) from file content.
 * Convenience wrapper around extractGuards for callers that only need clauses.
 */
export function extractGuardClauses(content: string, language: string): GuardClause[] {
  return extractGuards(content, language).clauses;
}

/**
 * Extract guarded calls — function calls that are wrapped in if/switch conditions.
 * Convenience wrapper around extractGuards for callers that only need calls.
 */
export function extractGuardedCalls(content: string, language: string): GuardedCall[] {
  return extractGuards(content, language).calls;
}

// ── Helpers ──

function walkFunctionBodies(
  node: Parser.SyntaxNode,
  language: string,
  callback: (body: Parser.SyntaxNode, funcName?: string) => void,
): void {
  const funcTypes = new Set([
    'function_declaration', 'method_definition', 'arrow_function',
    'function_definition', 'method_declaration',
  ]);

  // Python uses 'block' instead of 'statement_block'
  const bodyTypes = language === 'python'
    ? new Set(['block', 'statement_block'])
    : new Set(['statement_block']);

  function walk(n: Parser.SyntaxNode): void {
    if (funcTypes.has(n.type)) {
      // Skip arrow functions that are callback arguments (e.g., .sort((a,b) => ...),
      // .reduce((acc, x) => ...), .then((res) => ...)). These are not route handlers
      // and their early-returns are not HTTP guard clauses.
      if (n.type === 'arrow_function' && n.parent) {
        const parentType = n.parent.type;
        // If the arrow is inside an arguments list or is a direct argument to a call, skip it
        if (parentType === 'arguments' || parentType === 'call_expression' ||
            parentType === 'member_expression') {
          // Still walk children to find nested named functions
          for (const child of n.namedChildren) walk(child);
          return;
        }
      }

      const body = n.childForFieldName('body');
      const nameNode = n.childForFieldName('name');
      const funcName = nameNode?.text;
      if (body && bodyTypes.has(body.type)) {
        callback(body, funcName);
      }
    }
    for (const child of n.namedChildren) {
      walk(child);
    }
  }

  walk(node);
}

function findDescendantOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findDescendantOfType(child, type);
    if (found) return found;
  }
  return null;
}

function findDescendantOfAnyType(node: Parser.SyntaxNode, types: Set<string>): Parser.SyntaxNode | null {
  if (types.has(node.type)) return node;
  for (const child of node.namedChildren) {
    const found = findDescendantOfAnyType(child, types);
    if (found) return found;
  }
  return null;
}

function findAllDescendantsOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  function walk(n: Parser.SyntaxNode) {
    if (n.type === type) results.push(n);
    for (const child of n.namedChildren) walk(child);
  }
  walk(node);
  return results;
}
