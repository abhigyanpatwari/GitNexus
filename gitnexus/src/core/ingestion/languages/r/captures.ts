import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture } from '../../utils/ast-helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { getRParser, getRScopeQuery } from './query.js';
import { isRNonNamingScopeMatch } from './naming-argument.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

/**
 * Emit R scope captures — a single tree-sitter query run against the R
 * grammar (see `query.ts` for the capture shapes and the rationale for each
 * one). No programmatic enrichment is needed: unlike C/Zig/Rust, R's
 * declarations carry no synthesized arity/parameter metadata, and heritage
 * sites resolve directly by name (no marker encoding, unlike Ruby's
 * `include`/`extend`/`prepend`).
 */
export function emitRScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getRParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getRParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getRScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // The scope query captures every candidate argument of setClass/library/require/
    // source; keep only the one that names the class or import.
    if (isRNonNamingScopeMatch(m.captures)) continue;
    const grouped: Record<string, Capture> = {};
    let hasRealCapture = false;
    let functionNode: SyntaxNode | undefined;
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      hasRealCapture = true;
      if (tag === '@scope.function' && c.node.type === 'function_definition') functionNode = c.node;
    }
    if (!hasRealCapture) continue;
    // The function's own scope names what its formals and loop variables bind, so that a call
    // through one of them stops the lexical walk there instead of reaching a top-level function
    // of the same name.
    if (functionNode !== undefined) {
      const names = rFunctionLexicalNames(functionNode);
      if (names.length > 0) {
        grouped['@scope.lexical-names'] = syntheticCapture(
          '@scope.lexical-names',
          functionNode,
          JSON.stringify(names),
        );
      }
    }
    out.push(grouped);
  }

  return out;
}

/**
 * The names a `function_definition` binds in its own frame without a definition node: all its
 * named formals (`...` is not a name; a default proves nothing about the argument, which may be a
 * function, so a formal with a constant default is a lexical name too) and the variable of every
 * `for` loop in its body, outside any function nested in it (that one binds its own). A name is
 * kept as written, backticks included, which is how a call site spells it. Read from the tree once
 * per function, so the work over a file is linear in its size; the walk is iterative because a
 * body can nest deeply.
 */
export function rFunctionLexicalNames(fn: SyntaxNode): string[] {
  const names = new Set<string>();
  const parameters = fn.childForFieldName('parameters');
  if (parameters !== null) {
    for (let i = 0; i < parameters.namedChildCount; i++) {
      const parameter = parameters.namedChild(i);
      if (parameter?.type !== 'parameter') continue;
      const name = parameter.childForFieldName('name');
      if (name?.type !== 'identifier' || name.text.length === 0) continue;
      names.add(name.text);
    }
  }
  const stack: SyntaxNode[] = [];
  const body = fn.childForFieldName('body');
  if (body !== null) stack.push(body);
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'function_definition') continue;
    if (node.type === 'for_statement') {
      const variable = node.childForFieldName('variable');
      if (variable?.type === 'identifier' && variable.text.length > 0) names.add(variable.text);
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }
  return [...names];
}
